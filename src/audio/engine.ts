import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import { jsonFile } from "../storage/json-file";
import { SessionScope } from "../workshop/session";
import { BlockedError, type Settings } from "../workshop/types";
import type {
  Backend,
  BackendSnapshot,
  Emit,
  GraphEnvironment,
} from "./contracts";
import {
  bindSourceEvents,
  checkMilliseconds,
  inspectCapabilities,
  n,
  sampleRate,
  type Controls,
} from "./utils";

export function createEngine() {
  const engine = {
    context: null as API.AudioContext | null,
    scenarioOutput: null as API.GainNode | null,
    recorder: null as API.AudioRecorder | null,
    controls: null as Controls | null,
    mediaHandle: null as API.AudioTagHandle | null,
    mediaEmit: null as Emit | null,
    mediaScope: null as SessionScope | null,
    mediaLoaded: false,
    mediaRouted: false,
    contextActivityUpdate: null as Promise<unknown> | null,
    mediaError: null as unknown,
    systemSubscriptions: [] as { remove(): void }[],
    notificationSubscriptions: [] as { remove(): void }[],
    notifyEmit: null as Emit | null,
    systemEpoch: 0,
    notificationGeneration: 0,
    notificationUpdate: null as Promise<void> | null,
    playbackHandlers: new Map<string, () => void>(),
    sessionOptions: {
      iosCategory: "playback",
      iosMode: "default",
      iosOptions: [],
    } as API.SessionOptions,
    sessionActivityOwned: false,
    sessionActivityUpdate: null as Promise<void> | null,
    sessionManagementDisabled: false,
    activeCapture: null as {
      scope: SessionScope;
      accept: (result: API.FileInfo) => void;
      check: boolean;
    } | null,
    state: {
      context: null,
      media: null,
      recordings: [],
      devices: [],
      plot: null,
    } as BackendSnapshot,
    recordingIndex: new File(
      Paths.document,
      "audio-workshop-recordings-v1.json",
    ),
    backend: null as unknown as Backend,
    recordings: null as unknown as ReturnType<typeof jsonFile>,
    notify,
    saveRecordings,
    rememberRecording,
    inspect,
    live,
    record,
    environment,
    setControls,
    requireScope,
  };
  const recordings = jsonFile(
    engine.recordingIndex,
    (value) =>
      Array.isArray(value) &&
      value.every(
        (item) =>
          item &&
          Array.isArray(item.paths) &&
          typeof item.duration === "number" &&
          typeof item.size === "number",
      ),
  );
  engine.recordings = recordings;
  function notify(): void {
    engine.backend.onChange();
  }
  function saveRecordings(): void {
    recordings.write(JSON.stringify(engine.state.recordings));
  }
  function rememberRecording(result: {
    paths: string[];
    duration: number;
    size: number;
  }) {
    engine.state.recordings = [
      result,
      ...engine.state.recordings.filter(
        (item) => !item.paths.some((path) => result.paths.includes(path)),
      ),
    ];
    engine.saveRecordings();
    engine.notify();
  }
  function inspect(): Record<string, unknown> {
    engine.state.context = engine.context
      ? {
          state: engine.context.state,
          sampleRate: engine.context.sampleRate,
          currentTime: engine.context.currentTime,
        }
      : null;
    engine.notify();
    return { ...engine.state.context, ...inspectCapabilities() };
  }
  function live(s: Settings = {}): API.AudioContext {
    if (!engine.context || engine.context.state === "closed") {
      if (Platform.OS === "ios" && !engine.sessionManagementDisabled)
        API.AudioManager.setAudioSessionOptions(engine.sessionOptions);
      engine.context = new API.AudioContext({ sampleRate: sampleRate(s) });
    }
    engine.inspect();
    return engine.context;
  }
  function record(_s: Settings): API.AudioRecorder {
    if (!engine.recorder) engine.recorder = new API.AudioRecorder();
    return engine.recorder;
  }
  function environment(
    s: Settings,
    scope: SessionScope,
    emit: Emit,
    finishOnEnd = false,
  ): GraphEnvironment {
    const ctx = engine.live(s);
    const nodes: API.AudioNode[] = [];
    const sources: API.AudioScheduledSourceNode[] = [];
    scope.defer(() => {
      const errors: unknown[] = [];
      for (const source of sources)
        try {
          source.stop();
        } catch (error) {
          // A source constructed before an async/validation failure may never start.
          if (
            !(
              typeof API.InvalidStateError === "function" &&
              error instanceof API.InvalidStateError
            )
          )
            errors.push(error);
        }
      for (const node of nodes.reverse())
        try {
          node.disconnect();
        } catch (error) {
          errors.push(error);
        }
      if (engine.controls?.scope === scope) engine.controls = null;
      engine.state.plot = null;
      engine.notify();
      if (errors.length)
        throw new AggregateError(errors, "Graph cleanup failed.");
    });
    const track = <T extends API.AudioNode>(node: T): T => {
      scope.ensureActive();
      nodes.push(node);
      if (node instanceof API.AudioScheduledSourceNode) sources.push(node);
      return node;
    };
    const output = track(ctx.createGain());
    output.gain.value = s.productionProbe
      ? s.muted
        ? 0
        : n(s, "scenarioGain", 0.1)
      : 0.1;
    if (s.productionProbe) {
      engine.scenarioOutput = output;
      scope.defer(() => {
        if (engine.scenarioOutput === output) engine.scenarioOutput = null;
      });
    }
    output.connect(ctx.destination);
    const bindSource = (
      node: API.AudioScheduledSourceNode,
      keepTransport = false,
    ) => {
      scope.defer(
        bindSourceEvents(node, (name, value) => {
          if (!scope.alive) return;
          emit(name, value);
          if (finishOnEnd && ["onEnded", "onended"].includes(name)) {
            if (keepTransport)
              void scope.hold(ctx.suspend()).catch((error) => {
                if (scope.alive) engine.backend.onSessionError(scope, error);
              });
            else engine.backend.onSessionEnded(scope);
          }
        }),
      );
    };
    const tone = () => {
      const node = track(ctx.createOscillator());
      node.frequency.value = n(s, "frequency", 440);
      bindSource(node);
      return node;
    };
    const timer = setInterval(() => {
      if (!scope.alive) return;
      try {
        engine.inspect();
      } catch (error) {
        clearInterval(timer);
        engine.backend.onSessionError(scope, error);
      }
    }, 250);
    scope.defer(() => clearInterval(timer));
    return {
      context: ctx,
      scope,
      emit,
      output,
      track,
      trackedCount: () => nodes.length,
      tone,
      bindSource,
      controls: (actions) =>
        engine.setControls(scope.featureId, scope, actions),
      waitCheck: () => scope.wait(checkMilliseconds(s)),
    };
  }
  function setControls(
    id: string,
    scope: SessionScope,
    actions: Controls["actions"],
  ) {
    engine.controls = { id, scope, actions };
  }
  function requireScope(scope: SessionScope | null): SessionScope {
    if (!scope)
      throw new BlockedError("Start this feature before using its controls.");
    scope.ensureActive();
    return scope;
  }

  return engine;
}
export type AudioEngine = ReturnType<typeof createEngine>;
