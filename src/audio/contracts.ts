import type * as API from "react-native-audio-api";
import type { StressId, StressOptions } from "../stress/catalog";
import type { StressProbe } from "../stress/runner";
import type { SessionScope } from "../workshop/session";
import type { Outcome, Settings } from "../workshop/types";

// Finalization reports are owned cleanup results, rather than late playback callbacks.
export type Emit = (
  name: string,
  value?: unknown,
  finalization?: boolean,
) => void;
export interface MediaRequest {
  key: string;
  source: string;
  settings: Settings;
  route: boolean;
}
export interface BackendSnapshot {
  queue?: {
    state: "playing" | "paused" | "empty";
    queuedBuffers: number;
    currentFixture: string | null;
  } | null;
  context: { state: string; sampleRate: number; currentTime: number } | null;
  media: MediaRequest | null;
  recordings: { paths: string[]; duration: number; size: number }[];
  devices: { id: string; name: string; category: string }[];
  plot: { waveform: number[]; spectrum: number[] } | null;
}
export interface Backend {
  readonly snapshot: BackendSnapshot;
  readonly channel: "stable";
  readonly formats: string[];
  readonly mediaContext: API.AudioContext | null;
  onChange: () => void;
  onSessionEnded: (scope: SessionScope) => void;
  onSessionError: (scope: SessionScope, error: unknown) => void;
  run(
    id: string,
    action: string,
    settings: Settings,
    scope: SessionScope | null,
    emit: Emit,
  ): Promise<Outcome>;
  applyScenarioIntent(
    intent: {
      playing: boolean;
      needsUser: boolean;
      interrupted?: boolean;
      gain: number;
      muted: boolean;
    },
    recording: boolean,
  ): Promise<void>;
  scenarioState(): Record<string, unknown>;
  idle(): Promise<void>;
  runStress(
    id: StressId,
    options: StressOptions,
    scope: SessionScope,
    probe: StressProbe,
  ): Promise<void>;
  restoreRecordings(): Promise<void>;
  attachMedia(handle: API.AudioTagHandle | null, key?: string): void;
  mediaEvent(name: string, value?: unknown, key?: string): void;
  selectInput(id: string): Promise<void>;
  selectHookInput(
    input: ReturnType<typeof API.useAudioInput>,
    device: API.AudioDeviceInfo,
  ): Promise<void>;
  playRecording(
    path: string,
    scope: SessionScope,
    emit: Emit,
  ): Promise<Outcome>;
  deleteRecording(paths: string[]): void;
}
export interface GraphEnvironment {
  context: API.AudioContext;
  scope: SessionScope;
  emit: Emit;
  output: API.GainNode;
  track<T extends API.AudioNode>(node: T): T;
  trackedCount(): number;
  tone(): API.OscillatorNode;
  bindSource(node: API.AudioScheduledSourceNode, keepTransport?: boolean): void;
  controls(
    actions: Record<string, (settings: Settings) => void | Promise<void>>,
  ): void;
  waitCheck(): Promise<void>;
}
export interface NativeStressPort {
  backend: Backend;
  context(settings?: Settings): API.AudioContext;
  recorder(settings: Settings): API.AudioRecorder;
  environment(
    settings: Settings,
    scope: SessionScope,
    emit: Emit,
  ): GraphEnvironment;
  dispatchPlayback(name: string): Promise<void>;
}
