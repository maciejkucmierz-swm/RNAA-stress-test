import test from "node:test";
import assert from "node:assert/strict";
import type { executeNativeStress as ExecuteNativeStress } from "../src/audio/stress";
import { loadModule } from "./helpers/load-module";
import type { NativeStressPort } from "../src/audio/contracts";
import { StressRunner } from "../src/stress/runner";
import { SessionScope } from "../src/workshop/session";
import { defaultStressOptions } from "../src/stress/catalog";

test("a clean source cannot pass recovery of the original failed stream", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("/health")
      ? { service: "rnaa-stress-faults-v1" }
      : ["slow", "stall", "truncate", "retry"].map((fault) => ({
          fault,
          injected: true,
        }));
    return { ok: true, json: async () => body } as Response;
  });
  const { executeNativeStress } = loadModule("src/audio/stress.ts", {
    "react-native-audio-api": {},
    "react-native": { Platform: { OS: "android" } },
    "react-native-worklets": { scheduleOnRN() {} },
    "expo-file-system": {},
    "./fixtures": {},
  }) as { executeNativeStress: typeof ExecuteNativeStress };
  const port = {
    backend: {
      mediaContext: { state: "running" },
      run: async (
        _id: string,
        action: string,
        settings: Record<string, unknown>,
        _scope: SessionScope,
        emit: (name: string, value?: unknown) => void,
      ) => {
        if (action === "start") {
          if (/fault=(truncate|retry)/.test(String(settings.url)))
            emit("error", new Error("Injected fault"));
          else {
            emit("load");
            emit("position", 1);
            emit("play");
          }
        }
        return { status: "manual", summary: "Mock media event delivery" };
      },
    },
  } as unknown as NativeStressPort;
  const runner = new StressRunner({
    environment: () => ({}),
    load: async () => [],
    save: async () => {},
    exclusive: async (id, task) => {
      const root = new SessionScope(id);
      try {
        await task(root);
      } finally {
        await root.dispose();
      }
    },
    execute: async (id, options, root, probe) => {
      probe.wait = async () => {
        root.ensureActive();
      };
      await executeNativeStress(id, options, root, probe, port);
    },
  });
  const report = await runner.start("streaming-recovery", defaultStressOptions);
  const original = report.checks.filter((check) =>
    check.name.includes("original-source recovery"),
  );
  assert.equal(original.length, 2);
  assert(original.every((check) => check.status === "unverified"));
  assert(
    report.checks.some(
      (check) =>
        check.name.includes("separate normal-source usability") &&
        check.status === "passed",
    ),
  );
  assert.equal(report.verdict, "inconclusive");
  assert(
    report.events.some((event) => event.name === "originalStreamingOutcome"),
  );
});
