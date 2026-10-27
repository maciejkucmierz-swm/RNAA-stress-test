import { Directory, Paths } from "expo-file-system";
import * as API from "react-native-audio-api";
import { SessionScope } from "../workshop/session";
import { type Settings } from "../workshop/types";
import type { Emit } from "./contracts";
export function n(s: Settings, key: string, fallback = 0) {
  const value = Number(s[key] ?? fallback);
  if (!Number.isFinite(value))
    throw new Error(`${key} must be a finite number.`);
  return value;
}
export function checkMilliseconds(s: Settings) {
  const duration = n(s, "duration", 3);
  if (duration <= 0 || duration > 30)
    throw new Error(
      "Functional checks require a duration above 0 and at most 30 seconds.",
    );
  return duration * 1000;
}
export const str = (s: Settings, key: string, fallback = "") =>
  String(s[key] ?? fallback);
export function json<T>(s: Settings, key: string, fallback: string): T {
  return JSON.parse(str(s, key, fallback)) as T;
}
export function sampleRate(s: Settings) {
  return s.sampleRate === "device" || !s.sampleRate
    ? undefined
    : n(s, "sampleRate");
}
export function ramp(
  param: API.AudioParam,
  value: number,
  context: API.BaseAudioContext,
) {
  param.setTargetAtTime(value, context.currentTime, 0.01);
}
export function checkedResult(result: API.Result<unknown>) {
  if (result.status === "error") throw new Error(result.message);
}
export function rms(data: Float32Array) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, data.length));
}
export function encodeBase64(bytes: Uint8Array) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const bits =
      (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    output +=
      alphabet[bits >>> 18] +
      alphabet[(bits >>> 12) & 63] +
      (i + 1 < bytes.length ? alphabet[(bits >>> 6) & 63] : "=") +
      (i + 2 < bytes.length ? alphabet[bits & 63] : "=");
  }
  return output;
}
export function summary(buffer: API.AudioBuffer) {
  return {
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
    rms: rms(buffer.getChannelData(0)),
  };
}
export function nodeOptions(s: Settings): API.AudioNodeOptions {
  return {
    channelCount: n(s, "channels", 2),
    channelCountMode: str(s, "channelCountMode", "max") as API.ChannelCountMode,
    channelInterpretation: str(
      s,
      "channelInterpretation",
      "speakers",
    ) as API.ChannelInterpretation,
  };
}
export function headers(s: Settings): Record<string, string> {
  const parsed: unknown = json(s, "headers", "{}");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  )
    throw new Error("Headers must be a JSON object with string values.");
  return parsed as Record<string, string>;
}
export function directory() {
  const dir = new Directory(Paths.cache, "audio-workshop");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}
export type Controls = {
  id: string;
  scope: SessionScope;
  actions: Record<string, (s: Settings) => void | Promise<void>>;
};

export function inspectCapabilities() {
  return {
    note: "Stable has pitch-correction node latency; no hardware latency or initial system-volume getter.",
  };
}
export function bindSourceEvents(
  node: API.AudioScheduledSourceNode,
  emit: Emit,
) {
  node.onEnded = (event) => emit("onEnded", event);
  return () => {
    node.onEnded = null;
  };
}
export function bindBufferEvents(
  node: API.AudioBufferSourceNode | API.AudioBufferQueueSourceNode,
  emit: Emit,
  interval: number,
) {
  node.onPositionChangedInterval = interval;
  node.onPositionChanged = (event) => emit("onPositionChanged", event);
  if (node instanceof API.AudioBufferSourceNode)
    node.onLoopEnded = (event) => emit("onLoopEnded", event);
  else node.onBufferEnded = (event) => emit("onBufferEnded", event);
  return () => {
    node.onPositionChanged = null;
    if (node instanceof API.AudioBufferSourceNode) node.onLoopEnded = null;
    else node.onBufferEnded = null;
  };
}
