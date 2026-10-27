import assert from "node:assert/strict";
import test from "node:test";
import type { GraphEnvironment } from "../src/audio/contracts";
import type { startWorklet } from "../src/audio/worklets";
import { SessionScope } from "../src/workshop/session";
import { loadModule } from "./helpers/load-module";

test("RMS observation bounds messages before scheduling onto app JavaScript", async () => {
  let callback!: (data: Float32Array[], channels: number) => void;
  let messages = 0;
  const module = loadModule("src/audio/worklets.ts", {
    "react-native-audio-api": {},
    "react-native-worklets": {
      scheduleOnRN: (report: (value: unknown) => void, value: unknown) => {
        messages++;
        report(value);
      },
    },
    "expo-file-system": {},
    "expo-constants": {},
    "react-native": {},
    "./fixtures": {},
  }) as { startWorklet: typeof startWorklet };
  const scope = new SessionScope("worklet-observe");
  const source = { connect() {}, start() {} };
  const env = {
    scope,
    context: {
      sampleRate: 48000,
      createWorkletNode(fn: typeof callback) {
        callback = fn;
        return source;
      },
    },
    track: (node: unknown) => node,
    tone: () => source,
    output: {},
    emit() {},
  } as unknown as GraphEnvironment;
  await module.startWorklet(
    "worklet-observe",
    "start",
    { bufferLength: 128, channels: 1 },
    env,
  );
  for (let index = 0; index < 1000; index++)
    callback([new Float32Array(128).fill(0.1)], 1);
  assert.equal(messages, Math.floor(128000 / 4800));
  await scope.dispose();
});
