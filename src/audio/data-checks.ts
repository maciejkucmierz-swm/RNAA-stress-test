import Constants from "expo-constants";
import { File } from "expo-file-system";
import * as API from "react-native-audio-api";
import { SessionScope } from "../workshop/session";
import { passed, type Outcome, type Settings } from "../workshop/types";
import type { Emit } from "./contracts";
import type { AudioEngine } from "./engine";
import { fixtureMetadata, fixturePath } from "./fixtures";
import { input } from "./inputs";
import {
  directory,
  encodeBase64,
  headers,
  inspectCapabilities,
  n,
  rms,
  str,
  summary,
} from "./utils";
export async function runDataCheck(
  engine: AudioEngine,
  id: string,
  action: string,
  s: Settings,
  scope: SessionScope | null,
  emit: Emit,
): Promise<Outcome> {
  if (id === "context") {
    if (action === "create") {
      if (engine.context && engine.context.state !== "closed")
        await engine.requireScope(scope).hold(engine.context.close());
      engine.requireScope(scope).ensureActive();
      engine.context = null;
      engine.live(s);
    }
    if (action === "pause" || action === "resume") {
      const ctx = engine.live();
      engine.contextActivityUpdate =
        action === "pause" ? ctx.suspend() : ctx.resume();
      await (scope?.alive
        ? scope.hold(engine.contextActivityUpdate)
        : engine.contextActivityUpdate);
    }
    if (action === "close") {
      if (engine.context && engine.context.state !== "closed")
        await engine.requireScope(scope).hold(engine.context.close());
      engine.requireScope(scope).ensureActive();
      engine.context = null;
    }

    emit("context", engine.inspect());
    const expected =
      action === "close"
        ? null
        : action === "pause"
          ? "suspended"
          : action === "resume"
            ? "running"
            : undefined;
    return passed(
      "Context operation completed.",
      expected === undefined
        ? []
        : [
            {
              name: "Lifecycle state",
              passed: (engine.context?.state ?? null) === expected,
            },
          ],
    );
  }
  if (id === "capabilities") {
    emit("build", {
      version: Constants.expoConfig?.extra,
      ffmpeg: API.isFfmpegEnabled(),
      devicePreferredSampleRate:
        API.AudioManager.getDevicePreferredSampleRate(),
      formats: engine.backend.formats,
      ...inspectCapabilities(),
    });
    return passed("Native build capabilities inspected.");
  }
  if (id === "buffer") {
    if (
      !Number.isInteger(n(s, "frames", 128)) ||
      n(s, "frames", 128) < 2 ||
      n(s, "frames", 128) > 480000
    )
      throw new Error("Use 2–480000 frames for this functional check.");
    const buffer = s.useContext
      ? engine
          .live()
          .createBuffer(
            n(s, "channels", 2),
            n(s, "frames", 128),
            n(s, "sampleRate", 48000),
          )
      : new API.AudioBuffer({
          numberOfChannels: n(s, "channels", 2),
          length: n(s, "frames", 128),
          sampleRate: n(s, "sampleRate", 48000),
        });
    const data = new Float32Array(buffer.length);
    for (let i = 0; i < data.length; i++) data[i] = i / data.length;
    buffer.copyToChannel(data, 0);
    const copy = new Float32Array(buffer.length);
    buffer.copyFromChannel(copy, 0);
    const equal = copy.every((value, i) => value === data[i]);
    emit("buffer", summary(buffer));
    return passed("Channel copy and access checked.", [
      { name: "Exact channel copy", passed: equal },
      {
        name: "Direct access agrees",
        passed: buffer.getChannelData(0)[1] === data[1],
      },
    ]);
  }
  if (id === "decode" || id === "metadata") {
    const value = await input(s);
    if (id === "metadata") {
      if (typeof value === "number")
        throw new Error("Metadata does not accept asset IDs.");
      const nativeDuration = await API.getAudioDuration(value, {
        headers: headers(s),
      });
      // A failed metadata result must stay visible. Decoding is a separate feature.
      const duration = nativeDuration;
      emit("metadata", { duration, nativeDuration, source: "metadata" });
      const expected = fixtureMetadata[str(s, "fixture", "stereo.wav")];
      return passed("Native duration returned without a decoding fallback.", [
        {
          name: "Finite positive duration",
          passed: Number.isFinite(duration) && duration > 0,
        },
        ...(s.input !== "url"
          ? [
              {
                name: "Expected fixture duration",
                passed: Math.abs(duration - expected.duration) < 0.15,
              },
            ]
          : []),
      ]);
    }
    const buffer = s.useContext
      ? await engine.live().decodeAudioData(value, { headers: headers(s) })
      : await API.decodeAudioData(value, n(s, "targetRate") || undefined, {
          headers: headers(s),
        });
    const info = summary(buffer);
    emit("decoded", info);
    const expected = fixtureMetadata[str(s, "fixture", "stereo.wav")];
    return passed("Decoded audio inspected.", [
      {
        name: "Finite sample data",
        passed: buffer.getChannelData(0).every(Number.isFinite),
      },
      { name: "Nonempty buffer", passed: buffer.length > 0 },
      ...(s.input !== "url"
        ? [
            {
              name: "Expected channels",
              passed: info.channels === expected.channels,
            },
            {
              name: "Fixture duration within 0.15 s",
              passed: Math.abs(info.duration - expected.duration) < 0.15,
            },
          ]
        : []),
    ]);
  }
  if (id === "pcm") {
    const count = n(s, "channels", 2),
      rate = n(s, "sampleRate", 16000),
      frames = 256;
    if (!Number.isInteger(count) || count < 1 || count > 8)
      throw new Error(
        "Use an integer channel count from 1–8 for this functional fixture.",
      );
    const bytes = new Uint8Array(frames * count * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < frames; i++)
      for (let ch = 0; ch < count; ch++)
        view.setInt16(
          (s.interleaved ? i * count + ch : ch * frames + i) * 2,
          1000 * (ch + 1),
          true,
        );
    const data = encodeBase64(bytes);
    const buffer = s.useContext
      ? await engine
          .live()
          .decodePCMInBase64(data, rate, count, !!s.interleaved)
      : await API.decodePCMInBase64(data, rate, count, !!s.interleaved);
    emit("pcm", summary(buffer));
    return passed("Signed 16-bit PCM layout checked.", [
      { name: "Frame count", passed: buffer.length === frames },
      {
        name: "Channel count",
        passed: buffer.numberOfChannels === count,
      },
      {
        name: "PCM value conversion",
        passed: Math.abs(buffer.getChannelData(0)[0] - 1000 / 32768) < 0.0001,
      },
    ]);
  }
  if (id === "concat") {
    const path = await fixturePath(str(s, "fixture", "stereo.wav"));
    const output = new File(
      directory(),
      `joined-${Date.now()}.${str(s, "fixture", "stereo.wav").split(".").pop()}`,
    );
    await API.concatAudioFiles([path, path], output.uri);
    const duration = await API.getAudioDuration(output.uri);
    emit("joined", { path: output.uri, duration, bytes: output.size });
    engine.rememberRecording({
      paths: [output.uri],
      duration,
      size: output.size / 1e6,
    });
    return passed("Joined two matching segments.", [
      { name: "Output exists", passed: output.exists },
      {
        name: "Combined duration ≈ 6 s",
        passed: Math.abs(duration - 6) < 0.3,
      },
    ]);
  }
  if (id === "errors") {
    const assertions = [
      {
        name: "Invalid buffer length",
        run: () => new API.AudioBuffer({ length: 0, sampleRate: 48000 }),
        expected: API.NotSupportedError,
      },
      {
        name: "Invalid buffer channel access",
        run: () =>
          new API.AudioBuffer({
            length: 128,
            sampleRate: 48000,
          }).getChannelData(-1),
        expected: API.IndexSizeError,
      },
      {
        name: "Invalid IIR coefficients",
        run: () => engine.live().createIIRFilter([], [1]),
        expected: API.NotSupportedError,
      },
    ].map(({ name, run, expected }) => {
      try {
        run();
        return { name, passed: false, detail: "Unexpected success." };
      } catch (error) {
        emit("validationError", {
          name,
          expected: expected.name,
          actual: String(error),
        });
        return {
          name,
          passed: error instanceof expected,
          detail: String(error),
        };
      }
    });
    return passed("Representative validation checks completed.", assertions);
  }
  const active = engine.requireScope(scope);
  const rate = n(s, "sampleRate", 48000),
    seconds = n(s, "duration", 3),
    frames = Math.round(rate * seconds);
  if (seconds <= 0 || seconds > 30)
    throw new Error("Offline functional checks must be 0–30 seconds.");
  const offline = new API.OfflineAudioContext({
    numberOfChannels: n(s, "channels", 2),
    length: frames,
    sampleRate: rate,
  });
  const source = offline.createOscillator();
  const gain = offline.createGain();
  gain.gain.value = 0.5;
  source.connect(gain);
  gain.connect(offline.destination);
  source.start();
  active.defer(() => {
    source.disconnect();
    gain.disconnect();
  });
  let suspension: Promise<unknown> | undefined;
  if (s.suspend)
    suspension = offline.suspend(n(s, "duration", 3) / 2).then(async () => {
      emit("offlineSuspended", offline.currentTime);
      await offline.resume();
    });
  const buffer = await offline.startRendering();
  if (suspension) await suspension;
  active.ensureActive();
  emit("rendered", summary(buffer));
  return passed("Offline graph rendered.", [
    { name: "Exact frame length", passed: buffer.length === frames },
    {
      name: "Finite nonzero output",
      passed:
        rms(buffer.getChannelData(0)) > 0 &&
        buffer.getChannelData(0).every(Number.isFinite),
    },
    {
      name: "Sine at half gain has expected RMS",
      passed:
        Math.abs(rms(buffer.getChannelData(0)) - Math.SQRT1_2 * 0.5) < 0.02,
    },
  ]);
}
