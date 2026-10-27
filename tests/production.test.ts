import assert from "node:assert/strict";
import test from "node:test";
import {
  androidOwnsFocusedWindow,
  simulatorAppAlive,
  watchdogDecision,
} from "../scripts/production-evidence.mjs";
import {
  applicableScenarios,
  pressureProfile,
  type NativeSnapshot,
} from "../src/production/catalog";
import { initialIntent, reduceIntent } from "../src/production/intent";
import { manualChecks } from "../src/production/manual";
import { defaultStressOptions } from "../src/stress/catalog";
import { features } from "../src/workshop/registry";
import { productionHarness as harness } from "./helpers/production";

test("production levels express actual pressure and all features have relevant scenarios or diagnostics", () => {
  assert.deepEqual(pressureProfile(1, 8), {
    rounds: 1,
    workers: 0,
    duty: 0,
    memoryMiB: 0,
    jsStallMs: 0,
    expirySeconds: 180,
  });
  assert.equal(pressureProfile(5, 8).rounds, 5);
  assert.equal(pressureProfile(6, 8).workers, 1);
  assert.equal(pressureProfile(7, 8).workers, 4);
  assert.equal(pressureProfile(8, 8).workers, 8);
  assert.equal(pressureProfile(9, 8).jsStallMs, 500);
  assert.equal(pressureProfile(10, 8).jsStallMs, 2000);
  for (const feature of features)
    assert(
      applicableScenarios(feature).length > 0 ||
        ["permissions", "capabilities"].includes(feature.id),
    );
});
test("user Stop overrides delayed interruption end and recording always needs explicit Resume", () => {
  let playback = reduceIntent(initialIntent(false), "interrupt");
  playback = reduceIntent(playback, "stop");
  playback = reduceIntent(playback, "temporary-end", true);
  assert.equal(playback.playing, false);
  assert.equal(playback.resumeAllowed, false);
  let recording = reduceIntent(initialIntent(true), "interrupt");
  recording = reduceIntent(recording, "temporary-end", true);
  assert.equal(recording.needsUser, true);
  assert.equal(recording.resumeAllowed, false);
  assert.equal(reduceIntent(recording, "resume").needsUser, false);
});
test("volume and mute retain latest user intent across interruption and reset", () => {
  let state = reduceIntent(initialIntent(false), "interrupt");
  state = reduceIntent(state, "gain", 0.05);
  state = reduceIntent(state, "mute", true);
  state = reduceIntent(state, "temporary-end", true);
  assert.equal(state.gain, 0.05);
  assert.equal(state.muted, true);
  state = reduceIntent(state, "reset");
  assert.equal(state.playing, false);
  assert.equal(state.needsUser, true);
  state = reduceIntent(state, "resume");
  assert.equal(state.gain, 0.05);
  assert.equal(state.muted, true);
});
test("unsupported real service reset is blocked before starting audio", async (t) => {
  let calls = 0;
  const h = harness(t, "service-reset", "buffer-source", 1, {
    run: async () => {
      calls++;
      throw new Error("must not start");
    },
  });
  const report = await h.start();
  assert.equal(report.verdict, "blocked");
  assert.equal(calls, 0);
});
test("operator Done without an actual OS fault cannot verify or pass an interruption", async (t) => {
  const h = harness(
    t,
    "interruption",
    "buffer-source",
    1,
    {},
    (controller, report) => {
      controller.observe("position", 1);
      if (report.scenario?.stage === "disruption")
        controller.signal("end-disruption");
    },
  );
  const report = await h.start();
  assert.equal(report.scenario?.verifiedFaults, 0);
  assert.equal(report.verdict, "inconclusive");
});
test("an interruption that has not ended cannot be bypassed by fresh-session verification", async (t) => {
  let interrupted = false,
    starts = 0;
  const h = harness(
    t,
    "interruption",
    "buffer-source",
    1,
    {
      run: async (_id, action, _settings, _scope, emit) => {
        if (action === "start") starts++;
        emit("position", 1);
        return { status: "passed", summary: "Accepted" };
      },
    },
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !interrupted) {
        interrupted = true;
        controller.observe("interruption", {
          type: "began",
          shouldResume: false,
        });
        controller.signal("end-disruption");
      }
    },
  );
  const report = await h.start();
  assert.equal(starts, 1);
  assert.equal(report.verdict, "inconclusive");
  assert(
    report.checks.some((check) => check.name === "OS condition still active"),
  );
});
test("baseline device events and session category changes do not verify a hardware route disruption", async (t) => {
  const h = harness(
    t,
    "routes-background",
    "buffer-source",
    1,
    {
      run: async (_id, _action, _settings, _scope, emit) => {
        emit("routeChange", { reason: "OldDeviceUnavailable" });
        emit("appState", "background");
        return { status: "passed", summary: "Started" };
      },
    },
    (controller, report) => {
      if (report.scenario?.stage === "disruption") {
        controller.observe("routeChange", { reason: "CategoryChange" });
        controller.observe("appState", "background");
        controller.signal("end-disruption");
      }
    },
  );
  const report = await h.start();
  assert.equal(report.scenario?.verifiedFaults, 0);
  assert.equal(report.verdict, "inconclusive");
});
test("native pressure evidence is required, collected, and released before run completion", async (t) => {
  const h = harness(t, "pressure", "buffer-source", 6, {}, (controller) =>
    controller.observe("position", 1),
  );
  const report = await h.start();
  assert.equal(report.scenario?.verifiedFaults, 1);
  assert(h.stops() > 0);
  assert(
    report.scenario!.nativeSamples.some(
      (sample) => sample.pressureActive && sample.workerBusyMs > 0,
    ),
  );
  assert.equal(report.verdict, "inconclusive");
});
test("a playback-notification scenario exercises the actual notification alongside its companion", async (t) => {
  const calls: string[] = [];
  const h = harness(t, "pressure", "playback-notification", 6, {
    run: async (id, action, _settings, _scope, emit) => {
      calls.push(`${id}:${action}`);
      emit("position", 1);
      return { status: "passed", summary: "Accepted" };
    },
  });
  const report = await h.start();
  assert(calls.includes("buffer-source:start"));
  assert(calls.includes("playback-notification:show"));
  assert(
    report.events.some((event) => event.name === "effectiveProductionWorkload"),
  );
});
test("a native expiry guard leaves the workload incomplete and still releases pressure", async (t) => {
  const h = harness(t, "pressure", "buffer-source", 6, {
    nativeSnapshot: () =>
      ({
        ...h.driver.capabilities(),
        runId: h.runner.getSnapshot().active!.id,
        at: Date.now(),
        appState: "active",
        pressureActive: false,
        guardReason: "native-expiry",
        events: [],
      }) as unknown as NativeSnapshot,
  });
  const report = await h.start();
  assert.equal(report.verdict, "inconclusive");
  assert.match(report.phase, /native-expiry/);
  assert(h.stops() > 0);
});
test("stop during pending start does not kill the supervisor and fresh sessions are verified separately", async (t) => {
  const h = harness(t, "stop-pending");
  const report = await h.start();
  assert.equal(report.phase, "Finished");
  assert(
    report.scenario?.timeline.some((step) => step.stage === "verification"),
  );
  assert.equal(report.scenario?.source, "simulated-app");
  assert(report.scenario?.recovery.some((item) => item.assisted));
});
test("watchdog separates background suspension, missing native evidence, guards, and foreground hangs", () => {
  const report = {
    id: "test",
    verdict: "running",
    heartbeatAt: new Date(1000).toISOString(),
    scenario: {},
  };
  const native = { runId: "test", at: 20000, appState: "background" };
  assert.equal(
    watchdogDecision(report, native, 21000),
    "expected-background-suspension",
  );
  assert.equal(
    watchdogDecision(report, { ...native, appState: "active" }, 21000),
    "failed-watchdog",
  );
  assert.equal(
    watchdogDecision(report, null, 21000),
    "inconclusive-missing-native-heartbeat",
  );
  assert.equal(
    watchdogDecision(
      report,
      { ...native, guardReason: "critical-thermal" },
      21000,
    ),
    "inconclusive-native-guard",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, false),
    "failed-process-death",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, null),
    "inconclusive-target-unreachable",
  );
  assert(
    simulatorAppAlive(
      "123 0 application.com.rnaaworkshop.stresstest.abc",
      "com.rnaaworkshop.stresstest",
    ),
  );
  assert(
    simulatorAppAlive(
      "123 0 UIKitApplication:com.rnaaworkshop.stresstest[abc][rb-legacy]",
      "com.rnaaworkshop.stresstest",
    ),
  );
  assert(
    !simulatorAppAlive(
      "- 0 application.com.rnaaworkshop.stresstest.abc",
      "com.rnaaworkshop.stresstest",
    ),
  );
});
test("notification Stop uses a file companion beside PCM capture and duplicate finalization fails", async (t) => {
  let sent = false;
  const calls: string[] = [];
  const h = harness(
    t,
    "notification-stop",
    "record-pcm",
    1,
    {
      run: async (id, action, _settings, _scope, emit) => {
        calls.push(`${id}:${action}`);
        emit("position", 1);
        return { status: "passed", summary: "Accepted" };
      },
    },
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        controller.observe("appState", "background");
        controller.observe("recordingNotificationStop", null);
        controller.observe("fileInfo", { paths: ["test.wav"] });
        controller.observe("fileInfo", { paths: ["test.wav"] });
        controller.signal("end-disruption");
      }
      if (report.scenario?.stage === "recovery") controller.signal("resume");
    },
  );
  const report = await h.start();
  assert(calls.includes("record-combined:start"));
  assert(!calls.includes("record-pcm:start"));
  assert.equal(report.scenario?.contract?.workloadFeatureId, "record-combined");
  assert.equal(report.verdict, "failed");
  assert(
    report.checks.some(
      (check) =>
        check.name === "Original recording finalized exactly once" &&
        check.status === "failed",
    ),
  );
});
test("native metadata fallback remains a failure under production pressure", async (t) => {
  const h = harness(t, "pressure", "metadata", 6, {
    run: async (_id, _action, _settings, _scope, emit) => {
      emit("metadata", {
        nativeDuration: 0,
        duration: 3,
        source: "decoded-fallback",
      });
      return { status: "passed", summary: "Fallback decoded" };
    },
  });
  const report = await h.start();
  assert.equal(report.verdict, "failed");
  assert(report.scenario?.findings.some((item) => item.includes("metadata")));
});
test("a recording above the conservative file ceiling is blocked before capture starts", async (t) => {
  let calls = 0;
  const h = harness(t, "pressure", "record-combined", 6, {
    run: async () => {
      calls++;
      return { status: "passed", summary: "Started" };
    },
  });
  const report = await h.runner.start("production-case", {
    ...defaultStressOptions,
    scenarioId: "pressure",
    targetFeatureId: "record-combined",
    targetSettings: { channels: 8, recordRate: 192000 },
    level: 6,
  });
  assert.equal(report.verdict, "blocked");
  assert.equal(calls, 0);
});
test("invalid microphone callback samples fail even if later file verification succeeds", async (t) => {
  const h = harness(t, "pressure", "record-combined", 6, {
    run: async (_id, _action, _settings, _scope, emit) => {
      emit("audioReady", { numFrames: 128, rms: NaN });
      return { status: "passed", summary: "Started" };
    },
  });
  const report = await h.start();
  assert.equal(report.verdict, "failed");
  assert(
    report.scenario?.findings.some((item) =>
      item.includes("Microphone callback"),
    ),
  );
});
test("an unverified later round cannot borrow verified disruption evidence from an earlier round", async (t) => {
  let listener: (error: unknown) => void = () => {};
  const sent = new Set<number>();
  const h = harness(
    t,
    "interruption",
    "buffer-source",
    2,
    {
      observeFaults: (_root, callback) => {
        listener = callback;
        return () => {};
      },
    },
    (controller, report) => {
      const scenario = report.scenario;
      if (scenario?.stage === "disruption" && !sent.has(scenario.round)) {
        sent.add(scenario.round);
        if (scenario.round === 1) {
          controller.observe("interruption", { type: "began" });
          controller.observe("interruption", {
            type: "ended",
            shouldResume: true,
          });
        } else
          listener(
            new Error("audio focus interrupted without a verified OS fault"),
          );
        controller.signal("end-disruption");
      }
    },
  );
  const report = await h.start();
  assert.equal(report.scenario?.verifiedFaults, 1);
  assert.equal(report.verdict, "failed");
  assert(
    report.scenario?.findings.some((item) =>
      item.includes("Unexpected audio error"),
    ),
  );
});

test("JS-only pressure repeats bounded pauses without requiring native workers", async (t) => {
  const h = harness(t, "pressure", "buffer-source", 1, {}, (controller) =>
    controller.observe("position", 1),
  );
  const report = await h.runner.start("production-case", {
    ...defaultStressOptions,
    scenarioId: "pressure",
    targetFeatureId: "context",
    level: 1,
    environmentProfile: "js",
  });
  assert(Number(report.metrics.jsStalls) >= 4);
  assert.equal(report.scenario?.verifiedFaults, 1);
  assert.equal(report.scenario?.source, "simulated-app");
  assert.equal(report.metrics.requestedNativeWorkers, 0);
  assert.equal(report.verdict, "inconclusive"); // Physical audio evidence remains manual.
});
test("all top ten preparations run their actual target/companion and retain latency evidence", async (t) => {
  const h = harness(t, "pressure");
  for (const targetFeatureId of Object.keys(manualChecks)) {
    const calls: { id: string; action: string; settings: any }[] = [];
    h.driver.platform = targetFeatureId === "session" ? "ios" : "android";
    h.driver.run = async (id, action, settings, scope, emit) => {
      scope.ensureActive();
      calls.push({ id, action, settings });
      emit("position", 1);
      return { status: "passed", summary: "Accepted" };
    };
    const report = await h.runner.start("production-case", {
      ...defaultStressOptions,
      scenarioId: "pressure",
      targetFeatureId,
      level: 1,
      environmentProfile: "latency",
      companion: ["record-recovery", "background"].includes(targetFeatureId)
        ? "recording"
        : "playback",
    });
    assert.equal(report.phase, "Finished", targetFeatureId);
    assert.equal(report.scenario?.verifiedFaults, 1, targetFeatureId);
    assert(Number(report.metrics.appCommandDelays) >= 2, targetFeatureId);
    assert.equal(report.metrics.requestedNativeWorkers, 0);
    if (targetFeatureId.endsWith("-notification"))
      assert(
        calls.some(
          (call) => call.id === targetFeatureId && call.action === "show",
        ),
      );
    if (targetFeatureId === "session") {
      assert.equal(calls[0].id, "session");
      assert(calls.some((call) => call.settings.productionPreserveSession));
    }
    assert.notEqual(report.verdict, "passed"); // This test never fabricates listening evidence.
  }
});
test("Stop all cancels delayed startup before the native source can begin", async (t) => {
  let starts = 0;
  const h = harness(
    t,
    "pressure",
    "context",
    1,
    {
      run: async (_id, action) => {
        if (action === "start") starts++;
        return { status: "passed", summary: "Accepted" };
      },
    },
    (_controller, report) => {
      if (
        report.events.some((event: any) => event.name === "appLatencyRequested")
      )
        void h.cancel();
    },
  );
  const report = await h.runner.start("production-case", {
    ...defaultStressOptions,
    scenarioId: "pressure",
    targetFeatureId: "context",
    level: 1,
    environmentProfile: "latency",
  });
  assert.equal(starts, 0);
  assert.equal(report.verdict, "inconclusive");
  assert.match(report.phase, /stopped or replaced/i);
  assert(h.stops() > 0);
});
test("missing optional progress cannot turn prompt startup into a five-second timeout failure", async (t) => {
  const h = harness(t, "stop-pending", "record-file", 1, {
    run: async () => ({ status: "passed", summary: "Accepted" }),
  });
  const report = await h.start();
  assert(
    report.checks.some(
      (check) =>
        check.name === "Separate new-session acknowledgement" &&
        check.status === "passed",
    ),
  );
  assert(
    report.checks.some(
      (check) =>
        check.name === "Fresh output progress" && check.status === "unverified",
    ),
  );
  assert(!report.checks.some((check) => check.status === "failed"));
  assert.equal(report.verdict, "inconclusive");
});
test("a genuinely slow fresh-session startup still fails its five-second deadline", async (t) => {
  const h = harness(t, "stop-pending", "context", 1, {
    run: async (_id, action, _settings, _scope, emit) => {
      if (action === "start") t.mock.timers.tick(6000);
      emit("position", 1);
      return { status: "passed", summary: "Accepted" };
    },
  });
  const report = await h.start();
  assert(
    report.checks.some(
      (check) =>
        check.name === "Separate new-session acknowledgement" &&
        check.status === "failed",
    ),
  );
  assert.equal(report.verdict, "failed");
});
test("Android recording pressure includes the foreground recording notification", async (t) => {
  const calls: string[] = [];
  const h = harness(t, "pressure", "record-file", 6, {
    run: async (id, action, _settings, _scope, emit) => {
      calls.push(`${id}:${action}`);
      emit("audioReady", { numFrames: 128, rms: 0.1 });
      return { status: "passed", summary: "Accepted" };
    },
  });
  await h.start();
  assert(calls.includes("record-file:start"));
  assert(calls.includes("recording-notification:show"));
});
test("background-only verifies a real leave and return without requiring a headphone route change", async (t) => {
  let sent = false;
  const h = harness(
    t,
    "background-only",
    "background",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        controller.observe("appState", "background", "native");
        controller.observe("appState", "active", "native");
        controller.signal("end-disruption");
      }
    },
  );
  const report = await h.start();
  assert.equal(report.scenario?.verifiedFaults, 1);
  assert(
    report.scenario?.faultEvents?.some(
      (event) =>
        event.name === "appState" &&
        event.value === "background" &&
        event.source === "native",
    ),
  );
});
test("important OS events survive a flood of routine audio progress events", async (t) => {
  let sent = false;
  const h = harness(
    t,
    "interruption",
    "context",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        controller.observe("interruption", { type: "began" }, "rnaa-os");
        controller.observe(
          "interruption",
          { type: "ended", shouldResume: true },
          "rnaa-os",
        );
        for (let n = 0; n < 300; n++) controller.observe("position", n);
        controller.signal("end-disruption");
      }
    },
  );
  const report = await h.start();
  assert(report.droppedEvents > 0);
  assert.equal(
    report.scenario?.faultEvents?.filter(
      (event) => event.name === "interruption",
    ).length,
    2,
  );
});
test("uninterrupted background recording does not invent an unresolved OS interruption", async (t) => {
  let sent = false;
  const h = harness(
    t,
    "background-only",
    "background",
    1,
    {},
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        controller.observe("appState", "background", "native");
        controller.observe("appState", "active", "native");
        controller.signal("end-disruption");
      }
      controller.observe("audioReady", { numFrames: 128, rms: 0.1 }, "rnaa");
    },
  );
  const report = await h.runner.start("production-case", {
    ...defaultStressOptions,
    targetFeatureId: "background",
    scenarioId: "background-only",
    level: 1,
    companion: "recording",
  });
  assert(
    !report.checks.some(
      (check) => check.name === "OS has not permitted recovery",
    ),
  );
  assert(
    report.scenario?.recovery.some((item) => item.observed && !item.assisted),
  );
});
test("watchdog checks actual Android window ownership before declaring a foreground hang", () => {
  const report = {
    id: "test",
    verdict: "running",
    heartbeatAt: new Date(1000).toISOString(),
    scenario: {},
  };
  const native = { runId: "test", at: 20000, appState: "active" };
  assert.equal(
    watchdogDecision(report, native, 21000, true, false),
    "expected-background-suspension",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, true, true),
    "failed-watchdog",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, true, null),
    "inconclusive-foreground-unknown",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, false, false),
    "failed-process-death",
  );
  assert.equal(
    androidOwnsFocusedWindow(
      "mCurrentFocus=Window{abc u0 com.rnaaworkshop.stresstest/.MainActivity}",
      "com.rnaaworkshop.stresstest",
    ),
    true,
  );
  assert.equal(
    androidOwnsFocusedWindow(
      "mCurrentFocus=Window{abc u0 NotificationShade}",
      "com.rnaaworkshop.stresstest",
    ),
    false,
  );
  assert.equal(
    androidOwnsFocusedWindow(
      "mCurrentFocus=null",
      "com.rnaaworkshop.stresstest",
    ),
    null,
  );
  assert.equal(
    androidOwnsFocusedWindow(
      "mCurrentFocus=null\nmCurrentFocus=Window{abc u0 com.rnaaworkshop.stresstest/.MainActivity}",
      "com.rnaaworkshop.stresstest",
    ),
    true,
  );
});

test("explicit Resume uses the existing session and never starts a replacement as recovery", async (t) => {
  let starts = 0,
    interruptions = false,
    resumes = 0;
  const h = harness(
    t,
    "interruption",
    "record-combined",
    1,
    {
      run: async (_id, action, _settings, _scope, emit) => {
        if (action === "start") starts++;
        emit("position", 1);
        return { status: "passed", summary: "Accepted" };
      },
      applyIntent: async (intent) => {
        if (!intent.interrupted && !intent.needsUser && intent.playing)
          resumes++;
        h.controller.observe("position", resumes);
      },
    },
    (controller, report) => {
      if (report.scenario?.stage === "disruption" && !interruptions) {
        interruptions = true;
        controller.observe("interruption", { type: "began" }, "rnaa-os");
        controller.observe(
          "interruption",
          { type: "ended", shouldResume: true },
          "rnaa-os",
        );
        controller.signal("end-disruption");
      }
      if (report.scenario?.stage === "recovery") controller.signal("resume");
    },
  );
  const report = await h.start();
  assert.equal(starts, 2, "baseline and separate final usability start only");
  assert(resumes > 0);
  assert(
    report.scenario?.recovery.some(
      (item) => item.kind === "existing-session-resume",
    ),
  );
  assert(
    !report.scenario?.recovery.some(
      (item) => item.kind === "separate-new-session",
    ),
  );
  assert(report.scenario?.observed.originalResponse);
  assert(
    report.scenario?.clientActions?.every((item) => item.before && item.intent),
  );
  assert.equal(report.metrics.automaticEngineRebuilds, 0);
  assert.equal(report.metrics.automaticRetries, 0);
});
test("a successful separate new session cannot erase the original audio failure", async (t) => {
  let fault: (error: unknown) => void = () => {};
  let sent = false;
  const h = harness(
    t,
    "pressure",
    "context",
    6,
    {
      observeFaults: (_root, callback) => {
        fault = callback;
        return () => {};
      },
    },
    (_controller, report) => {
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        fault(new Error("original native renderer failed"));
      }
    },
  );
  const report = await h.start();
  assert.equal(report.verdict, "failed");
  assert(report.events.some((event) => event.name === "postTestNewSession"));
  assert(
    report.scenario?.findings.some((item) =>
      item.includes("original native renderer failed"),
    ),
  );
});
test("an unrelated ended event cannot stop playback or manufacture a recovery request", async (t) => {
  let sent = false,
    changes = 0;
  const h = harness(
    t,
    "pressure",
    "context",
    6,
    {
      applyIntent: async () => {
        changes++;
      },
    },
    (controller, report) => {
      controller.observe("position", 1);
      if (report.scenario?.stage === "disruption" && !sent) {
        sent = true;
        controller.observe(
          "interruption",
          { type: "ended", shouldResume: false },
          "rnaa-os",
        );
      }
    },
  );
  const report = await h.start();
  assert.equal(changes, 0);
  assert.equal(report.scenario?.desired.playing, true);
  assert.equal(report.scenario?.userActionRequired, false);
  assert(
    report.scenario?.faultEvents?.some(
      (event) => event.name === "interruption",
    ),
  );
});
test("watchdog measures foreground time after return without counting background suspension as a hang", () => {
  const report = {
    id: "test",
    verdict: "running",
    heartbeatAt: new Date(1000).toISOString(),
    scenario: {},
  };
  const native = { runId: "test", at: 20000, appState: "active" };
  assert.equal(
    watchdogDecision(report, native, 21000, true, true, 20500),
    "foreground-observation-pending",
  );
  assert.equal(
    watchdogDecision(
      report,
      { ...native, at: 36000 },
      37000,
      true,
      true,
      20500,
    ),
    "failed-watchdog",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, false, true, 20500),
    "failed-process-death",
  );
  assert.equal(
    watchdogDecision(
      report,
      { ...native, guardReason: "native-expiry" },
      21000,
      true,
      true,
      20500,
    ),
    "inconclusive-native-guard",
  );
  assert.equal(
    watchdogDecision(report, native, 21000, true, false, 20500),
    "expected-background-suspension",
  );
});
