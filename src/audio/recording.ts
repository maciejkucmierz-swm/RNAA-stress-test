import { File } from "expo-file-system";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import { SessionScope } from "../workshop/session";
import {
  BlockedError,
  manual,
  passed,
  type Outcome,
  type Settings,
} from "../workshop/types";
import type { Emit } from "./contracts";
import type { AudioEngine } from "./engine";
import { analyser } from "./graphs";
import {
  checkedResult,
  checkMilliseconds,
  inspectCapabilities,
  n,
  str,
  summary,
} from "./utils";
export async function capture(
  engine: AudioEngine,
  id: string,
  action: string,
  s: Settings,
  scope: SessionScope,
  emit: Emit,
): Promise<Outcome> {
  const permission = await API.AudioManager.requestRecordingPermissions();
  scope.ensureActive();
  if (permission !== "Granted")
    throw new BlockedError(
      "Microphone permission denied. Grant it in system settings, then retry.",
    );
  const rec = engine.record(s);
  let stopped = false;
  let finalizedFiles = 0;
  let starting: Promise<API.Result<unknown>> | null = null;
  let recorderError: Error | null = null;
  const acceptedPaths = new Set<string>();
  const accept = (result: API.FileInfo) => {
    for (const path of result.paths) {
      const file = new File(path);
      emit(
        "fileVerified",
        { exists: file.exists, bytes: file.exists ? file.size : 0 },
        true,
      );
      if (!file.exists || file.size === 0)
        throw new Error("Recorded output file is missing or empty.");
      if (!acceptedPaths.has(path)) {
        acceptedPaths.add(path);
        finalizedFiles++;
      }
    }
    if (result.paths.length) engine.rememberRecording(result);
    emit("fileInfo", result, true);
  };
  const captureSession = { scope, accept, check: action === "check" };
  engine.activeCapture = captureSession;
  const stop = async () => {
    if (starting) await starting;
    if (stopped || (!rec.isRecording() && !rec.isPaused())) return;
    stopped = true;
    const result = await rec.stop();
    checkedResult(result);
    if (result.status === "success") accept(result);
  };
  scope.defer(async () => {
    const errors: unknown[] = [];
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
    if (engine.activeCapture === captureSession) engine.activeCapture = null;
    for (const clear of [
      () => rec.clearOnAudioReady(),
      () => rec.clearOnError(),
      () => rec.disconnect(),
    ])
      try {
        clear();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(errors, "Recorder cleanup failed.");
  });
  // Create the graph context before selecting the capture session category.
  // Otherwise a new live context would restore playback-only session settings.
  if (["record-graph", "record-combined"].includes(id)) engine.live(s);
  if (Platform.OS === "ios") {
    if (!s.productionPreserveSession)
      API.AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "default",
        iosOptions: ["defaultToSpeaker"],
      });
    engine.sessionManagementDisabled = false;
    engine.sessionActivityOwned = true;
    await scope.hold(API.AudioManager.setAudioSessionActivity(true));
    scope.ensureActive();
  }
  rec.onError((error) => {
    if (!scope.alive) return;
    recorderError = new Error(error.message);
    emit("recorderError", error);
    engine.backend.onSessionError(scope, recorderError);
  });
  const fileOutput = ["record-file", "record-combined"].includes(id);
  if (fileOutput) {
    const formatKey = str(s, "format", "Wav");
    const format = API.FileFormat[formatKey as keyof typeof API.FileFormat];
    if (typeof format !== "number")
      throw new BlockedError(`${formatKey} is not published in this backend.`);
    const custom = {
      sampleRate: n(s, "recordRate", 48000),
      bitRate: n(s, "bitRate", 192000),
      bitDepth:
        API.BitDepth[str(s, "bitDepth", "Bit24") as keyof typeof API.BitDepth],
      iosQuality:
        API.IOSAudioQuality[
          str(s, "iosQuality", "High") as keyof typeof API.IOSAudioQuality
        ],
      flacCompressionLevel: n(s, "flacLevel", 5),
    };
    const preset =
      s.preset === "Custom"
        ? custom
        : API.FilePreset[
            str(s, "preset", "High") as keyof typeof API.FilePreset
          ];
    checkedResult(
      rec.enableFileOutput({
        fileNamePrefix: str(s, "fileNamePrefix", "workshop"),
        format,
        preset,
        channelCount: n(s, "channels", 2),
        directory:
          s.directory === "Document"
            ? API.FileDirectory.Document
            : API.FileDirectory.Cache,
        subDirectory: str(s, "subDirectory", "Workshop"),
        rotateIntervalBytes: n(s, "rotateBytes"),
        androidFlushIntervalMs: n(s, "flushMs", 500),
      }),
    );
  } else await rec.disableFileOutput();
  scope.ensureActive();
  let callbacks = 0;
  let validCallbacks = true;
  let lastCallbackTime = -1;
  let callbackFrames = 0,
    invalidCallbacks = 0,
    peakBacklog = 0,
    dropped = 0,
    lastStats = 0;
  const consumerTimers = new Set<ReturnType<typeof setTimeout>>();
  const captureCounters = () =>
    emit(
      "captureCounters",
      {
        callbacks,
        frames: callbackFrames,
        invalid: invalidCallbacks,
        backlog: consumerTimers.size,
        peakBacklog,
        dropped,
      },
      true,
    );
  if (s.stressConsumerDelayMs)
    scope.defer(() => {
      for (const timer of consumerTimers) clearTimeout(timer);
      consumerTimers.clear();
      captureCounters();
    });
  if (["record-pcm", "record-combined", "record-graph"].includes(id))
    checkedResult(
      rec.onAudioReady(
        {
          sampleRate: n(s, "callbackRate", 16000),
          bufferLength: n(s, "bufferLength", 1024),
          channelCount: n(s, "channels", 2),
        },
        (event) => {
          if (!scope.alive) return;
          callbacks++;
          validCallbacks &&=
            event.numFrames > 0 &&
            event.numFrames <= event.buffer.length &&
            Number.isFinite(event.when) &&
            event.buffer.numberOfChannels > 0 &&
            event.buffer.numberOfChannels <= 32 &&
            Number.isFinite(event.buffer.sampleRate) &&
            event.buffer.sampleRate > 0 &&
            event.buffer.getChannelData(0).every(Number.isFinite);
          callbackFrames += event.numFrames;
          if (!validCallbacks) invalidCallbacks++;
          if (s.stressConsumerDelayMs) {
            // Retain a bounded number of PCM buffers for a genuinely delayed consumer.
            // These buffers never enter UI state, history, or exported telemetry.
            if (consumerTimers.size >= 32) dropped++;
            else {
              const buffer = event.buffer;
              const timer = setTimeout(
                () => {
                  try {
                    if (!buffer.getChannelData(0).every(Number.isFinite))
                      invalidCallbacks++;
                  } catch {
                    invalidCallbacks++;
                  }
                  consumerTimers.delete(timer);
                },
                Math.min(1000, n(s, "stressConsumerDelayMs")),
              );
              consumerTimers.add(timer);
              peakBacklog = Math.max(peakBacklog, consumerTimers.size);
            }
            if (Date.now() - lastStats >= 500) {
              lastStats = Date.now();
              captureCounters();
            }
          }
          // Log scalar data at most 10 times per second; never retain PCM buffers.
          if (callbacks === 1 || event.when - lastCallbackTime >= 0.1) {
            lastCallbackTime = event.when;
            emit("audioReady", {
              numFrames: event.numFrames,
              when: event.when,
              ...summary(event.buffer),
            });
          }
        },
      ),
    );
  if (["record-graph", "record-combined"].includes(id)) {
    const env = engine.environment(s, scope, emit);
    // Create an analyser as the recorder's graph destination; a muted sink still pulls audio.
    const tap = env.track(env.context.createGain());
    const analysis = analyser(engine, tap, env, s);
    const mute = env.track(env.context.createGain());
    mute.gain.value = s.monitor ? 1 : 0;
    analysis.connect(mute);
    mute.connect(env.output);
    const adapter = env.track(env.context.createRecorderAdapter());
    adapter.connect(tap);
    rec.connect(adapter);
    await scope.hold(env.context.resume());
    scope.ensureActive();
  }
  starting = Promise.resolve(
    rec.start(
      str(s, "fileName") ? { fileNameOverride: str(s, "fileName") } : undefined,
    ),
  );
  checkedResult(await starting);
  scope.ensureActive();
  emit("recorder", {
    recording: rec.isRecording(),
    paused: rec.isPaused(),
    ...inspectCapabilities(),
  });
  engine.setControls(id, scope, {
    pause: async () => {
      await rec.pause();
      emit("paused", rec.isPaused());
    },
    resume: async () => {
      await rec.resume();
      emit("recording", rec.isRecording());
    },
    "clear-callback": () => {
      rec.clearOnAudioReady();
      emit("callbackCleared");
    },
    disconnect: () => {
      rec.disconnect();
      emit("adapterDisconnected");
    },
    "disable-file": async () => {
      await rec.disableFileOutput();
      emit("fileOutputDisabled");
    },
    inspect: () => {
      emit("recorder", {
        recording: rec.isRecording(),
        paused: rec.isPaused(),
        duration: rec.getCurrentDuration(),
        options: rec.options,
      });
    },
  });
  if (action === "check") {
    await scope.wait(checkMilliseconds(s));
    await stop();
    if (recorderError) throw recorderError;
    const assertions = [
      ...(fileOutput
        ? [{ name: "File output finalized", passed: finalizedFiles > 0 }]
        : []),
      ...(["record-pcm", "record-graph", "record-combined"].includes(id)
        ? [
            { name: "PCM callback received", passed: callbacks > 0 },
            {
              name: "PCM frames/channels/time/data are valid",
              passed: callbacks > 0 && validCallbacks,
            },
          ]
        : []),
    ];
    return passed(
      "Capture completed; replay the output to verify audible content.",
      assertions,
    );
  }
  return manual(
    "Recording is active. Stop to finalize files; replay or inspect the microphone data.",
  );
}
