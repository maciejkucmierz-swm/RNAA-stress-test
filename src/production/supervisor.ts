import type { StressOptions } from "../stress/catalog";
import { inlineSettings } from "../stress/feature-load";
import { StressBudgetError, type StressProbe } from "../stress/runner";
import { redact } from "../workshop/history";
import { companionFor, defaults, features } from "../workshop/registry";
import { SessionScope } from "../workshop/session";
import {
  availability,
  BlockedError,
  CancelledError,
  type Outcome,
  type Settings,
} from "../workshop/types";
import {
  applicableScenarios,
  pressureProfile,
  scenario,
  scenarioContract,
  type FaultCapabilities,
  type NativeSnapshot,
  type ProductionCommand,
  type ScenarioEvidence,
  type Stage,
} from "./catalog";
import { environmentProfile } from "./environment";
import { initialIntent, reduceIntent, type AudioIntent } from "./intent";
export interface ProductionDriver {
  capabilities(): FaultCapabilities;
  platform: string;
  channel: "stable";
  beginRun(id: string): void;
  endRun(): Promise<void>;
  pressure(profile: ReturnType<typeof pressureProfile>): Promise<void>;
  stopPressure(): Promise<void>;
  renewPressure(): void;
  stallJavaScript(ms: number): void;
  nativeSnapshot(): NativeSnapshot | null;
  observeFaults(
    root: SessionScope,
    listener: (error: unknown) => void,
  ): () => void;
  run(
    id: string,
    action: string,
    settings: Settings,
    scope: SessionScope,
    emit: (name: string, value?: unknown) => void,
  ): Promise<Outcome>;
  idle(): Promise<void>;
  state(): Record<string, unknown>;
  applyIntent(
    intent: AudioIntent,
    recording: boolean,
    id: string,
    scope: SessionScope,
  ): Promise<void>;
  verifyFiles(
    paths: string[],
  ): Promise<{ frames: number; seconds: number; bytes: number }>;
  fileBytes(paths: string[]): number;
}
export class ProductionSupervisor {
  private commands: { command: ProductionCommand; value?: number | boolean }[] =
    [];
  private input:
    | ((name: string, value: unknown, source: string) => void)
    | null = null;
  signal(command: ProductionCommand, value?: number | boolean) {
    if (!this.input) return;
    if (command === "stop-audio")
      this.commands = this.commands.filter(
        (item) => item.command !== "resume" && item.command !== "new-session",
      );
    this.commands.push({ command, value });
  }
  observe(name: string, value: unknown, source = "app") {
    this.input?.(name, value, source);
  }
  async run(
    options: StressOptions,
    root: SessionScope,
    probe: StressProbe,
    driver: ProductionDriver,
  ) {
    const definition = scenario(options.scenarioId ?? "");
    const target = features.find(
      (feature) => feature.id === options.targetFeatureId,
    );
    if (
      !target ||
      !applicableScenarios(target).some((item) => item.id === definition.id)
    )
      throw new BlockedError(
        "This scenario does not apply to the selected feature.",
      );
    const reason = availability(target, driver.platform);
    if (reason) throw new BlockedError(reason);
    const caps = driver.capabilities(),
      profile = environmentProfile(
        options.level!,
        caps.cores,
        options.environmentProfile,
      );
    if (
      (profile.workers > 0 || definition.id === "service-reset") &&
      !caps.available
    )
      throw new BlockedError(
        caps.reason ?? "Native helper required. Rebuild the app.",
      );
    if (profile.workers && !caps.pressure)
      throw new BlockedError(
        "Native pressure and thermal guards are unavailable on this target.",
      );
    if (definition.id === "service-reset" && !caps.realServiceReset)
      throw new BlockedError(
        "Real audio-service reset unavailable on this target. Use a physical iPhone with Developer Settings or run Android host root preflight. Closing a context is not a real reset.",
      );
    if (definition.id === "notification-stop" && driver.platform !== "android")
      throw new BlockedError("Recording notification Stop is Android-only.");
    if (definition.id === "combined" && !profile.workers)
      throw new BlockedError(
        "Combined failure requires a native-load environment or level 6–10.",
      );
    const isSystem = target.workload.mode === "system";
    const recording =
      target.workload.capture !== "none" ||
      (isSystem && companionFor(target, options.companion) === "recording");
    // A notification Stop must have a file to finalize, including when launched beside PCM/graph capture.
    const companionNeeded = isSystem || definition.id === "notification-stop";
    const feature = companionNeeded
      ? features.find(
          (item) =>
            item.id === (recording ? "record-combined" : "buffer-source"),
        )!
      : target;
    const dataOnly = feature.workload.mode === "data";
    const settings = inlineSettings(
      feature,
      {
        ...defaults(feature),
        ...(!companionNeeded ? options.targetSettings : {}),
        loop: true,
        stopAfter: 0,
        monitor: false,
        productionProbe: true,
        productionPreserveSession: target.id === "session",
      } as Settings,
      options,
    );
    const fileOutput =
      recording && !["samples", "graph"].includes(feature.workload.capture);
    if (fileOutput) {
      // Use a conservative PCM estimate even for compressed formats. Account for all rounds and recovery sessions.
      const estimate =
        ((Math.max(48000, Number(settings.recordRate ?? 48000)) *
          Number(settings.channels ?? 2) *
          4 *
          probe.report.limits.runtimeMs) /
          1000) *
        1.1;
      if (
        !Number.isFinite(estimate) ||
        estimate > probe.report.limits.fileBytes
      )
        throw new BlockedError(
          "Recording could exceed the file budget. Reduce rate/channels, use a shorter scenario, or use PCM/graph capture for a long thermal check.",
        );
    }
    let intent = initialIntent(
      recording,
      !!settings.muted,
      Number(settings.volume ?? 0.1),
    );
    const evidence: ScenarioEvidence = {
      id: definition.id,
      stage: "baseline",
      round: 0,
      requestedFaults: 0,
      verifiedFaults: 0,
      contract: scenarioContract(definition.id, target.id, feature.id),
      source:
        definition.id === "stop-pending"
          ? "simulated-app"
          : definition.id === "pressure"
            ? profile.workers
              ? "native-pressure"
              : "simulated-app"
            : "real-os",
      timeline: [],
      nativeSamples: [],
      recovery: [],
      findings: [],
      appState: "active",
      expectedBackground: false,
      userActionRequired: false,
      desired: { ...intent },
      observed: {},
      faultEvents: [],
      clientActions: [],
    };
    probe.report.scenario = evidence;
    probe.metric("clientBaseline", "published-rnaa-client-v1");
    probe.event(
      "clientIntegration",
      "Public RNAA notification and interruption handlers. No engine rebuild, retry, dependency patch, or fallback.",
    );
    probe.event("effectiveProductionWorkload", {
      feature: feature.id,
      settings: redact(settings),
      profile,
    });
    probe.metric("environmentProfile", options.environmentProfile ?? "level");
    probe.metric("requestedCpuDuty", profile.duty);
    probe.metric(
      "cpuMeasurement",
      "Process CPU time includes audio and harness work; configured worker duty is not achieved CPU utilization.",
    );
    probe.metric("requestedNativeWorkers", profile.workers);
    probe.metric("requestedRamMiB", profile.memoryMiB);
    probe.metric("requestedJsPauseMs", profile.jsStallMs);
    probe.metric("requestedCommandDelayMaxMs", profile.commandLatencyMs);
    this.commands = [];
    let child: SessionScope | null = null,
      lastNativeSequence = 0,
      ended = false,
      resumePressed = false,
      newSessionPressed = false,
      finished = false;
    let callbacks = 0,
      finalizations = 0,
      roundFinalizations = 0,
      latestActivity = 0,
      recentFreshActivity = 0,
      nativeResetConfirmed = false;
    let interruptionBegan = false,
      interruptionEnded = false,
      systemVolumeChanges = 0,
      userVolumeChanges = 0,
      routeChanges = 0,
      backgroundChanges = 0;
    let latestRenewal = 0,
      nativePoll = 0,
      queueFeed = 0,
      policyPending = false,
      nextJsStall = 0;
    let jsStalls = 0,
      commandDelays = 0,
      roundStalls = 0,
      roundDelays = 0,
      clientInterventions = 0;
    const latency = async (owner: SessionScope, action: string) => {
      if (!profile.commandLatencyMs) return;
      const requestedMs = Math.round(
        250 + probe.random() * (profile.commandLatencyMs - 250),
      );
      probe.event("appLatencyRequested", {
        action,
        requestedMs,
        source: "simulated-app",
      });
      // This delay is cancellable harness work, not an uncancellable native operation.
      const start = Date.now();
      await probe.wait(requestedMs);
      owner.ensureActive();
      commandDelays++;
      roundDelays++;
      probe.metric("appCommandDelays", commandDelays);
      probe.event("appLatencyCompleted", {
        action,
        requestedMs,
        actualMs: Date.now() - start,
      });
    };
    const verifiedRounds = new Set<number>();
    const files = new Set<string>(),
      faultErrors: { error: string; stage: Stage; round: number }[] = [];
    const stage = (next: Stage, detail: string) => {
      evidence.stage = next;
      evidence.timeline.push({
        stage: next,
        at: new Date().toISOString(),
        detail,
      });
      if (evidence.timeline.length > 100) evidence.timeline.shift();
      probe.tick(`${next}: ${detail}`);
    };
    const finding = (message: string) => {
      evidence.findings.push(message);
      probe.check("Production finding", false, message);
    };
    const capture = (name: string, value: unknown, source: string) => {
      if (!root.alive) {
        if (name === "fileInfo")
          for (const path of (value as { paths?: string[] })?.paths ?? [])
            files.add(path);
        return;
      }
      probe.event(name, {
        source,
        value,
        round: evidence.round,
        stage: evidence.stage,
      });
      if (
        [
          "interruption",
          "appState",
          "routeChange",
          "mediaServicesLost",
          "mediaServicesReset",
          "captureConfiguration",
        ].includes(name) ||
        /^(recording|playback)Notification/.test(name)
      ) {
        evidence.faultEvents!.push({
          at: new Date().toISOString(),
          name,
          value,
          source,
          round: evidence.round,
          stage: evidence.stage,
        });
        if (evidence.faultEvents!.length > 64) evidence.faultEvents!.shift();
      }
      if (name === "audioReady") {
        const sample = value as { numFrames?: number; rms?: number };
        if (!(Number(sample?.numFrames) > 0) || !Number.isFinite(sample?.rms))
          finding(
            "Microphone callback contains invalid frame or sample metrics.",
          );
      }
      if (
        name === "metadata" &&
        (value as { source?: string })?.source === "decoded-fallback"
      )
        finding(
          "Native duration metadata was unavailable; decoding fallback does not repair the metadata failure.",
        );
      if (name === "appState") {
        evidence.appState = String(value);
        evidence.expectedBackground = value !== "active";
        if (value === "background") backgroundChanges++;
      }
      if (
        name === "captureConfiguration" &&
        recording &&
        Array.isArray(value) &&
        value.some((item) => item.silenced === true)
      ) {
        interruptionBegan = true;
        evidence.observed.beforeCaptureLoss = driver.state();
        intent = reduceIntent(intent, "interrupt");
        policyPending = true;
      }
      if (name === "routeChange") {
        const reason = (value as { reason?: unknown })?.reason ?? value;
        if (
          [
            "added",
            "removed",
            "NewDeviceAvailable",
            "OldDeviceUnavailable",
            "NoSuitableRouteForCategory",
            1,
            2,
            8,
          ].includes(reason as string | number)
        )
          routeChanges++;
      }
      if (name === "systemVolume" || name === "volumeChange")
        systemVolumeChanges++;
      if (name === "mediaServicesLost" || name === "mediaServicesReset") {
        nativeResetConfirmed ||= name === "mediaServicesReset";
        evidence.observed.beforeResetPolicy = driver.state();
        intent = reduceIntent(intent, "reset");
        evidence.userActionRequired = true;
        policyPending = true;
      }
      if (name === "interruption") {
        const event = value as { type?: string; shouldResume?: boolean };
        if (event.type === "began") {
          evidence.observed.beforeInterruptionPolicy = driver.state();
          policyPending = true;
          interruptionBegan = true;
          intent = reduceIntent(intent, "interrupt");
        }
        if (event.type === "ended") {
          interruptionEnded = true;
          // A focus gain can arrive without a pending loss. The documented
          // handler does nothing on an unrelated ended/shouldResume=false event.
          if (intent.interrupted || event.shouldResume) {
            evidence.observed.beforeInterruptionPolicy = driver.state();
            policyPending = true;
            intent = reduceIntent(
              intent,
              event.shouldResume ? "temporary-end" : "permanent-loss",
              !!event.shouldResume,
            );
          }
        }
      }
      if (
        name === "recordingNotificationStop" ||
        name === "playbackNotificationStop"
      ) {
        intent = reduceIntent(intent, "stop");
        evidence.observed.notificationStop = true;
      }
      if (
        name === "audioReady" ||
        name === "worklet" ||
        name === "position" ||
        name === "onPositionChanged"
      ) {
        callbacks++;
        latestActivity = Date.now();
      }
      if (name === "fileInfo") {
        finalizations++;
        for (const path of (value as { paths?: string[] })?.paths ?? [])
          files.add(path);
      }
      evidence.desired = { ...intent };
    };
    this.input = capture;
    const unregister = driver.observeFaults(root, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      faultErrors.push({
        error: message,
        stage: evidence.stage,
        round: evidence.round,
      });
      probe.event("nativeAudioFault", {
        error: message,
        stage: evidence.stage,
        originalState: driver.state(),
      });
    });
    root.defer(unregister);
    if (caps.available) driver.beginRun(probe.report.id);
    root.defer(() => driver.endRun());
    const poll = async () => {
      probe.tick();
      if (
        evidence.stage === "disruption" &&
        profile.jsStallMs &&
        Date.now() >= nextJsStall
      ) {
        probe.event("jsStallRequested", {
          ms: profile.jsStallMs,
          source: "simulated-app",
        });
        const start = Date.now();
        driver.stallJavaScript(profile.jsStallMs);
        probe.event("jsStallCompleted", Date.now() - start);
        nextJsStall = Date.now() + profile.jsStallEveryMs;
        if (Date.now() - start >= profile.jsStallMs) {
          jsStalls++;
          roundStalls++;
          probe.metric("jsStalls", jsStalls);
        }
        root.ensureActive();
      }
      if (Date.now() - nativePoll >= 1000 && caps.available) {
        const bytes = driver.fileBytes([...files]);
        probe.metric("finalizedFileBytes", bytes);
        if (bytes > probe.report.limits.fileBytes)
          throw new StressBudgetError(
            "Recording file ceiling reached. Workload incomplete.",
          );
        nativePoll = Date.now();
        const sample = driver.nativeSnapshot();
        if (sample?.runId === probe.report.id) {
          const fresh = sample.events.filter(
            (event) => event.sequence > lastNativeSequence,
          );
          for (const event of fresh) {
            lastNativeSequence = event.sequence;
            capture(event.name, event.value, "native");
          }
          evidence.nativeSamples.push({ ...sample, events: [] });
          if (evidence.nativeSamples.length > 300)
            evidence.nativeSamples.shift();
          evidence.observed.native = sample;
          if (sample.guardReason)
            throw new StressBudgetError(
              `Native pressure guard: ${sample.guardReason}. Workload incomplete.`,
            );
          const hostReset = (
            sample as NativeSnapshot & {
              hostServiceReset?: { verified?: boolean };
            }
          ).hostServiceReset;
          if (hostReset?.verified && !nativeResetConfirmed)
            capture("mediaServicesReset", hostReset, "host-native-pid");
        }
        if (profile.workers && Date.now() - latestRenewal > 60000) {
          driver.renewPressure();
          latestRenewal = Date.now();
        }
      }
      if (policyPending && child?.alive) {
        policyPending = false;
        clientInterventions++;
        evidence.clientActions!.push({
          at: new Date().toISOString(),
          round: evidence.round,
          action:
            "documented interruption handler: existing public pause/resume",
          before: driver.state(),
          intent: { ...intent },
        });
        if (evidence.clientActions!.length > 64)
          evidence.clientActions!.shift();
        probe.event("documentedClientHandler", {
          intent,
          originalState: driver.state(),
          calls:
            "Existing recorder pause/resume or existing context suspend/resume; no rebuilding.",
        });
        try {
          await latency(child, "interruption recovery");
          await child.hold(
            driver.applyIntent(intent, recording, feature.id, child),
          );
        } catch (error) {
          faultErrors.push({
            error: String(error),
            stage: evidence.stage,
            round: evidence.round,
          });
        }
      }
      if (
        feature.id === "queue" &&
        child?.alive &&
        intent.playing &&
        !intent.needsUser &&
        Date.now() - queueFeed > 2000
      ) {
        queueFeed = Date.now();
        await child.hold(
          driver.run("queue", "enqueue", settings, child, (name, value) =>
            capture(name, value, "rnaa"),
          ),
        );
      }
      while (this.commands.length) {
        const item = this.commands.shift()!;
        probe.event("operatorCommand", item);
        if (item.command === "end-disruption") ended = true;
        if (item.command === "finish") finished = true;
        if (item.command === "resume" && evidence.stage === "recovery") {
          intent = reduceIntent(intent, "resume");
          resumePressed = true;
        }
        if (item.command === "new-session" && evidence.stage === "recovery") {
          intent = reduceIntent(intent, "resume");
          newSessionPressed = true;
        }
        if (item.command === "stop-audio") {
          resumePressed = false;
          newSessionPressed = false;
          intent = reduceIntent(intent, "stop");
          await stopChild();
        }
        if (item.command === "mute" || item.command === "gain") {
          intent = reduceIntent(intent, item.command, item.value);
          userVolumeChanges++;
          if (child?.alive) {
            probe.event("appPolicyIntervention", {
              action: "set-user-volume",
              intent,
            });
            await child.hold(
              driver.applyIntent(intent, recording, feature.id, child),
            );
          }
        }
      }
      evidence.desired = { ...intent };
      evidence.userActionRequired =
        evidence.stage === "recovery" && intent.needsUser;
    };
    const wait = async (ms: number, until?: () => boolean) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await poll();
        if (until?.()) return;
        await probe.wait(Math.min(100, end - Date.now()));
      }
      await poll();
    };
    async function stopChild() {
      if (child) {
        const old = child;
        child = null;
        await old.dispose();
      }
    }
    const startChild = async () => {
      await stopChild();
      root.ensureActive();
      const current = new SessionScope(feature.id, root);
      child = current;
      current.defer(() => driver.idle());
      const generation = intent.generation;
      recentFreshActivity = callbacks;
      try {
        if (target.id === "session")
          await current.hold(
            driver.run(
              "session",
              "apply",
              options.targetSettings ?? defaults(target),
              current,
              (name, value) => capture(name, value, "rnaa"),
            ),
          );
        await probe.operation("start selected feature", async () => {
          await latency(current, "start audio");
          current.ensureActive();
          const outcome = await current.hold(
            driver.run(
              feature.id,
              dataOnly ? feature.actions[0].id : "start",
              {
                ...settings,
                scenarioGain: intent.gain,
                volume: intent.gain,
                muted: intent.muted,
              },
              current,
              (name, value) => {
                if (current.alive || name === "fileInfo")
                  capture(name, value, "rnaa");
              },
            ),
          );
          if (outcome.status === "failed") throw new Error(outcome.summary);
          if (outcome.status === "blocked" || outcome.status === "unavailable")
            throw new BlockedError(outcome.summary);
          for (const assertion of outcome.assertions ?? [])
            probe.check(
              assertion.name,
              assertion.passed,
              assertion.detail ?? outcome.summary,
            );
          if (generation !== intent.generation)
            throw new CancelledError("Start superseded by user Stop.");
        });
        current.ensureActive();
        if (!dataOnly)
          await driver.run(
            "system-events",
            "observe",
            { focus: "gain" },
            current,
            (name, value) => capture(name, value, "rnaa-os"),
          );
        if (driver.platform === "android" && recording)
          await current.hold(
            driver.run(
              "recording-notification",
              "show",
              {
                ...options.targetSettings,
                title: "Production recording",
                contentText: "Use real Stop",
                showStopAction: true,
              },
              current,
              (name, value) => capture(name, value, "rnaa-os"),
            ),
          );
        if (target.id === "playback-notification") {
          await current.hold(
            driver.run(
              "playback-notification",
              "show",
              { ...defaults(target), ...options.targetSettings },
              current,
              (name, value) => capture(name, value, "rnaa-os"),
            ),
          );
          for (const control of ["play", "pause", "stop"]) {
            current.ensureActive();
            await current.hold(
              driver.run(
                "playback-notification",
                "control",
                { control, enabled: true },
                current,
                (name, value) => capture(name, value, "rnaa-os"),
              ),
            );
          }
        }
        if (
          ["devices", "volume", "record-recovery", "background"].includes(
            target.id,
          )
        )
          await current.hold(
            driver.run(
              target.id,
              "inspect",
              options.targetSettings ?? defaults(target),
              current,
              (name, value) => capture(name, value, "rnaa-os"),
            ),
          );
      } catch (error) {
        if (!(error instanceof CancelledError && !current.alive)) throw error;
      }
    };
    try {
      for (let round = 1; round <= profile.rounds; round++) {
        roundFinalizations = finalizations;
        evidence.round = round;
        ended = false;
        resumePressed = false;
        newSessionPressed = false;
        finished = false;
        roundStalls = 0;
        roundDelays = 0;
        clientInterventions = 0;
        interruptionBegan = false;
        interruptionEnded = false;
        routeChanges = 0;
        backgroundChanges = 0;
        userVolumeChanges = 0;
        systemVolumeChanges = 0;
        evidence.observed.notificationStop = false;
        intent = {
          ...initialIntent(recording, intent.muted, intent.gain),
          generation: intent.generation + 1,
        };
        const baselineBefore = callbacks;
        stage(
          "baseline",
          `Round ${round}/${profile.rounds}. Listen or speak a numbered marker.`,
        );
        await startChild();
        await wait(dataOnly ? 10 : 5000);
        const hadBaselineProgress = callbacks > baselineBefore;
        evidence.observed.baseline = driver.state();
        // Setup can change the session category/route. It is evidence, but never a requested disruption.
        interruptionBegan = false;
        interruptionEnded = false;
        routeChanges = 0;
        backgroundChanges = 0;
        userVolumeChanges = 0;
        systemVolumeChanges = 0;
        nativeResetConfirmed = false;
        evidence.observed.notificationStop = false;
        roundFinalizations = finalizations;
        stage("disruption", definition.action);
        evidence.requestedFaults++;
        nextJsStall = Date.now() + 2000;
        if (profile.workers) {
          await root.hold(driver.pressure(profile));
          latestRenewal = Date.now();
          await wait(1100);
        }
        if (definition.id === "stop-pending") {
          await stopChild();
          let settled = false;
          const pending = startChild().finally(() => {
            settled = true;
          });
          await Promise.resolve();
          const pendingAtStop = !settled;
          intent = reduceIntent(intent, "stop");
          await stopChild();
          await pending;
          if (pendingAtStop) evidence.verifiedFaults++;
          else
            probe.unverified(
              "Pending stop injection",
              "The start already settled; this run did not verify an overlapping stop.",
            );
          probe.check(
            "User Stop retained",
            !intent.playing,
            "No automatic restart is allowed after Stop.",
          );
        } else if (definition.id === "pressure") {
          if (
            !profile.workers &&
            !profile.jsStallMs &&
            !profile.commandLatencyMs
          ) {
            probe.unverified(
              "Phone pressure not injected",
              "Levels 1–5 have no added phone pressure. Choose level 6 or higher for a measured pressure scenario.",
            );
          }
          const holdMs =
            options.scenarioDuration === "thermal-15" ? 900000 : 60000;
          await wait(holdMs, () => finished);
          const pressureSamples = evidence.nativeSamples.filter(
            (sample) =>
              sample.pressureActive &&
              sample.workerBusyMs > 0 &&
              sample.workers === profile.workers &&
              sample.duty >= profile.duty - 0.01 &&
              (profile.memoryMiB === 0 || sample.allocatedBytes > 0),
          );
          if (
            (!profile.workers || pressureSamples.length > 0) &&
            (!profile.jsStallMs || roundStalls > 0) &&
            (!profile.commandLatencyMs || roundDelays > 0) &&
            (profile.workers || profile.jsStallMs || profile.commandLatencyMs)
          )
            evidence.verifiedFaults++;
        } else {
          await wait(Math.max(10000, 180000 / profile.rounds), () => ended);
          const verified =
            definition.id === "interruption"
              ? interruptionBegan
              : definition.id === "notification-stop"
                ? evidence.observed.notificationStop === true &&
                  (interruptionBegan || backgroundChanges > 0)
                : definition.id === "volume"
                  ? userVolumeChanges > 0 &&
                    systemVolumeChanges > 0 &&
                    interruptionBegan
                  : definition.id === "routes-background"
                    ? routeChanges > 0 && backgroundChanges > 0
                    : definition.id === "background-only"
                      ? backgroundChanges > 0 && evidence.appState === "active"
                      : definition.id === "service-reset"
                        ? nativeResetConfirmed
                        : backgroundChanges > 0 &&
                          (interruptionBegan || routeChanges > 0) &&
                          !intent.playing &&
                          profile.workers > 0 &&
                          evidence.nativeSamples.some(
                            (sample) => sample.workerBusyMs > 0,
                          );
          if (verified) evidence.verifiedFaults++;
          else
            probe.unverified(
              "Required disruption evidence missing",
              "Operator completion alone does not verify an OS interruption, route change, real Stop, or service reset.",
            );
        }
        if (evidence.verifiedFaults > verifiedRounds.size)
          verifiedRounds.add(round);
        if (profile.jsStallMs && !roundStalls)
          probe.unverified(
            "Requested JavaScript pause",
            "No completed pause of the requested length was observed in this round.",
          );
        if (profile.commandLatencyMs && !roundDelays)
          probe.unverified(
            "Requested app latency",
            "No delayed audio command completed in this round.",
          );
        await driver.stopPressure();
        const stoppedPressure = driver.nativeSnapshot();
        if (profile.workers && stoppedPressure?.runId === probe.report.id) {
          evidence.nativeSamples.push({ ...stoppedPressure, events: [] });
          probe.check(
            "Native pressure released",
            !stoppedPressure.pressureActive &&
              stoppedPressure.allocatedBytes === 0,
            "Workers and owned pressure memory must stop before recovery.",
          );
        }
        if (
          profile.memoryMiB &&
          !evidence.nativeSamples.some((sample) => sample.allocatedBytes > 0)
        )
          probe.unverified(
            "Memory pressure unavailable",
            "The native helper could not verify a positive bounded allocation on this target. CPU work alone does not verify the full requested pressure profile.",
          );
        stage(
          "recovery",
          "Record the original session. Resume uses existing public APIs; a new session is a separate result.",
        );
        if (
          definition.id === "notification-stop" &&
          evidence.observed.notificationStop === true
        )
          probe.check(
            "Original recording finalized exactly once",
            finalizations - roundFinalizations === 1,
            `${finalizations - roundFinalizations} finalizations before any later session.`,
          );
        const originalState = driver.state();
        evidence.observed.originalResponse = {
          round,
          state: originalState,
          callbacks,
          finalizations: finalizations - roundFinalizations,
          at: Date.now(),
          clientInterventions,
        };
        probe.event(
          "originalResponseRecorded",
          evidence.observed.originalResponse,
        );
        const canResume =
          !!(child as SessionScope | null)?.alive &&
          evidence.observed.notificationStop !== true &&
          definition.id !== "service-reset";
        evidence.observed.canResumeExisting = canResume;
        evidence.userActionRequired = true;
        if (recording && interruptionBegan)
          intent = { ...intent, needsUser: true, resumeAllowed: false };
        if (interruptionBegan && !interruptionEnded) {
          intent = { ...intent, needsUser: true, resumeAllowed: false };
          probe.unverified(
            "OS condition still active",
            "No interruption-ended permission was observed. The runner will not force recovery or start another session automatically.",
          );
        }
        if (definition.id === "stop-pending") {
          newSessionPressed = true;
          intent = reduceIntent(intent, "resume");
          probe.event(
            "plannedNewSession",
            "A separate new start follows the recorded Stop result; no context/recorder replacement or repair.",
          );
        } else if (
          definition.id === "service-reset" ||
          intent.needsUser ||
          !intent.playing ||
          (recording && interruptionBegan)
        ) {
          evidence.userActionRequired = true;
          await wait(
            Math.max(10000, 60000 / profile.rounds),
            () => resumePressed || newSessionPressed,
          );
          if (!resumePressed && !newSessionPressed) {
            probe.unverified(
              "User action missing",
              "No retry or engine rebuild was attempted. Choose Resume existing audio or Start new session explicitly.",
            );
            continue;
          }
        }
        const recoveryStart = Date.now(),
          before = callbacks;
        if (resumePressed) {
          if (!canResume || !(child as SessionScope | null)?.alive) {
            probe.unverified(
              "Existing session unavailable",
              "Resume cannot recreate a stopped session. Start a separate new session explicitly.",
            );
          } else {
            probe.event("userResumeExisting", {
              originalState: driver.state(),
            });
            await latency(child!, "explicit existing-session resume");
            await child!.hold(
              driver.applyIntent(intent, recording, feature.id, child!),
            );
            const acknowledgedMs = Date.now() - recoveryStart;
            if (acknowledgedMs < 5000)
              await wait(
                5000 - acknowledgedMs,
                () => callbacks > before || dataOnly,
              );
            const observed = callbacks > before || dataOnly;
            evidence.recovery.push({
              round,
              elapsedMs: Date.now() - recoveryStart,
              assisted: true,
              kind: "existing-session-resume",
              observed,
            });
            probe.check(
              "Existing-session Resume acknowledgement",
              acknowledgedMs <= 5000,
              `Public pause/resume API accepted in ${acknowledgedMs} ms; no engine recreation.`,
            );
            if (
              !observed &&
              hadBaselineProgress &&
              (!interruptionBegan || interruptionEnded)
            )
              probe.check(
                "Existing-session progress after Resume",
                false,
                "Progress was available before disruption but did not return within five seconds after public Resume. No repair was attempted.",
              );
            else if (!observed && !dataOnly)
              probe.unverified(
                "Existing-session output",
                "No fresh sample/position evidence after Resume. Review files and sound; no repair was attempted.",
              );
          }
        } else if (
          !newSessionPressed &&
          (child as SessionScope | null)?.alive &&
          intent.playing &&
          !intent.needsUser
        ) {
          await wait(5000, () => callbacks > before);
          const observed = callbacks > before;
          evidence.recovery.push({
            round,
            elapsedMs: Date.now() - recoveryStart,
            assisted: clientInterventions > 0,
            kind:
              clientInterventions > 0
                ? "documented-client-handler"
                : "original-session",
            observed,
          });
          if (
            !observed &&
            hadBaselineProgress &&
            (!interruptionBegan || interruptionEnded)
          )
            probe.check(
              "Original-session progress",
              false,
              "Progress available before disruption did not return within five seconds. No rebuild or retry.",
            );
          else if (!observed)
            probe.unverified(
              "Original-session output",
              "No fresh progress within five seconds. The runner did not rebuild or retry.",
            );
        }
        if (newSessionPressed) {
          const start = Date.now();
          probe.event("newSessionRequested", {
            originalResponse: evidence.observed.originalResponse,
            source:
              definition.id === "stop-pending"
                ? "planned-workload"
                : "explicit-user-action",
          });
          await startChild();
          const acknowledgedMs = Date.now() - start;
          if (acknowledgedMs < 5000)
            await wait(
              5000 - acknowledgedMs,
              () => callbacks > recentFreshActivity || dataOnly,
            );
          const observed = callbacks > recentFreshActivity || dataOnly;
          evidence.recovery.push({
            round,
            elapsedMs: Date.now() - start,
            assisted: true,
            kind: "separate-new-session",
            observed,
          });
          probe.check(
            "Separate new-session acknowledgement",
            acknowledgedMs <= 5000,
            `New start accepted in ${acknowledgedMs} ms using the existing engine/recorder; original outcome stays unchanged.`,
          );
          if (!observed && !dataOnly)
            probe.unverified(
              "Fresh output progress",
              "The new start was accepted but no fresh sample/position was observed.",
            );
        }
        if (definition.id === "volume") {
          const actual = driver.state().gain;
          if (typeof actual === "number")
            probe.check(
              "Latest user app gain restored",
              Math.abs(actual - (intent.muted ? 0 : intent.gain)) < 0.02,
              `Expected ${intent.muted ? 0 : intent.gain}; observed ${actual}. System volume is never written by this test.`,
            );
          else
            probe.unverified(
              "Actual app gain",
              "This playback path has no readable native gain; manual listening and volume events remain required.",
            );
        }
        stage(
          "verification",
          "Check sound/files, stop, and verify a new session.",
        );
        await wait(dataOnly ? 10 : 3000);
        await stopChild();
        if (fileOutput) {
          const result = await driver.verifyFiles([...files]);
          probe.metric("recordedFrames", result.frames);
          probe.metric("recordedSeconds", result.seconds);
          probe.metric("recordedBytes", result.bytes);
          probe.check(
            "Recording retained and decodable",
            result.frames > 0 && result.bytes <= probe.report.limits.fileBytes,
            `${files.size} files; ${result.frames} frames; ${result.seconds.toFixed(2)} s.`,
          );
          if (definition.id === "notification-stop")
            probe.check(
              "Notification produced a finalized file",
              finalizations >= 1,
              `${finalizations} fileInfo events; ${files.size} unique paths. File rotation and later recovery are reported separately.`,
            );
        } else if (recording) {
          probe.unverified(
            "Capture continuity",
            "This capture path has no file output. Review callback frames/graph evidence and manually check microphone gaps.",
          );
        }
        probe.metric("lastAudioActivityAt", latestActivity);
        evidence.observed.afterCleanup = driver.state();
        probe.event(
          "postTestNewSession",
          "Separate usability check after original outcome and cleanup. No engine rebuild.",
        );
        await startChild();
        await wait(dataOnly ? 10 : 500);
        await stopChild();
      }
      if (evidence.verifiedFaults < evidence.requestedFaults)
        probe.unverified(
          "Fault coverage",
          `${evidence.verifiedFaults}/${evidence.requestedFaults} requested disruptions verified.`,
        );
      for (const error of faultErrors) {
        const matched =
          error.stage === "disruption" &&
          verifiedRounds.has(error.round) &&
          /interrupted|disconnected|media.*reset|dead.object|device.*lost|audio.*focus/i.test(
            error.error,
          );
        if (!matched) finding(`Unexpected audio error: ${error.error}`);
        else {
          probe.event("expectedDisruptionError", error);
          if (
            !evidence.recovery.some(
              (item) => item.round === error.round && item.observed,
            )
          )
            probe.unverified("Error recovery unverified", error.error);
        }
      }
      probe.metric("documentedClientHandlers", clientInterventions);
      probe.metric("automaticEngineRebuilds", 0);
      probe.metric("automaticRetries", 0);
      probe.metric("fileFinalizations", finalizations);
      probe.metric("audioCallbacks", callbacks);
      probe.metric(
        "peakPressureBytes",
        Math.max(
          0,
          ...evidence.nativeSamples.map((sample) => sample.allocatedBytes),
        ),
      );
      probe.metric(
        "peakNativeWorkers",
        Math.max(0, ...evidence.nativeSamples.map((sample) => sample.workers)),
      );
      const firstCpu = evidence.nativeSamples[0]?.cpuTimeMs;
      const lastCpu = evidence.nativeSamples.at(-1)?.cpuTimeMs;
      probe.metric(
        "observedProcessCpuTimeMs",
        firstCpu === undefined || lastCpu === undefined
          ? null
          : Math.max(0, lastCpu - firstCpu),
      );
      if (
        driver.platform === "android" &&
        ["routes-background", "combined"].includes(definition.id)
      )
        probe.unverified(
          "Actual media route",
          "Android native events and available devices are recorded. The communication route is not proof of the media player’s actual output; confirm it manually.",
        );
      probe.check(
        "Scenario supervisor survived",
        true,
        "Disruption and child cleanup did not terminate the test supervisor.",
      );
      probe.unverified(
        "Sound continuity, native deadlines, and leak freedom",
        "Use manual sound/file review. Process memory/thermal samples are evidence, not proof of no dropouts or leaks.",
      );
    } finally {
      this.input = null;
      this.commands = [];
      await stopChild();
      await driver.stopPressure();
    }
  }
}
