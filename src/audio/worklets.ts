import * as API from "react-native-audio-api";
import { scheduleOnRN } from "react-native-worklets";
import {
  BlockedError,
  manual,
  type Outcome,
  type Settings,
} from "../workshop/types";
import type { GraphEnvironment } from "./contracts";
import { n, str } from "./utils";
export async function startWorklet(
  id: string,
  action: string,
  settings: Settings,
  env: GraphEnvironment,
): Promise<Outcome> {
  const { context, track, output, scope, emit } = env;
  if (id === "streamer") {
    if (!API.isFfmpegEnabled())
      throw new BlockedError("Streamer requires native FFmpeg.");
    const node = track(context.createStreamer(str(settings, "url")));
    node.connect(output);
    env.bindSource(node);
    node.start();
    if (action === "check") await env.waitCheck();
    return manual(
      "Legacy streamer started. Confirm audible HLS output; external network failures remain possible.",
    );
  }
  const runtime = str(
    settings,
    "runtime",
    "AudioRuntime",
  ) as API.AudioWorkletRuntime;
  let callbacks = 0;
  let valid = true;
  let nonzero = false;
  let lastReport = 0;
  const report = (info: Record<string, number>) => {
    if (!scope.alive) return;
    callbacks++;
    valid &&=
      Object.values(info).every(Number.isFinite) &&
      info.frames > 0 &&
      info.channels > 0;
    nonzero ||= (info.rms ?? 0) > 0;
    if (Date.now() - lastReport < 100) return;
    lastReport = Date.now();
    emit("worklet", { ...info, callbacks, runtime });
  };
  if (id === "worklet-observe") {
    const reporting = { frames: 0 };
    const reportFrames = Math.max(1, Math.round(context.sampleRate / 10));
    emit("workletReporting", {
      maximumReportsPerSecond: 10,
      throttle: "before scheduleOnRN",
      snapshotFrames: n(settings, "bufferLength", 1024),
    });
    const node = track(
      context.createWorkletNode(
        (data, channelCount) => {
          "worklet";
          const channel = data[0];
          let energy = 0;
          for (let i = 0; i < channel.length; i++)
            energy += channel[i] * channel[i];
          reporting.frames += channel.length;
          if (reporting.frames >= reportFrames) {
            reporting.frames %= reportFrames;
            scheduleOnRN(report, {
              channels: channelCount,
              frames: channel.length,
              rms: Math.sqrt(energy / channel.length),
            });
          }
        },
        n(settings, "bufferLength", 1024),
        n(settings, "channels", 2),
        runtime,
      ),
    );
    const source = env.tone();
    source.connect(node);
    node.connect(output);
    source.start();
  } else if (id === "worklet-process") {
    const gain = n(settings, "gain", 0.5),
      sampleRate = context.sampleRate;
    const node = track(
      context.createWorkletProcessingNode((input, output, frames, time) => {
        "worklet";
        let energy = 0;
        for (let ch = 0; ch < output.length; ch++)
          for (let i = 0; i < frames; i++) {
            output[ch][i] = input[ch][i] * gain;
            energy += output[ch][i] * output[ch][i];
          }
        if (
          Math.floor(time * 10) !==
          Math.floor((time - frames / sampleRate) * 10)
        )
          scheduleOnRN(report, {
            channels: output.length,
            frames,
            time,
            rms: Math.sqrt(energy / Math.max(1, frames * output.length)),
          });
      }, runtime),
    );
    const source = env.tone();
    source.connect(node);
    node.connect(output);
    source.start();
  } else if (id === "worklet-source") {
    const frequency = n(settings, "frequency", 440),
      sampleRate = context.sampleRate;
    const node = track(
      context.createWorkletSourceNode((data, frames, time, offset) => {
        "worklet";
        let energy = 0;
        for (let ch = 0; ch < data.length; ch++)
          for (let i = 0; i < frames; i++) {
            data[ch][i] =
              Math.sin(
                2 * Math.PI * frequency * (time + (offset + i) / sampleRate),
              ) * 0.5;
            energy += data[ch][i] * data[ch][i];
          }
        if (
          Math.floor(time * 10) !==
          Math.floor((time - frames / sampleRate) * 10)
        )
          scheduleOnRN(report, {
            channels: data.length,
            frames,
            time,
            offset,
            rms: Math.sqrt(energy / Math.max(1, frames * data.length)),
          });
      }, runtime),
    );
    env.bindSource(node);
    node.connect(output);
    node.start(context.currentTime + 0.01);
  } else
    throw new BlockedError(`${id} is not available in the stable backend.`);
  if (action === "check") {
    await env.waitCheck();
    const assertions = [
      { name: "Worklet callback received", passed: callbacks > 0 },
      {
        name: "Finite callback values and positive frame/channel count",
        passed: callbacks > 0 && valid,
      },
      {
        name: "Expected output energy",
        passed:
          nonzero ||
          (id === "worklet-process" && n(settings, "gain", 0.5) === 0),
      },
    ];
    return {
      status: assertions.every((item) => item.passed) ? "manual" : "failed",
      summary:
        callbacks > 0
          ? "Worklet callbacks received. Confirm sound and displayed data."
          : "No worklet callback observed.",
      assertions,
    };
  }
  return manual(
    "Worklet graph is active. Inspect callback values and confirm output.",
  );
}
