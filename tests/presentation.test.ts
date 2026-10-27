import assert from "node:assert/strict";
import test from "node:test";
import {
  basicFields,
  primaryActions,
  resultSummary,
  transportPaused,
} from "../src/workshop/presentation";
import { features } from "../src/workshop/registry";
import type { TestResult } from "../src/workshop/types";
test("default controls keep every feature reachable and expose Stop on active demos", () => {
  for (const feature of features) {
    const keys = basicFields(feature);
    assert(keys.length <= 3);
    assert(
      keys.every((key) => feature.fields.some((field) => field.key === key)),
    );
    if (feature.actions.some((action) => action.id === "start")) {
      assert.deepEqual(primaryActions(feature, false, false), ["start"]);
      assert(primaryActions(feature, true, false).includes("stop"));
    }
  }
});
test("simple summaries never hide failure behind a saved recording or successful start label", () => {
  const result = {
    status: "failed",
    summary: "Native recording failed",
    action: "start-with-audio",
    events: [{ name: "fileInfo", value: { paths: ["test.wav"], duration: 3 } }],
  } as TestResult;
  assert.equal(resultSummary(result), "Native recording failed");
  result.status = "manual";
  assert.match(resultSummary(result), /Recording saved/);
  result.status = "blocked";
  result.summary = "Microphone denied";
  assert.equal(resultSummary(result), "Microphone denied");
});
test("a suspended playback engine cannot make an active microphone recording look paused", () => {
  const feature = features.find((item) => item.id === "record-file")!;
  assert.equal(
    transportPaused(feature, {
      context: { state: "suspended" },
      recordingPaused: false,
    }),
    false,
  );
  assert.equal(
    transportPaused(feature, {
      context: { state: "running" },
      recordingPaused: true,
    }),
    true,
  );
});
test("an exhausted queue offers explicit Play rather than a misleading Resume", () => {
  const feature = features.find((item) => item.id === "queue")!;
  assert.deepEqual(primaryActions(feature, true, true, true), [
    "start",
    "stop",
  ]);
  assert.deepEqual(primaryActions(feature, true, true, false), [
    "resume",
    "stop",
  ]);
});
