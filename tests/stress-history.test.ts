import assert from "node:assert/strict";
import test from "node:test";
import { reportEncoder } from "../src/stress/history";
import { defaultStressOptions } from "../src/stress/catalog";
import { StressRunner, type StressReport } from "../src/stress/runner";
import { SessionScope } from "../src/workshop/session";

test("checkpoints reuse completed report encoding but encode live progress", () => {
  let encodes = 0;
  const completed = {
    finishedAt: "finished",
    toJSON(this: { finishedAt: string }) {
      encodes++;
      return { finishedAt: this.finishedAt };
    },
  } as unknown as StressReport;
  const active = { phase: "before", verdict: "running" } as StressReport;
  const encode = reportEncoder();
  encode([active, completed]);
  active.phase = "after";
  const saved = JSON.parse(encode([active, completed]));
  assert.equal(encodes, 1);
  assert.equal(saved.reports[0].phase, "after");
  assert.equal(saved.reports.length, 2);
});

test("manual review and notes invalidate only the edited completed report", async () => {
  const encode = reportEncoder();
  let saved = "";
  const runner = new StressRunner({
    environment: () => ({}),
    load: async () => [],
    save: async (reports) => {
      saved = encode(reports);
    },
    exclusive: async (id, task) => {
      const scope = new SessionScope(id);
      try {
        await task(scope);
      } finally {
        await scope.dispose();
      }
    },
    execute: async (_id, _options, _scope, probe) => {
      probe.check("Original finding", false, "Must survive review");
    },
  });
  const report = await runner.start("graph-churn", defaultStressOptions);
  await runner.review(report.id, 0, "passed", "Listened", 3);
  await runner.note(report.id, "Saved manual notes", 4);
  const restored = JSON.parse(saved).reports[0];
  assert.equal(restored.verdict, "failed");
  assert.equal(restored.manual[0].notes, "Listened");
  assert.equal(restored.operatorNotes, "Saved manual notes");
  assert.equal(restored.humanEffortSeconds, 4);
});
