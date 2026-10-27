import { redact } from "../workshop/history";
import { companionFor, defaults, features } from "../workshop/registry";
import { SessionScope } from "../workshop/session";
import {
  availability,
  BlockedError,
  type Feature,
  type Outcome,
  type RepetitionKind,
  type Settings,
} from "../workshop/types";
import type { StressOptions } from "./catalog";
import type { StressProbe } from "./runner";

const descriptions: Record<RepetitionKind, string> = {
  check: "Repeat this feature’s checks using the settings above.",
  context: "Create, inspect, suspend, resume, and close one context at a time.",
  connections: "Disconnect and reconnect one live sound graph.",
  edit: "Change settings on one live sound graph. Level changes the number of edits, not volume.",
  restart:
    "Start, stop, and recreate this feature. Only one session runs at a time.",
  queue: "Enqueue, dequeue, clear, and refill bounded groups of sound buffers.",
  record:
    "Keep one recorder running and repeat pause/resume. Files remain available for replay.",
  session:
    "Apply the selected iOS session settings and repeat activate/deactivate.",
  "live-system":
    "Keep playback or recording running while checking the system and doing real disruptions.",
  notification:
    "Keep playback or recording running and repeat notification updates and Hide/Show.",
};
export function featureLoadRecipe(feature: Feature) {
  const kind = feature.workload.kind;
  return {
    kind,
    description: descriptions[kind],
    live: !["check", "context", "session"].includes(kind),
  };
}
export function featureLoadPlan(options: StressOptions) {
  const feature = features.find((item) => item.id === options.targetFeatureId);
  if (!feature)
    throw new Error("Choose an existing feature for the inline load test.");
  const level = options.level;
  if (!Number.isInteger(level) || level! < 1 || level! > 10)
    throw new Error("Load level must be an integer from 1–10.");
  const recipe = featureLoadRecipe(feature);
  const cycles = [1, 3, 5, 10, 20, 40, 60, 100, 150, 200][level! - 1];
  const durationMs = (15 + level! * 15) * 1000;
  const companion = companionFor(feature, options.companion);
  const keepRunning =
    recipe.live &&
    (options.loadMode === "live" || recipe.kind === "live-system");
  const manual = recipe.live
    ? [
        "Listen or replay the recording. Confirm no unexpected silence, repeated audio, or missing speech.",
        ...(keepRunning || recipe.kind === "notification"
          ? [
              "While active: open/close the notification panel, switch apps, lock/unlock, and return. Use real notification controls where available; note each action and result.",
            ]
          : []),
        "After cleanup, confirm silence/no microphone use and start a normal demo or recording again.",
      ]
    : feature.id === "permissions"
      ? [
          "Use the normal Request buttons to check real permission prompts. Repeated permission reads do not test permission dialogs.",
        ]
      : [];
  return {
    feature,
    ...recipe,
    level: level!,
    cycles,
    durationMs,
    companion,
    keepRunning,
    manual,
    usage: `${recipe.description} Level ${level}: ${keepRunning ? "one live session" : `${cycles} ${cycles === 1 ? "round" : "rounds"}`}${recipe.live ? ` over about ${durationMs / 1000} seconds` : ""}. Uses the feature settings captured at start.`,
  };
}
export function inlineSettings(
  feature: Feature,
  settings: Settings,
  options: StressOptions,
): Settings {
  // Bound allocations without turning a load level into an output-volume control.
  const channels = Number(settings.channels ?? 2),
    rate = Number(
      settings.sampleRate === "device" ? 48000 : (settings.sampleRate ?? 48000),
    );
  const frames = Number(
    settings.frames ?? rate * Math.min(30, Number(settings.duration ?? 3)),
  );
  if (
    !Number.isFinite(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isFinite(rate) ||
    rate < 8000 ||
    rate > 192000 ||
    !Number.isFinite(frames) ||
    frames <= 0 ||
    frames * channels * 4 * 3 > options.memoryMiB * 1024 * 1024
  ) {
    throw new BlockedError(
      "Selected audio settings exceed the inline buffer budget. Reduce channels, frames, rate, or duration.",
    );
  }
  return {
    ...settings,
    duration: Math.min(30, Math.max(0.1, Number(settings.duration ?? 3))),
    ...(feature.workload.capture !== "none" ? { monitor: false } : {}),
  };
}
function editedSettings(
  id: string,
  settings: Settings,
  index: number,
): Settings {
  const alternate = index % 2 === 0;
  const number = (key: string, fallback: number) =>
    Number(settings[key] ?? fallback);
  switch (id) {
    case "oscillator":
      return {
        ...settings,
        frequency: alternate
          ? number("frequency", 440)
          : number("frequency", 440) * 1.05,
      };
    case "gain":
      return {
        ...settings,
        gain: alternate ? number("gain", 0.5) : number("gain", 0.5) * 0.5,
      };
    case "pan":
      return { ...settings, pan: alternate ? -0.5 : 0.5 };
    case "biquad":
      return {
        ...settings,
        cutoff: Math.max(
          20,
          Math.min(18000, number("cutoff", 1000) * (alternate ? 1 : 1.5)),
        ),
      };
    case "delay":
      return {
        ...settings,
        delayTime: alternate
          ? 0
          : Math.min(number("maxDelay", 1), number("delayTime", 0.2)),
      };
    case "convolver":
      return { ...settings, normalize: alternate };
    case "waveshaper":
      return {
        ...settings,
        drive: number("drive", 3) * (alternate ? 1 : 0.8),
        curveSize: alternate ? 256 : 1024,
        oversample: alternate ? "none" : "2x",
      };
    case "analyser":
      return { ...settings, fftSize: alternate ? "1024" : "2048" };
    case "spatial":
      return { ...settings, x: alternate ? -1 : 1 };
    case "buffer-source":
      return {
        ...settings,
        loop: true,
        playbackRate: number("playbackRate", 1) * (alternate ? 1 : 0.9),
      };
    case "audio-tag":
      return { ...settings, muted: alternate ? !!settings.muted : true };
    default:
      return settings;
  }
}
export interface FeatureLoadDriver {
  channel: "stable";
  platform: string;
  run(
    id: string,
    action: string,
    settings: Settings,
    scope: SessionScope,
    emit: (name: string, value?: unknown) => void,
  ): Promise<Outcome>;
  idle(): Promise<void>;
  fileBytes(): number;
}
export async function runFeatureLoad(
  options: StressOptions,
  root: SessionScope,
  probe: StressProbe,
  driver: FeatureLoadDriver,
) {
  const plan = featureLoadPlan(options),
    { feature } = plan;
  const reason = availability(feature, driver.platform);
  if (reason) throw new BlockedError(reason);
  const settings = inlineSettings(
    feature,
    { ...defaults(feature), ...options.targetSettings },
    options,
  );
  const initialFiles = driver.fileBytes();
  const recording =
    plan.kind === "record" ||
    (["notification", "live-system"].includes(plan.kind) &&
      plan.companion === "recording");
  if (
    recording &&
    (plan.kind !== "record" ||
      ["file", "combined"].includes(feature.workload.capture))
  ) {
    const estimatedRate = Math.max(48000, Number(settings.recordRate ?? 48000));
    const estimate =
      ((estimatedRate * Number(settings.channels ?? 2) * 4 * plan.durationMs) /
        1000) *
      1.1;
    if (!Number.isFinite(estimate) || estimate > probe.report.limits.fileBytes)
      throw new BlockedError(
        "Recording would exceed the file budget. Lower the level, rate, or channels.",
      );
  }
  let assertions = 0;
  probe.event("effectiveSettings", redact(settings));
  let callbackCount = 0,
    fileFinalizations = 0,
    invalidCallback = false,
    nativeStopped = false;
  const emit = (name: string, value?: unknown) => {
    if (name === "recordingNotificationStop") nativeStopped = true;
    if (name === "fileInfo") fileFinalizations++;
    if (name === "audioReady") {
      callbackCount++;
      const sample = value as { numFrames: number; rms: number; when: number };
      if (
        !(sample.numFrames > 0) ||
        !Number.isFinite(sample.rms) ||
        !Number.isFinite(sample.when)
      )
        invalidCallback = true;
    }
    if (
      name === "captureCounters" &&
      Number((value as { invalid?: number })?.invalid)
    )
      invalidCallback = true;
    if (
      name === "metadata" &&
      (value as { source?: string })?.source === "decoded-fallback"
    ) {
      probe.check(
        "Native duration metadata available",
        false,
        `Native duration unavailable: ${JSON.stringify(value)}. Decode fallback does not repair metadata.`,
      );
    }
    probe.event(name, value);
  };
  const invoke = async (
    id: string,
    action: string,
    values: Settings,
    scope: SessionScope,
  ) => {
    const outcome = await probe.operation(`${id}:${action}`, () => {
      scope.ensureActive();
      return scope.hold(driver.run(id, action, values, scope, emit));
    });
    if (!outcome) return;
    assertions += outcome.assertions?.length ?? 0;
    for (const assertion of outcome.assertions ?? [])
      if (!assertion.passed)
        probe.check(
          `${id}: ${assertion.name}`,
          false,
          assertion.detail ?? outcome.summary,
        );
    if (outcome.status === "failed") throw new Error(outcome.summary);
    if (outcome.status === "blocked" || outcome.status === "unavailable")
      throw new BlockedError(outcome.summary);
  };
  const budget = () => {
    const bytes = Math.max(0, driver.fileBytes() - initialFiles);
    probe.metric("newFileBytes", bytes);
    if (bytes >= probe.report.limits.fileBytes)
      throw new BlockedError(
        "File budget reached; the full workload did not finish.",
      );
  };
  async function session(task: (scope: SessionScope) => Promise<void>) {
    const scope = new SessionScope(feature.id, root);
    scope.defer(() => driver.idle());
    try {
      await task(scope);
    } finally {
      await scope.dispose();
    }
  }
  probe.tick(plan.usage);
  probe.metric("level", plan.level);
  probe.metric("plannedRounds", plan.cycles);
  probe.metric("processMemoryMeasured", false);
  probe.metric("nativeRenderDeadlinesMeasured", false);
  if (
    settings.input === "url" ||
    settings.input === "hls" ||
    feature.id === "streamer"
  )
    probe.unverified(
      "Remote cache/memory",
      "Remote response length and native cache growth are not measured by the owned-buffer limit.",
    );
  const liveKind = plan.live && plan.kind !== "restart";
  const startCompanion = async (scope: SessionScope) => {
    const id = plan.companion === "recording" ? "record-file" : "buffer-source";
    const companionFeature = features.find((item) => item.id === id)!;
    await invoke(
      id,
      "start",
      {
        ...defaults(companionFeature),
        loop: true,
        monitor: false,
        format: "Wav",
        channels: 1,
        preset: "Low",
        rotateBytes: 1024 * 1024,
      },
      scope,
    );
  };
  const startLive = async (scope: SessionScope) => {
    if (plan.kind === "live-system" || plan.kind === "notification") {
      await startCompanion(scope);
      await invoke(
        feature.id,
        feature.id === "system-events"
          ? "observe"
          : plan.kind === "notification"
            ? "show"
            : "inspect",
        settings,
        scope,
      );
    } else
      await invoke(feature.id, "start", { ...settings, loop: true }, scope);
  };
  if (liveKind || plan.keepRunning) {
    await session(async (scope) => {
      await startLive(scope);
      const interval = plan.durationMs / (plan.keepRunning ? 1 : plan.cycles);
      for (
        let index = 0;
        index < (plan.keepRunning ? 1 : plan.cycles);
        index++
      ) {
        if (nativeStopped || !scope.alive) break;
        if (!plan.keepRunning) {
          if (plan.kind === "edit")
            await invoke(
              feature.id,
              "apply",
              editedSettings(feature.id, settings, index),
              scope,
            );
          if (plan.kind === "connections") {
            await invoke(feature.id, "disconnect", settings, scope);
            await probe.wait(30);
            await invoke(feature.id, "connect", settings, scope);
          }
          if (plan.kind === "queue") {
            await invoke(feature.id, "enqueue", settings, scope);
            await invoke(
              feature.id,
              index % 4 === 3 ? "clear" : "dequeue",
              settings,
              scope,
            );
            if (index % 4 === 3) {
              await invoke(feature.id, "enqueue", settings, scope);
              await invoke(feature.id, "resume", settings, scope);
            }
          }
          if (plan.kind === "record" && index > 0) {
            await invoke(feature.id, "pause", settings, scope);
            await probe.wait(50);
            await invoke(feature.id, "resume", settings, scope);
          }
          if (plan.kind === "notification") {
            await invoke(
              feature.id,
              "show",
              { ...settings, title: `${settings.title} · ${index + 1}` },
              scope,
            );
            if (index % 4 === 3) {
              await invoke(feature.id, "hide", settings, scope);
              await invoke(feature.id, "show", settings, scope);
            }
          }
        }
        const deadline = Date.now() + interval;
        while (
          Date.now() < deadline &&
          !nativeStopped &&
          scope.alive &&
          probe.report.metrics.finishLiveRequested !== true
        ) {
          await probe.wait(Math.min(250, deadline - Date.now()));
          budget();
        }
        probe.metric("completedRounds", index + 1);
        if (probe.report.metrics.finishLiveRequested === true) break;
      }
      if (nativeStopped || !scope.alive)
        probe.metric("endedByNativeControl", true);
    });
  } else {
    for (let index = 0; index < plan.cycles; index++) {
      await session(async (scope) => {
        if (plan.kind === "context") {
          for (const action of [
            "create",
            "inspect",
            "pause",
            "resume",
            "close",
          ])
            await invoke(feature.id, action, settings, scope);
        } else if (plan.kind === "session") {
          for (const action of ["apply", "activate", "deactivate"])
            await invoke(feature.id, action, settings, scope);
        } else if (plan.kind === "restart") {
          await invoke(feature.id, "start", settings, scope);
          await probe.wait(plan.durationMs / plan.cycles);
        } else {
          await invoke(
            feature.id,
            ["capabilities", "permissions"].includes(feature.id)
              ? "inspect"
              : "check",
            settings,
            scope,
          );
        }
      });
      budget();
      probe.metric("completedRounds", index + 1);
      await probe.wait(10);
    }
  }
  probe.check(
    "Requested feature operations settled",
    true,
    "Native operations returned; failures and native assertions are recorded separately.",
  );
  budget();
  probe.metric("nativeAssertionsChecked", assertions);
  if (
    !plan.keepRunning &&
    probe.report.metrics.completedRounds !== plan.cycles
  ) {
    probe.unverified(
      "Workload ended early",
      `Completed ${probe.report.metrics.completedRounds ?? 0}/${plan.cycles} rounds. A source ending or native Stop does not complete the remaining workload.`,
    );
  }
  if (
    ["file", "combined"].includes(feature.workload.capture) ||
    (recording && plan.kind !== "record")
  ) {
    probe.check(
      "Recording file finalized",
      fileFinalizations > 0,
      `${fileFinalizations} finalized file results. Replay retained files manually.`,
    );
  }
  if (["samples", "graph", "combined"].includes(feature.workload.capture))
    probe.check(
      "Microphone callbacks arrived",
      callbackCount > 0,
      `${callbackCount} scalar callback summaries received.`,
    );
  if (callbackCount) {
    probe.metric("captureEvents", callbackCount);
    probe.check(
      "Callback validity",
      !invalidCallback,
      "No invalid sample batches reported.",
    );
  }
  if (plan.live)
    probe.unverified(
      "Audio continuity and native resources",
      "Listening/real OS actions are manual. Native deadlines, total process memory, and leak freedom have not been measured.",
    );
}
