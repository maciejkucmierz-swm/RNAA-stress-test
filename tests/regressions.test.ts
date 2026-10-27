import assert from "node:assert/strict";
import test from "node:test";
import { defaultStressOptions } from "../src/stress/catalog";
import {
  StressBudgetError,
  StressRunner,
  reportVerdict,
} from "../src/stress/runner";
import { SessionScope } from "../src/workshop/session";
import { BlockedError, CancelledError } from "../src/workshop/types";
import { productionHarness } from "./helpers/production";

for (const error of [
  new CancelledError("Stop"),
  new StressBudgetError("Limit"),
  new BlockedError("Blocked"),
]) {
  test(`a failure stays Failed after ${error.constructor.name}`, async () => {
    const runner = new StressRunner({
      environment: () => ({}),
      load: async () => [],
      save: async () => {},
      exclusive: async (id, task) => {
        const scope = new SessionScope(id);
        try {
          await task(scope);
        } finally {
          await scope.dispose();
        }
      },
      execute: async (_id, _options, _scope, probe) => {
        probe.check("Original failure", false, "Keep this finding");
        throw error;
      },
    });
    const report = await runner.start("decode-flood", defaultStressOptions);
    assert.equal(report.verdict, "failed");
    assert.equal(reportVerdict(report), "failed");
    assert(report.completionReason);
    const restored = new StressRunner({
      environment: () => ({}),
      load: async () => [{ ...report, verdict: "running" }],
      save: async () => {},
      exclusive: async () => {},
      execute: async () => {},
    });
    await restored.initialize();
    assert.equal(restored.getSnapshot().reports[0].verdict, "failed");
  });
}
test("completed waits and children release their cleanup registrations", async () => {
  const root = new SessionScope("root");
  for (let index = 0; index < 100; index++) {
    await root.wait(0);
    await new SessionScope("child", root).dispose();
  }
  const registrations = root as unknown as { cleanups: Set<unknown> };
  assert.equal(registrations.cleanups.size, 0);
  await root.dispose();
});
test("completed and cancelled feature timers release registrations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new SessionScope("timers");
  let calls = 0;
  scope.timeout(() => calls++, 10);
  t.mock.timers.tick(10);
  assert.equal(calls, 1);
  assert.equal(
    (scope as unknown as { cleanups: Set<unknown> }).cleanups.size,
    0,
  );
  scope.timeout(() => calls++, 10);
  await scope.dispose();
  t.mock.timers.tick(10);
  assert.equal(calls, 1);
});
test("recovery requests made during pressure are ignored instead of queued", async (t) => {
  let requested = false;
  const h = productionHarness(
    t,
    "pressure",
    "worklet-source",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !requested) {
        requested = true;
        controller.signal("new-session");
      }
    },
  );
  const report = await h.start();
  assert(!report.events.some((event) => event.name === "newSessionRequested"));
});
test("a later Stop clears an unexecuted recovery restart", async (t) => {
  let sent = false;
  const h = productionHarness(
    t,
    "pressure",
    "worklet-source",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "recovery" && !sent) {
        sent = true;
        controller.signal("new-session");
        controller.signal("stop-audio");
      }
    },
  );
  const report = await h.start();
  assert(sent);
  assert(!report.events.some((event) => event.name === "newSessionRequested"));
});
test("Core graph recovery cannot claim progress without callbacks", async (t) => {
  const h = productionHarness(t, "pressure", "graph", 6, {
    run: async () => ({ status: "passed", summary: "Accepted without output" }),
  });
  const report = await h.start();
  assert.equal(report.metrics.audioCallbacks, 0);
  assert(report.scenario?.recovery.every((recovery) => !recovery.observed));
  assert.equal(report.verdict, "inconclusive");
});
test("an audio event at the deadline does not throw through its callback", async (t) => {
  let injected = false;
  const h = productionHarness(
    t,
    "pressure",
    "worklet-source",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !injected) {
        injected = true;
        t.mock.timers.tick(300000);
        assert.doesNotThrow(() => controller.observe("position", 1));
      }
    },
  );
  const report = await h.start();
  assert(injected);
  assert.equal(report.completionReason, "limit");
});
