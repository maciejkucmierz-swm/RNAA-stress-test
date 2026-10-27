import { File } from "expo-file-system";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import { BlockedError, manual, passed } from "../workshop/types";
import type { Backend, BackendSnapshot } from "./contracts";
import { runDataCheck } from "./data-checks";
import { createEngine } from "./engine";
import { startGraph } from "./graphs";
import { createMediaHandlers, startMedia } from "./media";
import { capture } from "./recording";
import { executeNativeStress } from "./stress";
import { idle, system } from "./system";
import { inspectCapabilities, ramp } from "./utils";
export function createBackend(): Backend {
  const engine = createEngine();
  const backend: Backend = {
    channel: "stable",
    formats: Object.keys(API.FileFormat).filter(
      (key) =>
        typeof API.FileFormat[key as keyof typeof API.FileFormat] === "number",
    ),
    get snapshot() {
      return engine.state;
    },
    get mediaContext() {
      return engine.context;
    },
    ...createMediaHandlers(engine),
    onChange: () => {},
    onSessionEnded: () => {},
    onSessionError: () => {},
    async runStress(id, options, scope, probe) {
      return executeNativeStress(id, options, scope, probe, {
        backend: engine.backend,
        context: engine.live,
        recorder: engine.record,
        environment: engine.environment,
        async dispatchPlayback(name) {
          const handler = engine.playbackHandlers.get(name);
          if (!handler)
            throw new BlockedError(
              "Show a playback notification before dispatching a synthetic control.",
            );
          handler();
          await engine.notificationUpdate;
        },
      });
    },
    async run(id, action, s, scope, emit) {
      if (action === "stop") return passed("Stop requested.");
      if (
        [
          "context",
          "capabilities",
          "buffer",
          "decode",
          "metadata",
          "pcm",
          "concat",
          "errors",
          "offline",
        ].includes(id)
      )
        return runDataCheck(engine, id, action, s, scope, emit);
      if (id.startsWith("record-") && id !== "record-recovery") {
        if (action === "start" || action === "check")
          return capture(
            engine,
            id,
            action,
            s,
            engine.requireScope(scope),
            emit,
          );
      } else if (id === "audio-tag" || id === "media-route") {
        if (action === "start" || action === "check")
          return startMedia(
            engine,
            id,
            action,
            s,
            engine.requireScope(scope),
            emit,
          );
      } else if (
        [
          "permissions",
          "session",
          "system-events",
          "devices",
          "volume",
          "playback-notification",
          "recording-notification",
          "background",
          "record-recovery",
        ].includes(id)
      )
        return system(engine, id, action, s, emit);
      else if (["start", "check", "default-start"].includes(action))
        return startGraph(
          engine,
          id,
          action,
          s,
          engine.requireScope(scope),
          emit,
        );
      if (
        !engine.controls ||
        engine.controls.id !== id ||
        !engine.controls.scope.alive
      )
        throw new BlockedError("Start this feature before using its controls.");
      const control = engine.controls.actions[action];
      if (!control)
        throw new BlockedError(
          `The current demo has no ${action} operation. Stop and start with new settings.`,
        );
      await control(s);
      emit("operation", action);
      return manual("Operation completed. Confirm the observed behavior.");
    },
    scenarioState() {
      return {
        queue: engine.state.queue ?? null,
        context: engine.context
          ? {
              state: engine.context.state,
              sampleRate: engine.context.sampleRate,
              currentTime: engine.context.currentTime,
              ...inspectCapabilities(),
            }
          : null,
        recordingOngoing: API.AudioRecorder.isRecordingOngoing(),
        recording: engine.recorder?.isRecording() ?? false,
        recordingPaused: engine.recorder?.isPaused() ?? false,
        gain: engine.scenarioOutput?.gain.value ?? null,
        mediaMounted: !!engine.mediaHandle,
      };
    },
    async applyScenarioIntent(intent, recording) {
      if (
        engine.scenarioOutput &&
        engine.context &&
        engine.context.state !== "closed"
      )
        ramp(
          engine.scenarioOutput.gain,
          intent.muted ? 0 : intent.gain,
          engine.context,
        );
      if (engine.mediaHandle) {
        engine.mediaHandle.setVolume(intent.gain);
        engine.mediaHandle.setMuted(intent.muted);
      }
      if (recording) {
        if (
          engine.recorder?.isRecording() &&
          (!intent.playing || intent.needsUser || intent.interrupted)
        )
          await engine.recorder.pause();
        else if (
          engine.recorder?.isPaused() &&
          intent.playing &&
          !intent.needsUser &&
          !intent.interrupted
        )
          await engine.recorder.resume();
      } else if (engine.mediaHandle) {
        if (intent.playing && !intent.needsUser && !intent.interrupted)
          engine.mediaHandle.play();
        else engine.mediaHandle.pause();
      } else if (engine.context && engine.context.state !== "closed") {
        if (intent.playing && !intent.needsUser && !intent.interrupted)
          await engine.context.resume();
        else await engine.context.suspend();
      }
    },
    idle: () => idle(engine),
    selectHookInput: (input, device) => input.onSelectInput(device),
    async selectInput(id) {
      if (Platform.OS === "android")
        throw new BlockedError(
          "Stable Android setInputDevice is a native no-op.",
        );
      await API.AudioManager.setInputDevice(id);
      const info = await API.AudioManager.getDevicesInfo();
      engine.state.devices = info.availableInputs;
      engine.notify();
    },
    async playRecording(path, scope, emit) {
      const env = engine.environment({}, scope, emit, true);
      const buffer = await env.context.decodeAudioData(path);
      scope.ensureActive();
      const source = env.track(env.context.createBufferSource());
      source.buffer = buffer;
      source.connect(env.output);
      env.bindSource(source);
      await scope.hold(env.context.resume());
      scope.ensureActive();
      source.start();
      return manual("Recorded file is playing. Confirm the audible content.");
    },
    deleteRecording(paths) {
      for (const path of paths) {
        const file = new File(path);
        if (file.exists) file.delete();
      }
      engine.state.recordings = engine.state.recordings.filter(
        (item) => !item.paths.some((path) => paths.includes(path)),
      );
      engine.saveRecordings();
      engine.notify();
    },
    async restoreRecordings() {
      const text = await engine.recordings.read();
      if (!text) return;
      const saved: BackendSnapshot["recordings"] = JSON.parse(text);
      engine.state.recordings = saved.filter((item) =>
        item.paths.some((path) => new File(path).exists),
      );
      engine.notify();
    },
  };

  engine.backend = backend;
  return backend;
}
