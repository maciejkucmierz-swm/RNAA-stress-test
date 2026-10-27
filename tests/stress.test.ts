import assert from "node:assert/strict";
import test from "node:test";
import { createFaultServer } from "../scripts/stress-server.mjs";
import { defaultStressOptions, stressLimits } from "../src/stress/catalog";
import { stressWave } from "../src/stress/fixtures";
import {
  StressBudgetError,
  StressRunner,
  randomForSeed,
  reportVerdict,
  type StressDependencies,
  type StressReport,
} from "../src/stress/runner";
import { SessionScope } from "../src/workshop/session";
import { CancelledError } from "../src/workshop/types";

function harness(overrides: Partial<StressDependencies> = {}) {
  let saved: StressReport[] = [];
  let scope: SessionScope;
  const runner = new StressRunner({
    environment: () => ({ device: "test" }),
    load: async () => [],
    save: async (reports) => {
      saved = reports;
    },
    exclusive: async (id, task) => {
      scope = new SessionScope(id);
      try {
        await task(scope);
      } finally {
        await scope.dispose();
      }
    },
    execute: async (_id, _options, _scope, probe) => {
      await probe.operation("test", async () => {});
      probe.check(
        "expected output",
        true,
        "Native evidence would be supplied by the driver.",
      );
    },
    ...overrides,
  });
  return { runner, saved: () => saved, scope: () => scope };
}
test("stress seeds replay and ceilings reject unsafe or unsupported profiles", () => {
  const one = randomForSeed(123),
    two = randomForSeed(123);
  assert.deepEqual(
    Array.from({ length: 20 }, one),
    Array.from({ length: 20 }, two),
  );
  assert.throws(
    () => stressLimits("graph-churn", { ...defaultStressOptions, seed: NaN }),
    /Seed/,
  );
  assert.throws(
    () =>
      stressLimits("queue-pressure", {
        ...defaultStressOptions,
        memoryMiB: Infinity,
      }),
    /budget/,
  );
  assert.throws(
    () =>
      stressLimits("graph-churn", {
        ...defaultStressOptions,
        profile: "soak-30",
      }),
    /Recorder/,
  );
  assert.equal(
    stressLimits("recorder-endurance", {
      ...defaultStressOptions,
      profile: "soak-120",
    }).recordingMs,
    7_200_000,
  );
});
test("generated stress WAV declares its exact duration, channel layout, and bounded PCM bytes", () => {
  const bytes = stressWave(15),
    header = new DataView(bytes);
  assert.equal(bytes.byteLength, 44 + 15 * 16000 * 2);
  assert.equal(header.getUint16(22, true), 1);
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint32(40, true), bytes.byteLength - 44);
  assert.equal(header.getInt16(44, true), 0);
});
test("stress keeps manual/native gaps separate and cannot pass them by confirming sound", async () => {
  const { runner } = harness({
    execute: async (_id, _options, _scope, probe) => {
      probe.check("operations", true, "Completed");
      probe.unverified("native deadlines", "Not exposed");
    },
  });
  const report = await runner.start("worklet-budget", defaultStressOptions);
  assert.equal(report.verdict, "inconclusive");
  await runner.review(report.id, 0, "passed", "Sound checked", 45);
  assert.equal(report.verdict, "inconclusive");
  assert.equal(runner.getSnapshot().reports[0].humanEffortSeconds, 45);
});
test("stress interrupted/capped workloads never become passes after manual review", async () => {
  for (const error of [
    new CancelledError("Stop all"),
    new StressBudgetError("Runtime limit"),
  ]) {
    const { runner } = harness({
      execute: async () => {
        throw error;
      },
    });
    const report = await runner.start("graph-churn", defaultStressOptions);
    for (let index = 0; index < report.manual.length; index++)
      await runner.review(report.id, index, "passed", "", 10);
    assert.equal(report.verdict, "inconclusive");
    assert.notEqual(report.phase, "Finished");
  }
});
test("stress bounds logs, records operation accounting, and persists the completed result", async () => {
  const h = harness({
    execute: async (_id, _options, _scope, probe) => {
      for (let index = 0; index < 250; index++) probe.event("bounded", index);
      await probe.operation("completed", async () => {});
      probe.check("workload", true, "Verified");
    },
  });
  const report = await h.runner.start("decode-flood", defaultStressOptions);
  assert.equal(report.verdict, "passed");
  assert.equal(report.events.length, 200);
  assert.equal(report.droppedEvents, 50);
  assert.deepEqual(report.counters, {
    requested: 1,
    completed: 1,
    cancelled: 0,
    failed: 0,
  });
  assert.equal(h.saved()[0].verdict, "passed");
  report.counters.requested++;
  assert.equal(reportVerdict(report), "inconclusive");
});
test("stress restores an interrupted process as inconclusive and retains the failing seed", async () => {
  const h = harness();
  const report = await h.runner.start("decode-flood", defaultStressOptions);
  report.verdict = "running";
  const restored = harness({ load: async () => [report] });
  await restored.runner.initialize();
  assert.equal(
    restored.runner.getSnapshot().reports[0].verdict,
    "inconclusive",
  );
  assert.equal(
    restored.runner.getSnapshot().reports[0].options.seed,
    defaultStressOptions.seed,
  );
  assert.equal(restored.saved()[0].verdict, "inconclusive");
  assert.equal(
    restored.runner.getSnapshot().reports[0].scenario,
    undefined,
    "Older reports need no production fields.",
  );
});
test("parent session cancellation prevents child work from creating late audio", async () => {
  const parent = new SessionScope("stress"),
    nested = new SessionScope("child", parent);
  assert(parent.owns(nested));
  await parent.dispose();
  assert.throws(() => nested.ensureActive(), CancelledError);
});
test("concurrent disposal callers await the same native cleanup barrier", async () => {
  const scope = new SessionScope("concurrent-stop");
  let release!: () => void,
    cleaned = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  scope.defer(async () => {
    await wait;
    cleaned = true;
  });
  const first = scope.dispose(),
    second = scope.dispose();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(cleaned, false);
  release();
  await second;
  assert.equal(cleaned, true);
  await first;
});
test("Stop all while stress report persistence is pending prevents late workload start", async () => {
  let release!: () => void,
    executed = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    save: async () => pending,
    execute: async () => {
      executed = true;
    },
  });
  const running = h.runner.start("decode-flood", defaultStressOptions);
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.runner.cancelPending();
  release();
  const report = await running;
  assert.equal(executed, false);
  assert.equal(report.verdict, "inconclusive");
});
test("stress rejects a second active run and awaits resource cleanup before completion", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    execute: async (_id, _options, scope, probe) => {
      scope.defer(async () => {
        await wait;
      });
      probe.check("load", true, "Done");
    },
  });
  const first = h.runner.start("decode-flood", defaultStressOptions);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    h.runner.start("queue-pressure", defaultStressOptions),
    /active stress/,
  );
  assert(h.runner.getSnapshot().active);
  release();
  await first;
  assert.equal(h.runner.getSnapshot().active, null);
});
test("fault server supports ranges, injects a retryable error, and records only fixture requests", async () => {
  const server = await createFaultServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (await (await fetch(`${base}/health`)).json()).service,
      "rnaa-stress-faults-v1",
    );
    const range = await fetch(`${base}/audio.wav?run=test`, {
      headers: { Range: "bytes=0-43" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 44);
    assert.equal(
      (await fetch(`${base}/audio.wav?fault=retry&run=test`)).status,
      503,
    );
    assert.equal(
      (await fetch(`${base}/audio.wav?fault=retry&run=test`)).status,
      200,
    );
    const stats = await (await fetch(`${base}/stats?run=test`)).json();
    assert.equal(stats.length, 3);
    assert.equal(stats[1].injected, true);
    assert.equal(
      (
        await fetch(`${base}/audio.wav`, {
          headers: { Range: "bytes=999999999-" },
        })
      ).status,
      416,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
