import assert from "node:assert/strict";
import test from "node:test";
import { applicableScenarios } from "../src/production/catalog";
import {
  environmentProfile,
  environments,
} from "../src/production/environment";
import { manualChecks } from "../src/production/manual";
import { defaultStressOptions, stressLimits } from "../src/stress/catalog";
import { features } from "../src/workshop/registry";

test("environments bound CPU/RAM/JS delays on both low-core and many-core targets", () => {
  for (const cores of [1, 2, 8, 24])
    for (let level = 1; level <= 10; level++)
      for (const environment of environments) {
        const p = environmentProfile(level, cores, environment.id);
        assert(p.workers >= 0 && p.workers <= cores);
        assert(p.duty >= 0 && p.duty <= 0.85);
        assert(p.memoryMiB >= 0 && p.memoryMiB <= 128);
        assert(p.jsStallMs <= 2000);
        assert(p.commandLatencyMs <= 1500);
        assert.equal(p.expirySeconds, 180);
      }
  assert.equal(environmentProfile(1, 8, "cpu").workers, 2);
  assert.equal(environmentProfile(1, 8, "cpu").memoryMiB, 0);
  assert.equal(environmentProfile(1, 8, "memory").memoryMiB, 128);
  assert.equal(environmentProfile(1, 8, "js").workers, 0);
  assert.equal(environmentProfile(1, 8, "latency").commandLatencyMs, 750);
  assert.throws(() => environmentProfile(1, 8, "pretend-hot"), /supported/);
});
test("all ten manual priorities have a real feature, plain instructions, and applicable scenarios", () => {
  assert.equal(Object.keys(manualChecks).length, 10);
  assert.deepEqual(
    Object.values(manualChecks)
      .map((item) => item.rank)
      .sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  for (const [id, guide] of Object.entries(manualChecks)) {
    const feature = features.find((item) => item.id === id)!;
    assert(feature);
    assert(applicableScenarios(feature).some((item) => item.id === "pressure"));
    assert(guide.steps.length > 30 && guide.expected.length > 30);
  }
});
test("old report options remain valid and unknown environments are rejected before a run", () => {
  const options = {
    ...defaultStressOptions,
    scenarioId: "pressure",
    targetFeatureId: "context",
    level: 6,
  };
  assert(stressLimits("production-case", options).runtimeMs <= 300000);
  assert.throws(
    () =>
      stressLimits("production-case", {
        ...options,
        environmentProfile: "unknown",
      }),
    /supported/,
  );
});
