import Constants from "expo-constants";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { backend } from "../audio";
import build from "../audio/build-info.json";
import { historyEnvelope, jsonFile } from "../storage/json-file";
import { exportResults, History, redact } from "./history";
import { hasAudioSetup } from "./presentation";
import { defaults, features } from "./registry";
import { SessionCoordinator, type SessionScope } from "./session";
import {
  availability,
  BlockedError,
  CancelledError,
  formatError,
  type Action,
  type Feature,
  type Settings,
  type TestResult,
} from "./types";

const historyFile = new File(Paths.document, "audio-workshop-history-v1.json");
const history = new History(
  jsonFile(historyFile, (value) => historyEnvelope(value, "results")),
);
class WorkshopRuntime {
  sessions = new SessionCoordinator();
  private listeners = new Set<() => void>();
  private stopListeners = new Set<() => void | Promise<void>>();
  private scenarioFaults = new WeakMap<
    SessionScope,
    (error: unknown) => void
  >();
  private revision = 0;
  private resultsRevision = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = new Set<string>();
  private loaded = false;
  private initializing: Promise<void> | null = null;
  private stopGeneration = 0;
  private sessionResults = new WeakMap<SessionScope, TestResult>();
  private sessionErrors = new WeakMap<SessionScope, unknown>();
  private completed = new WeakSet<SessionScope>();
  private hooksEnabled = true;
  private historyEpoch = 0;
  private error: string | null = null;
  private snapshot = this.createSnapshot();
  private dataSnapshot = this.snapshot;
  constructor() {
    backend.onChange = () => this.changed();
    backend.onSessionEnded = (scope) => {
      if (!scope.alive) return;
      if (this.sessions.active !== scope) {
        const owner = this.sessions.active;
        if (owner?.owns(scope))
          void scope.dispose().catch((error) => {
            const observer = this.scenarioFaults.get(owner);
            if (observer) observer(error);
            else this.reportError(error);
          });
        return;
      }
      this.completed.add(scope);
      void this.sessions
        .stop(scope)
        .catch((error) => this.reportError(error))
        .finally(() => this.changed());
    };
    backend.onSessionError = (scope, error) => {
      const owner = this.sessions.active;
      if (!owner?.owns(scope) || !scope.alive) return;
      const scenarioListener = this.scenarioFaults.get(owner);
      if (scenarioListener && scope !== owner) {
        scenarioListener(error);
        void scope.dispose().catch((cleanup) => scenarioListener(cleanup));
        return;
      }
      this.sessionErrors.set(owner, error);
      const result = this.sessionResults.get(owner);
      if (result) {
        result.status = "failed";
        result.summary = formatError(error);
        result.finishedAt = new Date().toISOString();
        void this.save(result);
      }
      this.reportError(error);
      void this.sessions
        .stop(owner)
        .catch((cleanup) => this.reportError(cleanup))
        .finally(() => this.changed());
    };
  }
  private createSnapshot() {
    return {
      revision: this.revision,
      resultsRevision: this.resultsRevision,
      results: history.results,
      activeId: this.sessions.active?.featureId ?? null,
      busy: [...this.busy],
      backend: { ...backend.snapshot },
      error: this.error,
      loaded: this.loaded,
      hooksEnabled: this.hooksEnabled,
    };
  }
  private changed(resultsChanged = false) {
    this.revision++;
    if (resultsChanged) this.resultsRevision++;
    this.snapshot = this.createSnapshot();
    const next = this.snapshot,
      previous = this.dataSnapshot;
    if (
      next.resultsRevision !== previous.resultsRevision ||
      next.results !== previous.results ||
      next.activeId !== previous.activeId ||
      next.busy.join() !== previous.busy.join() ||
      next.hooksEnabled !== previous.hooksEnabled ||
      next.loaded !== previous.loaded ||
      next.error !== previous.error ||
      next.backend.recordings !== previous.backend.recordings ||
      next.backend.devices !== previous.backend.devices
    ) {
      this.dataSnapshot = next;
    }
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  getDataSnapshot = () => this.dataSnapshot;
  initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        await history.load();
        for (const result of history.results)
          if (result.status === "running") {
            result.status = "blocked";
            result.summary =
              "Previous process ended before this operation completed.";
          }
      } catch (error) {
        this.error = `History could not be restored: ${String(error)}`;
      }
      try {
        await backend.restoreRecordings();
      } catch (error) {
        this.error = `Recordings could not be restored: ${String(error)}`;
      }
      this.loaded = true;
      this.changed();
    })();
    return this.initializing;
  }
  private environment() {
    return {
      ...build,
      platform: Platform.OS,
      osVersion: Platform.Version,
      model: Device.modelName,
      physicalDevice: Device.isDevice,
      reactNative: Platform.constants.reactNativeVersion,
      buildType: __DEV__ ? "development" : "release",
      expoSdk: Constants.expoConfig?.sdkVersion ?? "57",
      context: backend.snapshot.context,
      availableInputs: backend.snapshot.devices,
    };
  }
  private async save(result: TestResult, epoch = this.historyEpoch) {
    if (epoch !== this.historyEpoch) return;
    try {
      await history.put(result);
    } catch (error) {
      this.error = `History write failed: ${String(error)}`;
    }
    this.changed(true);
  }
  async execute(feature: Feature, action: Action, settings: Settings) {
    const generation = this.stopGeneration;
    await this.initialize();
    if (this.busy.has(feature.id) && action.id !== "stop") return;
    if (["volume", "devices"].includes(feature.id)) this.hooksEnabled = true;
    const epoch = this.historyEpoch;
    const result: TestResult = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      featureId: feature.id,
      action: action.id,
      startedAt: new Date().toISOString(),
      settings: redact(settings),
      environment: this.environment(),
      status: "running",
      summary: "Running…",
      events: [],
      droppedEvents: 0,
    };
    this.busy.add(feature.id);
    await this.save(result, epoch);
    let scope = this.sessions.active;
    const emit = (name: string, value?: unknown, finalization = false) => {
      if (epoch !== this.historyEpoch) return;
      if (action.session && !scope?.alive && !finalization) return;
      if (result.events.length >= 500) {
        result.events.shift();
        result.droppedEvents++;
      }
      result.events.push({
        at: new Date().toISOString(),
        name,
        value:
          value instanceof Error
            ? { message: value.message, name: value.name }
            : value,
      });
      this.changed(true);
      if (!this.flushTimer)
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.save(result, epoch);
        }, 500);
    };
    try {
      if (generation !== this.stopGeneration && action.id !== "stop")
        throw new CancelledError("Operation cancelled by Stop all.");
      const reason = availability(feature, Platform.OS);
      if (reason) {
        result.status = "unavailable";
        result.summary = reason;
        return;
      }
      if (action.id === "stop") {
        const stopped = await this.stopAll();
        result.status = stopped ? "passed" : "failed";
        result.summary = stopped
          ? "All active audio resources stopped."
          : "One or more resources failed to stop. See the cleanup error.";
        return;
      }
      if (action.session) {
        scope = await this.sessions.replace(feature.id);
        this.sessionResults.set(scope, result);
        scope.defer(() => backend.idle());
        scope.ensureActive();
        this.changed();
      }
      let outcome;
      if (action.id === "start-with-audio" && hasAudioSetup(feature)) {
        if (!scope)
          throw new BlockedError("Start the notification test again.");
        const recording =
          ["recording-notification", "record-recovery"].includes(feature.id) ||
          (feature.id !== "playback-notification" &&
            settings.testAudio === "recording");
        const companion = features.find(
          (item) => item.id === (recording ? "record-file" : "buffer-source"),
        )!;
        if (feature.id === "session")
          await scope.hold(
            backend.run("session", "apply", settings, scope, emit),
          );
        const started = await scope.hold(
          backend.run(
            companion.id,
            "start",
            {
              ...defaults(companion),
              loop: true,
              monitor: false,
              productionPreserveSession: feature.id === "session",
            },
            scope,
            emit,
          ),
        );
        scope.ensureActive();
        if (started.status === "failed") throw new Error(started.summary);
        if (started.status === "blocked" || started.status === "unavailable")
          throw new BlockedError(started.summary);
        const setup = feature.id.endsWith("-notification")
          ? "show"
          : feature.id === "system-events"
            ? "observe"
            : feature.id === "session"
              ? "apply"
              : "inspect";
        outcome = await scope.hold(
          backend.run(feature.id, setup, settings, scope, emit),
        );
        if (feature.id === "playback-notification")
          for (const control of ["play", "pause", "stop"]) {
            scope.ensureActive();
            await scope.hold(
              backend.run(
                feature.id,
                "control",
                { control, enabled: true },
                scope,
                emit,
              ),
            );
          }
        if (
          recording &&
          feature.id !== "recording-notification" &&
          Platform.OS === "android"
        ) {
          scope.ensureActive();
          await scope.hold(
            backend.run(
              "recording-notification",
              "show",
              { title: "Recovery check", showStopAction: true },
              scope,
              emit,
            ),
          );
        }
      } else
        outcome = await backend.run(
          feature.id,
          action.id,
          settings,
          scope,
          emit,
        );
      if (scope && this.sessionErrors.has(scope))
        throw this.sessionErrors.get(scope);
      if (action.session && scope && !this.completed.has(scope))
        scope.ensureActive();
      Object.assign(result, outcome);
    } catch (caught) {
      const error =
        scope && this.sessionErrors.has(scope)
          ? this.sessionErrors.get(scope)
          : caught;
      result.status =
        error instanceof BlockedError || error instanceof CancelledError
          ? "blocked"
          : "failed";
      result.summary =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      if (error && typeof error === "object" && "nativeErrorInfo" in error)
        emit("nativeErrorInfo", error.nativeErrorInfo);
    } finally {
      if (
        action.session &&
        (action.check ||
          result.status === "failed" ||
          result.status === "blocked") &&
        this.sessions.active === scope
      ) {
        try {
          await this.sessions.stop(scope ?? undefined);
        } catch (error) {
          result.status = "failed";
          result.summary += ` Cleanup failed: ${formatError(error)}`;
        }
      }
      result.finishedAt = new Date().toISOString();
      result.environment = this.environment();
      this.busy.delete(feature.id);
      await this.save(result, epoch);
    }
  }
  async stopAll() {
    this.stopGeneration++;
    const pressureStops = [...this.stopListeners].map((listener) => {
      try {
        return Promise.resolve(listener());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    this.hooksEnabled = false;
    this.changed();
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled(pressureStops))
      if (result.status === "rejected") failures.push(result.reason);
    try {
      await this.sessions.stop(undefined, () => backend.idle());
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      this.error = `Cleanup: ${failures.map(formatError).join("; ")}`;
    this.changed();
    return failures.length === 0;
  }
  async exclusiveStress(
    id: string,
    task: (scope: SessionScope) => Promise<void>,
  ) {
    const generation = this.stopGeneration;
    await this.initialize();
    if (generation !== this.stopGeneration)
      throw new CancelledError("Stress start cancelled by Stop all.");
    const scope = await this.sessions.replace(id);
    scope.defer(() => backend.idle());
    this.changed();
    try {
      await task(scope);
      if (this.sessionErrors.has(scope)) throw this.sessionErrors.get(scope);
      scope.ensureActive();
    } catch (error) {
      throw this.sessionErrors.get(scope) ?? error;
    } finally {
      try {
        await this.sessions.stop(scope);
      } finally {
        this.changed();
      }
    }
  }
  enableObservationHooks() {
    this.hooksEnabled = true;
    this.changed(true);
  }
  observeScenarioFaults(
    scope: SessionScope,
    listener: (error: unknown) => void,
  ) {
    this.scenarioFaults.set(scope, listener);
    return () => {
      this.scenarioFaults.delete(scope);
    };
  }
  onStopAll(listener: () => void | Promise<void>) {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }
  async confirm(id: string, verdict: "passed" | "failed", notes: string) {
    await this.initialize();
    const result = history.results.find((item) => item.id === id);
    if (!result) return;
    result.manualVerdict = verdict;
    result.notes = notes;
    // Manual confirmation never overwrites the automatic status/assertions.
    await this.save(result);
  }
  async clearHistory() {
    await this.initialize();
    this.historyEpoch++;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.stopAll();
    await history.clear();
    this.changed();
  }
  async export(ids?: string[]) {
    await this.initialize();
    if (!(await Sharing.isAvailableAsync()))
      throw new BlockedError("System sharing is unavailable.");
    const results = ids
      ? history.results.filter((item) => ids.includes(item.id))
      : history.results;
    const file = new File(Paths.cache, `audio-workshop-${Date.now()}.json`);
    file.create();
    file.write(exportResults(results));
    try {
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        UTI: "public.json",
        dialogTitle: "Export workshop results",
      });
    } finally {
      if (file.exists) file.delete();
    }
  }
  async selectInput(id: string) {
    try {
      await backend.selectInput(id);
    } catch (error) {
      this.error = formatError(error);
    }
    this.changed();
  }
  async playRecording(path: string) {
    await this.initialize();
    const scope = await this.sessions.replace("recorded-file");
    scope.defer(() => backend.idle());
    scope.ensureActive();
    try {
      await backend.playRecording(path, scope, () => {});
    } catch (error) {
      if (this.sessions.active === scope) {
        this.error = formatError(error);
        await this.sessions.stop(scope);
      }
    }
    this.changed();
  }
  async deleteRecording(paths: string[]) {
    if (!(await this.stopAll()))
      throw new BlockedError(
        "Files were not deleted because audio cleanup failed. Retry Stop all first.",
      );
    backend.deleteRecording(paths);
    this.changed();
  }
  reportError(error: unknown) {
    this.error = formatError(error);
    this.changed();
  }
}
export const workshop = new WorkshopRuntime();
export { backend, build };
