import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultStressOptions,
  type StressOptions,
} from "../src/stress/catalog";
import {
  featureLoadPlan,
  featureLoadRecipe,
  inlineSettings,
  runFeatureLoad,
  type FeatureLoadDriver,
} from "../src/stress/feature-load";
import { StressRunner, type StressReport } from "../src/stress/runner";
import { companionFor, defaults, features } from "../src/workshop/registry";
import { SessionScope } from "../src/workshop/session";
import { CancelledError } from "../src/workshop/types";

function options(
  id: string,
  extra: Partial<StressOptions> = {},
): StressOptions {
  return { ...defaultStressOptions, targetFeatureId: id, level: 1, ...extra };
}
function harness(
  settings: StressOptions,
  overrides: Partial<FeatureLoadDriver> = {},
) {
  const calls: { id: string; action: string; scope: SessionScope }[] = [];
  let owned: SessionScope | undefined;
  const driver: FeatureLoadDriver = {
    channel: "stable",
    platform: "android",
    idle: async () => {},
    fileBytes: () => 0,
    run: async (id, action, _values, scope) => {
      calls.push({ id, action, scope });
      return {
        status: "passed",
        summary: "Returned",
        assertions: [{ name: "Actual sample check", passed: true }],
      };
    },
    ...overrides,
  };
  const runner = new StressRunner({
    environment: () => ({}),
    load: async () => [],
    save: async () => {},
    exclusive: async (_id, task) => {
      owned = new SessionScope("stress-feature-load");
      try {
        await task(owned);
      } finally {
        await owned.dispose();
      }
    },
    execute: async (_id, runOptions, scope, probe) => {
      // Finish live checks without waiting real seconds; native calls and cleanup are real driver contracts.
      probe.wait = async () => {
        scope.ensureActive();
        if (featureLoadPlan(runOptions).live)
          probe.report.metrics.finishLiveRequested = true;
      };
      await runFeatureLoad(runOptions, scope, probe, driver);
    },
  });
  return {
    runner,
    calls,
    scope: () => owned!,
    start: () => runner.start("feature-load", settings),
  };
}

test("every registered feature has an explicit load recipe and bounded levels", () => {
  assert.equal(features.length, 43);
  for (const feature of features) {
    assert(featureLoadRecipe(feature).description);
    const light = featureLoadPlan(options(feature.id)),
      heavy = featureLoadPlan(options(feature.id, { level: 10 }));
    assert(heavy.cycles > light.cycles);
    assert(heavy.durationMs > light.durationMs);
    assert(heavy.durationMs < 300000);
  }
  for (const level of [0, 11, NaN, 1.5])
    assert.throws(() => featureLoadPlan(options("gain", { level })), /level/);
  assert.throws(() => featureLoadPlan(options("missing")), /existing feature/);
});
test("load levels never multiply gain and memory admission rejects oversized inputs", () => {
  const feature = features.find((item) => item.id === "buffer")!;
  const base = { ...defaults(feature), gain: 0.2 };
  assert.equal(
    inlineSettings(feature, base, options("buffer", { level: 10 })).gain,
    0.2,
  );
  assert.throws(
    () =>
      inlineSettings(
        feature,
        { ...base, frames: 480000, channels: 8 },
        options("buffer", { memoryMiB: 16 }),
      ),
    /budget/,
  );
});
test("repeated permission checks never request or reset permissions", async () => {
  const h = harness(options("permissions", { level: 3 }));
  const report = await h.start();
  assert.equal(h.calls.length, 5);
  assert(h.calls.every((call) => call.action === "inspect"));
  assert.equal(report.manual.length, 1);
  assert.equal(report.verdict, "inconclusive");
});
test("lifecycle rounds dispose each context before another round and run all state checks", async () => {
  let last: SessionScope | undefined;
  const h = harness(options("context", { level: 2 }), {
    run: async (_id, action, _values, scope) => {
      if (action === "create") {
        if (last) assert.equal(last.alive, false);
        last = scope;
      }
      return { status: "passed", summary: action };
    },
  });
  const report = await h.start();
  assert.equal(report.metrics.completedRounds, 3);
  assert.equal(report.counters.completed, 15);
  assert.equal(last?.alive, false);
  assert.equal(report.verdict, "passed");
});
test("a failed native assertion fails the report and prevents further rounds", async () => {
  let calls = 0;
  const h = harness(options("buffer", { level: 5 }), {
    run: async () => {
      calls++;
      return {
        status: "failed",
        summary: "Wrong samples",
        assertions: [{ name: "Samples match", passed: false }],
      };
    },
  });
  const report = await h.start();
  assert.equal(calls, 1);
  assert.equal(report.verdict, "failed");
  assert(
    report.checks.some(
      (check) =>
        check.name.includes("Samples match") && check.status === "failed",
    ),
  );
});
test("unavailable APIs and over-budget recordings never start native work", async () => {
  const absent = harness(options("recording-notification"), {
    platform: "ios",
  });
  assert.equal((await absent.start()).verdict, "blocked");
  assert.equal(absent.calls.length, 0);
  const big = harness(options("record-combined", { level: 10, fileMiB: 8 }));
  assert.equal((await big.start()).verdict, "blocked");
  assert.equal(big.calls.length, 0);
});
test("recording notification Stop ends its live session without starting a new recorder", async () => {
  const calls: string[] = [];
  const h = harness(
    options("recording-notification", { level: 10, loadMode: "live" }),
    {
      run: async (id, action, _values, _scope, emit) => {
        calls.push(`${id}:${action}`);
        if (id === "recording-notification") {
          emit("fileInfo", { paths: ["test.wav"] });
          emit("recordingNotificationStop");
        }
        return { status: "manual", summary: "Observe" };
      },
    },
  );
  const report = await h.start();
  assert.deepEqual(calls, ["record-file:start", "recording-notification:show"]);
  assert.equal(report.metrics.endedByNativeControl, true);
  assert.equal(report.verdict, "inconclusive");
  assert(report.manual.some((check) => check.verdict === "pending"));
});
test("cancellation during an asynchronous operation waits for it before cleanup and never starts another round", async () => {
  let release!: () => void,
    cleanup = false,
    calls = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness(options("decode", { level: 5 }), {
    run: async (_id, _action, _values, scope) => {
      calls++;
      scope.defer(() => {
        cleanup = true;
      });
      await waiting;
      return { status: "passed", summary: "Decoded" };
    },
  });
  const running = h.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = h.scope().dispose();
  assert.equal(cleanup, false);
  release();
  await stopping;
  assert.equal(cleanup, true);
  const report = await running;
  assert.equal(calls, 1);
  assert.equal(report.verdict, "inconclusive");
  assert.throws(() => h.scope().ensureActive(), CancelledError);
});
test("report freezes settings and native fallback remains a failure", async () => {
  const settings = { fixture: "stereo.ogg", input: "local" };
  const h = harness(options("metadata", { targetSettings: settings }), {
    run: async (_id, _action, _values, _scope, emit) => {
      emit("metadata", {
        duration: 3,
        nativeDuration: 0,
        source: "decoded-fallback",
      });
      return { status: "passed", summary: "Fallback works" };
    },
  });
  const report = await h.start();
  settings.fixture = "stereo.wav";
  assert.equal(report.options.targetSettings?.fixture, "stereo.ogg");
  assert.equal(report.verdict, "failed");
});
test("app/background evidence is bounded and manual finish cannot finish a repeated workload", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness(options("buffer"), {
    run: async () => {
      await waiting;
      return { status: "passed", summary: "OK" };
    },
  });
  const running = h.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 250; index++)
    h.runner.observe("appState", "background");
  h.runner.finishLive();
  assert.notEqual(
    h.runner.getSnapshot().active?.metrics.finishLiveRequested,
    true,
  );
  release();
  const report: StressReport = await running;
  assert(report.events.length <= 200);
  assert(report.droppedEvents > 0);
});

test("saved inline settings and effective-settings events exclude authentication headers", async () => {
  const h = harness(
    options("decode", {
      targetSettings: {
        fixture: "stereo.wav",
        input: "local",
        headers: '{"Authorization":"example-secret"}',
      },
    }),
  );
  const report = await h.start();
  assert.equal(report.options.targetSettings?.headers, undefined);
  assert(!JSON.stringify(report.events).includes("example-secret"));
});

test("live PCM recording does not silently pass missing or invalid callbacks", async () => {
  const missing = harness(options("record-pcm", { loadMode: "live" }));
  assert.equal((await missing.start()).verdict, "failed");
  const invalid = harness(options("record-pcm", { loadMode: "live" }), {
    run: async (_id, _action, _values, _scope, emit) => {
      emit("audioReady", { numFrames: 1024, when: 0, rms: NaN });
      return { status: "manual", summary: "Capture" };
    },
  });
  const report = await invalid.start();
  assert.equal(report.verdict, "failed");
  assert.equal(report.metrics.captureEvents, 1);
});
test("cancelling a round also awaits native idle cleanup before replacement can proceed", async () => {
  let release!: () => void,
    idleStarted = false,
    stopped = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness(options("buffer", { level: 2 }), {
    idle: async () => {
      idleStarted = true;
      await waiting;
    },
  });
  const running = h.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(idleStarted);
  const stopping = h
    .scope()
    .dispose()
    .then(() => {
      stopped = true;
    });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  const report = await running;
  assert.equal(h.calls.length, 1);
  assert.equal(report.verdict, "inconclusive");
});

test("registry companion rules apply consistently to runner choices", () => {
  for (const feature of features) {
    assert.equal(
      featureLoadPlan(options(feature.id)).companion,
      companionFor(feature),
    );
    assert.equal(
      featureLoadPlan(options(feature.id, { companion: "recording" }))
        .companion,
      companionFor(feature, "recording"),
    );
  }
  const notification = features.find(
    (feature) => feature.id === "recording-notification",
  )!;
  assert.equal(companionFor(notification, "playback"), "recording");
});
test("repeated children do not accumulate cleanup closures on their parent", async () => {
  let registrations = 0;
  const h = harness(options("buffer", { level: 10 }), {
    run: async (_id, _action, _values, scope) => {
      const root = scope.parent! as unknown as { cleanups: Set<unknown> };
      registrations = Math.max(registrations, root.cleanups.size);
      return { status: "passed", summary: "Data checked" };
    },
  });
  const report = await h.start();
  assert.equal(report.metrics.completedRounds, 200);
  assert.equal(
    registrations,
    1,
    "Only the currently live child owns a parent cleanup",
  );
});
