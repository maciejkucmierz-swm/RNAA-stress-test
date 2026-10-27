import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { exportResults, History } from "../src/workshop/history";
import { hasAudioSetup } from "../src/workshop/presentation";
import { defaults, features } from "../src/workshop/registry";
import { SessionCoordinator, SessionScope } from "../src/workshop/session";
import {
  availability,
  BlockedError,
  CancelledError,
  formatError,
  manual,
  type TestResult,
} from "../src/workshop/types";
import { loadModule } from "./helpers/load-module";

test("replacement awaits old cleanup, and newer replacement wins", async () => {
  const coordinator = new SessionCoordinator();
  const first = await coordinator.replace("first");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.defer(() => gate);
  const second = coordinator.replace("second");
  const third = coordinator.replace("third");
  const rejected = assert.rejects(second, CancelledError);
  assert.equal(coordinator.active, null);
  release();
  await rejected;
  assert.equal((await third).featureId, "third");
});
test("cleanup runs in reverse order and continues after an error", async () => {
  const scope = new SessionScope("cleanup");
  const order: number[] = [];
  scope.defer(() => {
    order.push(1);
  });
  scope.defer(() => {
    order.push(2);
    throw new Error("cleanup failed");
  });
  scope.defer(() => {
    order.push(3);
  });
  await assert.rejects(scope.dispose(), AggregateError);
  assert.deepEqual(order, [3, 2, 1]);
  assert.equal(scope.alive, false);
  await scope.dispose();
});
test("stop cancels a pending wait and late completions cannot create resources", async () => {
  const coordinator = new SessionCoordinator();
  const scope = await coordinator.replace("async");
  const pending = scope.wait(10000);
  const rejected = assert.rejects(pending, CancelledError);
  await coordinator.stop();
  await rejected;
  assert.throws(() => scope.ensureActive(), CancelledError);
  assert.throws(() => scope.defer(() => {}), CancelledError);
  assert.equal(coordinator.active, null);
});
test("all category features have stable IDs, settings, and published availability", () => {
  assert.equal(
    features.length,
    new Set(features.map((feature) => feature.id)).size,
  );
  for (const feature of features) {
    assert(feature.actions.length);
    assert.equal(
      feature.fields.length,
      new Set(feature.fields.map((field) => field.key)).size,
    );
    assert.equal(Object.keys(defaults(feature)).length, feature.fields.length);
  }
  assert(
    !features.some((feature) =>
      ["spatial", "channels", "capture-processing"].includes(feature.id),
    ),
  );
  assert(features.some((feature) => feature.id === "worklet-process"));
  assert.match(
    availability(
      features.find((f) => f.id === "recording-notification")!,
      "ios",
    )!,
    /android/,
  );
});
function result(id: string): TestResult {
  return {
    id,
    featureId: "oscillator",
    action: "check",
    startedAt: "2026-10-15T12:00:00Z",
    status: "manual",
    summary: "Audible confirmation needed",
    settings: { frequency: 440, headers: '{"Authorization":"secret"}' },
    environment: { audioApi: "0.13.6" },
    events: [
      {
        at: "now",
        name: "data",
        value: {
          headers: "secret",
          pcm: new Float32Array([1, 2]),
          rate: 48000,
        },
      },
    ],
    droppedEvents: 0,
    manualVerdict: "passed",
  };
}
test("history serializes writes, caps at 100, restores versions, and clears", async () => {
  let saved = "";
  const storage = {
    read: async () => saved || null,
    write: async (value: string) => {
      saved = value;
    },
  };
  const history = new History(storage);
  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      history.put(result(String(index))),
    ),
  );
  assert.equal(history.results.length, 100);
  const restored = new History(storage);
  await restored.load();
  assert.equal(restored.results[0].id, "104");
  assert.equal(restored.results[0].environment.audioApi, "0.13.6");
  await restored.clear();
  assert.equal(JSON.parse(saved).results.length, 0);
});
test("export separates manual verdict and excludes secrets/PCM", () => {
  const payload = exportResults([result("export")]);
  assert(!payload.includes("secret"));
  assert(payload.includes("[binary omitted]"));
  const restored = JSON.parse(payload).results[0];
  assert.equal(restored.status, "manual");
  assert.equal(restored.manualVerdict, "passed");
});
test("unknown saved history format is reported instead of silently discarded", async () => {
  const history = new History({
    read: async () => '{"formatVersion":999,"results":[]}',
    write: async () => {},
  });
  await assert.rejects(history.load(), /Unsupported history/);
});
test("published queue default-start defect remains observable without patching", () => {
  const require = createRequire(import.meta.url);
  const file = require
    .resolve("react-native-audio-api/package.json")
    .replace("package.json", "src/core/AudioBufferQueueSourceNode.ts");
  const calls: number[][] = [];
  const native = { start: (...args: number[]) => calls.push(args) };
  const { default: QueueSource } = loadModule(file, {
    "./AudioBufferBaseSourceNode": {
      __esModule: true,
      default: class {
        constructor(
          readonly context: unknown,
          readonly node: unknown,
        ) {}
      },
    },
    "../errors": { RangeError, InvalidStateError: Error },
    "../types": { AudioBufferQueueSourceState: { IDLE: 0, PLAYING: 1 } },
  }) as {
    default: new (context: unknown) => {
      start(when?: number, offset?: number): void;
    };
  };
  const context = {
    context: { createBufferQueueSource: () => native },
    markRunningOnSourceStart: () => {},
  };
  assert.throws(() => new QueueSource(context).start(), RangeError);
  new QueueSource(context).start(0, 0);
  assert.throws(() => new QueueSource(context).start(0, -2), RangeError);
  assert.deepEqual(calls, [[0, 0]]);
});

function loadBackend(
  api: Record<string, any>,
  platform = "android",
  fixtureOverrides: Record<string, unknown> = {},
) {
  class MemoryFile {
    exists = true;
    size = 1024;
    uri: string;
    constructor(uri: unknown) {
      this.uri = String(uri);
    }
    create() {}
    write() {}
    copy() {}
    move() {}
    delete() {}
    textSync() {
      return "[]";
    }
  }
  return (mocks: any = {}) => {
    const mockApi = api;
    if (mocks.createContext)
      mockApi.AudioContext = function () {
        return mocks.createContext();
      };
    if (mocks.createRecorder) {
      mockApi.AudioRecorder = Object.assign(function () {
        const recorder = mocks.createRecorder();
        recorder.enableFileOutput ??= () => ({ status: "success" });
        return recorder;
      }, api.AudioRecorder);
    }
    const module = loadModule("src/audio/common.ts", {
      "react-native-audio-api": mockApi,
      "react-native-worklets": { scheduleOnRN() {} },
      "expo-file-system": {
        File: MemoryFile,
        Paths: { document: "document", cache: "cache" },
      },
      "expo-constants": { default: {} },
      "react-native": { Platform: { OS: platform } },
      "./fixtures": {
        fixturePath: async () => "stereo.wav",
        ...fixtureOverrides,
      },
      "../fixtures": {
        fixturePath: async () => "stereo.wav",
        ...fixtureOverrides,
      },
    }) as { createBackend: () => import("../src/audio/contracts").Backend };
    return module.createBackend();
  };
}
test("permission requests explain already-granted access instead of suggesting a new prompt", async () => {
  for (const action of ["microphone", "notification"]) {
    let requested = 0;
    const backend = loadBackend({
      FileFormat: {},
      AudioManager: {
        checkRecordingPermissions: async () => "Granted",
        checkNotificationPermissions: async () => "Granted",
        requestRecordingPermissions: async () => {
          requested++;
          return "Granted";
        },
        requestNotificationPermissions: async () => {
          requested++;
          return "Granted";
        },
      },
    })({ channel: "stable" });
    const result = await backend.run("permissions", action, {}, null, () => {});
    assert.equal(requested, 1);
    assert.equal(result.status, "passed");
    assert.match(result.summary, /Granted.*already allowed.*prompt/);
  }
});
test("permission denial provides the app-settings recovery path without claiming a reset", async () => {
  const backend = loadBackend({
    FileFormat: {},
    AudioManager: {
      checkRecordingPermissions: async () => "Denied",
      requestRecordingPermissions: async () => "Denied",
    },
  })({ channel: "stable" });
  await assert.rejects(
    backend.run("permissions", "microphone", {}, null, () => {}),
    /Microphone: Denied.*Open app settings.*does not reset permissions/,
  );
});
test("permission inspection displays both actual saved states", async () => {
  const backend = loadBackend({
    FileFormat: {},
    AudioManager: {
      checkRecordingPermissions: async () => "Granted",
      checkNotificationPermissions: async () => "Denied",
    },
  })({ channel: "stable" });
  const result = await backend.run(
    "permissions",
    "inspect",
    {},
    null,
    () => {},
  );
  assert.match(result.summary, /Microphone: Granted\. Notifications: Denied/);
});
test("pending native recording start is finalized before a replacement can begin", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false,
    recording = false,
    stops = 0;
  const recorder = {
    isRecording: () => recording,
    isPaused: () => false,
    onError() {},
    clearOnAudioReady() {},
    clearOnError() {},
    disconnect() {},
    async start() {
      started = true;
      await gate;
      recording = true;
      return { status: "success" };
    },
    async stop() {
      stops++;
      recording = false;
      return {
        status: "success",
        paths: ["file.wav"],
        size: 0.001,
        duration: 3,
      };
    },
  };
  const api = {
    AudioManager: {
      requestRecordingPermissions: async () => "Granted",
      observeAudioInterruptions() {},
    },
    FileFormat: { Wav: 0 },
    FilePreset: { High: {} },
    BitDepth: {},
    IOSAudioQuality: {},
    FileDirectory: { Cache: 1 },
    PlaybackNotificationManager: { isActive: async () => false, hide() {} },
    RecordingNotificationManager: { isActive: async () => false, hide() {} },
  };
  const backend = loadBackend(api)({
    channel: "stable",
    createRecorder: () => recorder,
    configureFile() {},
    startRecorder: () => recorder.start(),
    inspect: () => ({}),
  });
  const coordinator = new SessionCoordinator();
  const scope = await coordinator.replace("record-file");
  scope.defer(() => backend.idle());
  const operation = backend.run("record-file", "start", {}, scope, () => {});
  const rejected = assert.rejects(operation, CancelledError);
  while (!started) await Promise.resolve();
  const next = coordinator.replace("oscillator");
  await Promise.resolve();
  assert.equal(coordinator.active, null);
  release();
  await rejected;
  assert.equal((await next).featureId, "oscillator");
  assert.equal(stops, 1);
  assert.equal(recording, false);
});
test("backend idle continues hiding notifications and suspending after a cleanup error", async () => {
  const calls: string[] = [];
  const context = {
    state: "running",
    sampleRate: 48000,
    currentTime: 0,
    suspend() {
      calls.push("suspend");
      this.state = "suspended";
    },
  };
  const api = {
    AudioManager: {
      observeAudioInterruptions() {
        throw new Error("observer failed");
      },
    },
    FileFormat: {},
    PlaybackNotificationManager: {
      isActive: async () => true,
      hide() {
        calls.push("playback hide");
      },
    },
    RecordingNotificationManager: {
      isActive: async () => true,
      hide() {
        calls.push("recording hide");
      },
    },
  };
  const backend = loadBackend(api)({
    channel: "stable",
    createContext: () => context,
    inspect: () => ({}),
  });
  await backend.run(
    "context",
    "create",
    {},
    new SessionScope("context"),
    () => {},
  );
  await assert.rejects(backend.idle(), AggregateError);
  assert.deepEqual(calls, ["playback hide", "recording hide", "suspend"]);
});

test("Stop all with no active demo holds the cleanup barrier before another start", async () => {
  const coordinator = new SessionCoordinator();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopping = coordinator.stop(undefined, () => gate);
  const starting = coordinator.replace("next");
  await Promise.resolve();
  assert.equal(coordinator.active, null);
  release();
  await stopping;
  assert.equal((await starting).featureId, "next");
});
test("late completion cannot stop a newer owned session", async () => {
  const coordinator = new SessionCoordinator();
  const old = await coordinator.replace("old");
  const current = await coordinator.replace("current");
  await coordinator.stop(old);
  assert.equal(coordinator.active, current);
});
test("native lifecycle promise settles before resources are disposed", async () => {
  const scope = new SessionScope("native");
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  scope.defer(() => {
    order.push("dispose");
  });
  const native = scope.hold(
    gate.then(() => {
      order.push("native settled");
    }),
  );
  const stopping = scope.dispose();
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await native;
  await stopping;
  assert.deepEqual(order, ["native settled", "dispose"]);
});
function graphHarness(platform = "android") {
  const calls: string[] = [];
  const sourceEmit = new Map<Node, (name: string) => void>();
  class Node {
    channelCount = 2;
    channelCountMode = "max";
    channelInterpretation = "speakers";
    numberOfInputs = 1;
    numberOfOutputs = 1;
    connect() {}
    disconnect() {
      calls.push("disconnect");
    }
  }
  class Source extends Node {
    onEnded: ((event?: unknown) => void) | null = null;
    constructor() {
      super();
      sourceEmit.set(this, () => this.onEnded?.());
    }
    playbackRate = { value: 1 };
    detune = { value: 0 };
    frequency = { value: 440 };
    buffer = null;
    loop = false;
    start() {
      calls.push("start");
    }
    stop() {
      calls.push("stop");
    }
    getLatency() {
      return 0;
    }
  }
  class Gain extends Node {
    gain = { value: 1 };
  }
  const buffer = {
    duration: 3,
    sampleRate: 48000,
    numberOfChannels: 2,
    length: 128,
    getChannelData: () => new Float32Array([0.2, 0.1]),
  };
  const context = {
    state: "suspended",
    sampleRate: 48000,
    currentTime: 0,
    destination: new Node(),
    resume() {
      calls.push("resume");
      this.state = "running";
      return Promise.resolve();
    },
    suspend() {
      calls.push("suspend");
      this.state = "suspended";
      return Promise.resolve();
    },
    close() {
      this.state = "closed";
      return Promise.resolve();
    },
    decodeAudioData: async () => buffer,
    createGain: () => new Gain(),
    createBufferSource: () => new Source(),
    createIIRFilter: () =>
      Object.assign(new Node(), {
        getFrequencyResponse() {
          calls.push("response");
        },
      }),
  };
  const api: Record<string, any> & {
    AudioScheduledSourceNode: typeof Source;
    AudioBufferSourceNode: typeof Source;
  } = {
    FileFormat: {},
    AudioRecorder: { isRecordingOngoing: () => false },
    AudioScheduledSourceNode: Source,
    AudioBufferSourceNode: Source,
    AudioManager: {
      setAudioSessionOptions() {},
      observeAudioInterruptions() {},
      activelyReclaimSession() {},
      setAudioSessionActivity: async (enabled: boolean) => {
        calls.push(`session ${enabled}`);
      },
    },
    PlaybackNotificationManager: {
      isActive: async () => false,
      hide() {
        throw new Error("Never-created key");
      },
    },
    RecordingNotificationManager: {
      isActive: async () => {
        calls.push("recording notification inspected");
        return false;
      },
      hide() {
        throw new Error("Never-created key");
      },
    },
  };
  const hooks = {
    channel: "stable",
    createContext: () => context,
    inspect: () => ({}),
    bindSource: (node: Node, emit: (name: string) => void) => {
      sourceEmit.set(node, emit);
      return () => {
        sourceEmit.delete(node);
      };
    },
    bindBuffer: () => () => {},
  };
  return {
    calls,
    context,
    api,
    hooks,
    sourceEmit,
    backend: loadBackend(api, platform)(hooks),
  };
}
function queueHarness() {
  const base = graphHarness(),
    decoded: string[] = [];
  class Queue extends base.api.AudioScheduledSourceNode {
    onBufferEnded: ((event: unknown) => void) | null = null;
    constructor() {
      super();
      listeners.push((_name, event) => this.onBufferEnded?.(event));
    }
    enqueued: unknown[] = [];
    removed: string[] = [];
    enqueueBuffer(buffer: unknown) {
      this.enqueued.push(buffer);
      return String(this.enqueued.length - 1);
    }
    dequeueBuffer(id: string) {
      this.removed.push(id);
    }
    clearBuffers() {
      base.calls.push("queue clear");
    }
    pause() {
      base.calls.push("queue pause");
    }
  }
  const queues: Queue[] = [],
    listeners: ((name: string, value: unknown) => void)[] = [];
  const context = Object.assign(base.context, {
    createBufferQueueSource: () => {
      const queue = new Queue();
      queues.push(queue);
      return queue;
    },
  });
  const hooks = {
    ...base.hooks,
    bindBuffer: (
      _node: Queue,
      emit: (name: string, value: unknown) => void,
    ) => {
      listeners.push(emit);
      return () => {};
    },
    queue: (node: Queue) => node.start(),
  };
  base.api.AudioBufferSourceNode = class extends (
    base.api.AudioScheduledSourceNode
  ) {};
  const backend = loadBackend(base.api, "android", {
    fixturePath: async (name: string) => {
      decoded.push(name);
      return name;
    },
  })(hooks);
  return { ...base, backend, context, queues, listeners, decoded };
}
test("queue exhaustion is visible and Resume cannot falsely succeed on consumed buffers", async () => {
  const h = queueHarness(),
    scope = new SessionScope("queue");
  try {
    await h.backend.run(
      "queue",
      "start",
      { fixture: "stereo.wav" },
      scope,
      () => {},
    );
    assert.equal(h.backend.snapshot.queue?.queuedBuffers, 2);
    h.listeners[0]("onBufferEnded", {
      bufferId: "0",
      isLastBufferInQueue: false,
    });
    h.listeners[0]("onBufferEnded", {
      bufferId: "1",
      isLastBufferInQueue: true,
    });
    assert.equal(h.backend.snapshot.queue?.state, "empty");
    const resumes = h.calls.filter((call) => call === "resume").length;
    await assert.rejects(
      h.backend.run("queue", "resume", {}, scope, () => {}),
      /queue is empty.*Resume cannot replay/,
    );
    assert.equal(h.calls.filter((call) => call === "resume").length, resumes);
  } finally {
    await scope.dispose();
    await h.backend.idle();
  }
});
test("queue Enqueue uses the selected file and Dequeue excludes already consumed IDs", async () => {
  const h = queueHarness(),
    scope = new SessionScope("queue");
  try {
    await h.backend.run(
      "queue",
      "start",
      { fixture: "stereo.wav" },
      scope,
      () => {},
    );
    h.listeners[0]("onBufferEnded", {
      bufferId: "1",
      isLastBufferInQueue: false,
    });
    await h.backend.run("queue", "dequeue", {}, scope, () => {});
    assert.deepEqual(h.queues[0].removed, ["0"]);
    await h.backend.run(
      "queue",
      "enqueue",
      { fixture: "stereo.opus" },
      scope,
      () => {},
    );
    assert.deepEqual(h.decoded, ["stereo.wav", "stereo.opus"]);
    assert.equal(h.backend.snapshot.queue?.currentFixture, "stereo.opus");
    assert.equal(h.backend.snapshot.queue?.queuedBuffers, 1);
  } finally {
    await scope.dispose();
    await h.backend.idle();
  }
});
test("clearing a playing queue keeps the context running for native refill playback", async () => {
  const h = queueHarness(),
    scope = new SessionScope("queue");
  try {
    await h.backend.run("queue", "start", {}, scope, () => {});
    await h.backend.run("queue", "clear", {}, scope, () => {});
    assert.equal(h.context.state, "running");
    assert.equal(h.backend.snapshot.queue?.state, "empty");
    await h.backend.run(
      "queue",
      "enqueue",
      { fixture: "stereo.mp3" },
      scope,
      () => {},
    );
    assert.equal(h.context.state, "running");
    assert.equal(h.backend.snapshot.queue?.currentFixture, "stereo.mp3");
  } finally {
    await scope.dispose();
    await h.backend.idle();
  }
});
test("a late ended callback from an old queue cannot empty the next file session", async () => {
  const h = queueHarness(),
    old = new SessionScope("queue");
  await h.backend.run(
    "queue",
    "start",
    { fixture: "stereo.wav" },
    old,
    () => {},
  );
  await old.dispose();
  await h.backend.idle();
  const next = new SessionScope("queue");
  try {
    await h.backend.run(
      "queue",
      "start",
      { fixture: "stereo.opus" },
      next,
      () => {},
    );
    h.listeners[0]("onBufferEnded", {
      bufferId: "0",
      isLastBufferInQueue: true,
    });
    assert.equal(h.backend.snapshot.queue?.currentFixture, "stereo.opus");
    assert.equal(h.backend.snapshot.queue?.queuedBuffers, 2);
  } finally {
    await next.dispose();
    await h.backend.idle();
  }
});
test("Stop during selected-file decode prevents a late enqueue", async () => {
  const h = queueHarness(),
    scope = new SessionScope("queue");
  await h.backend.run("queue", "start", {}, scope, () => {});
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.context.decodeAudioData;
  h.context.decodeAudioData = async () => {
    entered = true;
    await gate;
    return original();
  };
  const pending = h.backend.run(
    "queue",
    "enqueue",
    { fixture: "stereo.mp3" },
    scope,
    () => {},
  );
  const rejected = assert.rejects(pending, CancelledError);
  while (!entered) await Promise.resolve();
  const stopping = scope.dispose();
  release();
  await rejected;
  await stopping;
  assert.equal(h.queues[0].enqueued.length, 2);
  assert.equal(h.backend.snapshot.queue, null);
  await h.backend.idle();
});
test("a fresh production audio graph starts muted when latest user intent is muted", async () => {
  const { backend } = graphHarness();
  const scope = new SessionScope("buffer-source");
  try {
    await backend.run(
      "buffer-source",
      "start",
      { productionProbe: true, scenarioGain: 0.05, muted: true, loop: true },
      scope,
      () => {},
    );
    assert.equal(backend.scenarioState().gain, 0);
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});
test("reading transport state during a UI render does not publish another state update", async () => {
  const { backend } = graphHarness();
  const scope = new SessionScope("buffer-source");
  let updates = 0;
  try {
    await backend.run("buffer-source", "start", {}, scope, () => {});
    backend.onChange = () => {
      updates++;
    };
    for (let index = 0; index < 10; index++)
      assert.equal(
        (backend.scenarioState().context as { state: string }).state,
        "running",
      );
    assert.equal(updates, 0);
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});
test("IIR construction reaches source playback; changing coefficients requires restart", async () => {
  const { backend, calls } = graphHarness();
  const scope = new SessionScope("iir");
  try {
    const outcome = await backend.run("iir", "start", {}, scope, () => {});
    assert.equal(outcome.status, "manual");
    assert(calls.includes("response"));
    assert(calls.includes("start"));
    await assert.rejects(
      backend.run("iir", "apply", {}, scope, () => {}),
      /construction-time/,
    );
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});
test("iOS cleanup avoids never-created and unsupported notification keys", async () => {
  const { backend, calls } = graphHarness("ios");
  await backend.idle();
  assert(!calls.includes("recording notification inspected"));
});
test("finite playback completion signals only its current scope; checks remain active", async () => {
  for (const action of ["start", "check"]) {
    const { backend, sourceEmit } = graphHarness();
    const scope = new SessionScope("buffer-source");
    let ended: SessionScope | null = null;
    backend.onSessionEnded = (value) => {
      ended = value;
    };
    const operation = backend.run(
      "buffer-source",
      action,
      { duration: 0.1 },
      scope,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const emit = [...sourceEmit.values()][0];
    assert(emit);
    emit("onEnded");
    assert.equal(ended, action === "start" ? scope : null);
    await operation;
    await scope.dispose();
    await backend.idle();
    emit("onEnded");
    assert.equal(ended, action === "start" ? scope : null);
  }
});
test("session choices survive lazy context creation and disabling management is not undone", async () => {
  const { api, hooks } = graphHarness("ios");
  const options: unknown[] = [];
  api.AudioManager.setAudioSessionOptions = (value?: unknown) => {
    options.push(value);
  };
  Object.assign(api.AudioManager, { disableSessionManagement() {} });
  const backend = loadBackend(api, "ios")(hooks);
  await backend.run(
    "session",
    "apply",
    { category: "ambient", mode: "default" },
    null,
    () => {},
  );
  const scope = new SessionScope("context");
  await backend.run("context", "create", {}, scope, () => {});
  assert.equal(
    (options.at(-1) as { iosCategory: string }).iosCategory,
    "ambient",
  );
  await backend.run("context", "close", {}, scope, () => {});
  await backend.run("session", "disable", {}, null, () => {});
  const count = options.length;
  await backend.run("context", "create", {}, scope, () => {});
  assert.equal(options.length, count);
  await scope.dispose();
  await backend.idle();
});
test("iOS session-check recording preserves the selected category instead of silently forcing defaults", async () => {
  const options: { iosCategory: string }[] = [];
  let recording = false;
  const recorder = {
    isRecording: () => recording,
    isPaused: () => false,
    onError() {},
    clearOnAudioReady() {},
    clearOnError() {},
    disconnect() {},
    start() {
      recording = true;
      return { status: "success" };
    },
    stop() {
      recording = false;
      return {
        status: "success",
        paths: ["session.wav"],
        duration: 1,
        size: 0.01,
      };
    },
  };
  const api = {
    AudioManager: {
      requestRecordingPermissions: async () => "Granted",
      observeAudioInterruptions() {},
      activelyReclaimSession() {},
      setAudioSessionOptions: (value: { iosCategory: string }) =>
        options.push(value),
      setAudioSessionActivity: async () => {},
    },
    FileFormat: { Wav: 0 },
    FilePreset: { High: {} },
    BitDepth: {},
    IOSAudioQuality: {},
    FileDirectory: { Cache: 1 },
    PlaybackNotificationManager: { isActive: async () => false, hide() {} },
  };
  const backend = loadBackend(
    api,
    "ios",
  )({
    channel: "stable",
    createRecorder: () => recorder,
    configureFile() {},
    startRecorder: () => recorder.start(),
    inspect: () => ({}),
  });
  await backend.run(
    "session",
    "apply",
    { category: "record", mode: "measurement", options: "[]" },
    null,
    () => {},
  );
  const scope = new SessionScope("record-file");
  try {
    await backend.run(
      "record-file",
      "start",
      { productionPreserveSession: true },
      scope,
      () => {},
    );
    assert(options.length > 0);
    assert(options.every((value) => value.iosCategory === "record"));
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});
test("media pause/end suspend the shared context and play resumes it without unmounting", async () => {
  const { backend, calls } = graphHarness();
  const scope = new SessionScope("audio-tag");
  await backend.run("audio-tag", "start", { autoPlay: false }, scope, () => {});
  assert(!calls.includes("resume"));
  const key = backend.snapshot.media!.key;
  backend.mediaEvent("play", undefined, key);
  backend.mediaEvent("pause", undefined, key);
  backend.mediaEvent("ended", undefined, key);
  assert.deepEqual(
    calls.filter((call) => ["resume", "suspend"].includes(call)),
    ["resume", "suspend", "suspend"],
  );
  assert.equal(backend.snapshot.media?.key, key);
  await scope.dispose();
  await backend.idle();
});

function runtimeHarness(read: () => Promise<string | null> = async () => null) {
  const state = {
    context: null,
    media: null,
    recordings: [],
    devices: [],
    plot: null,
  };
  const backend = {
    snapshot: state,
    channel: "stable",
    onChange() {},
    onSessionEnded(_scope: SessionScope) {},
    onSessionError(_scope: SessionScope, _error: unknown) {},
    idle: async () => {},
    restoreRecordings: async () => {},
    run: async () => manual("Active demo"),
    playRecording: async () => manual("Replay"),
    deleteRecording() {},
  };
  let written = "";
  class RuntimeFile {
    exists = true;
    uri = "memory.json";
    text = async () => (await read()) ?? exportResults([]);
    textSync() {
      return written || exportResults([]);
    }
    create() {}
    write(value: string) {
      written = value;
    }
    delete() {}
    copy() {}
    move() {}
  }
  const runtime = loadModule("src/workshop/runtime.ts", {
    "expo-file-system": {
      File: RuntimeFile,
      Paths: { document: "document", cache: "cache" },
    },
    "../audio": { backend },
    "../audio/build-info.json": {
      default: { audioApi: "0.13.6", channel: "stable", worklets: "0.10.1" },
    },
    "./session": { SessionCoordinator },
    "./registry": { features, defaults },
    "./presentation": { hasAudioSetup },
    "./history": { History, exportResults, redact: (value: unknown) => value },
    "./types": { availability, BlockedError, CancelledError, formatError },
    "react-native": {
      Platform: {
        OS: "android",
        Version: 36,
        constants: { reactNativeVersion: { major: 0, minor: 86, patch: 3 } },
      },
    },
    "expo-constants": { default: { expoConfig: { sdkVersion: "57.0.0" } } },
    "expo-sharing": {},
    "expo-device": {},
    "../storage/json-file": loadModule("src/storage/json-file.ts", {
      "expo-file-system": { File: RuntimeFile },
    }),
  }) as typeof import("../src/workshop/runtime");
  return { runtime: runtime.workshop, backend, written: () => written };
}
test("startup restoration is single-flight and completes before the first write", async () => {
  let release!: () => void,
    reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runtime, written } = runtimeHarness(async () => {
    reads++;
    await gate;
    return exportResults([result("previous-build")]);
  });
  const first = runtime.initialize(),
    second = runtime.initialize();
  assert.equal(first, second);
  const feature = features.find((f) => f.id === "oscillator")!;
  const operation = runtime.execute(
    feature,
    feature.actions[0],
    defaults(feature),
  );
  await Promise.resolve();
  assert.equal(written(), "");
  release();
  await operation;
  assert.equal(reads, 1);
  assert(
    runtime.getSnapshot().results.some((item) => item.id === "previous-build"),
  );
  await runtime.clearHistory();
});
test("Stop all cancels a start still waiting for startup storage", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runtime, backend } = runtimeHarness(async () => {
    await gate;
    return null;
  });
  let runs = 0;
  backend.run = async () => {
    runs++;
    return manual("active");
  };
  const feature = features.find((f) => f.id === "oscillator")!;
  const pending = runtime.execute(
    feature,
    feature.actions[0],
    defaults(feature),
  );
  await runtime.stopAll();
  release();
  await pending;
  assert.equal(runs, 0);
  assert.equal(runtime.getSnapshot().results[0].status, "blocked");
  await runtime.clearHistory();
});
test("late replay rejection leaves the newer session active", async () => {
  const { runtime, backend } = runtimeHarness();
  let reject!: (error: Error) => void;
  let replayStarted = false;
  backend.playRecording = () => {
    replayStarted = true;
    return new Promise((_, fail) => {
      reject = fail;
    });
  };
  const replay = runtime.playRecording("file.wav");
  while (!replayStarted) await Promise.resolve();
  const newer = await runtime.sessions.replace("newer");
  reject(new Error("late decode failure"));
  await replay;
  assert.equal(runtime.sessions.active, newer);
  assert.equal(runtime.getSnapshot().error, null);
  await runtime.clearHistory();
});
test("native asynchronous errors fail the originating result and release its session", async () => {
  const { runtime, backend } = runtimeHarness();
  const feature = features.find((f) => f.id === "oscillator")!;
  await runtime.execute(feature, feature.actions[0], defaults(feature));
  const scope = runtime.sessions.active!;
  (
    backend as unknown as import("../src/audio/contracts").Backend
  ).onSessionError(scope, new Error("native renderer failed"));
  await Promise.resolve();
  assert.equal(runtime.getSnapshot().results[0].status, "failed");
  assert.match(
    runtime.getSnapshot().results[0].summary,
    /native renderer failed/,
  );
  assert.equal(runtime.sessions.active, null);
  await runtime.clearHistory();
  assert.equal(scope.alive, false);
});
test("plot/context polling does not invalidate feature/history snapshots", async () => {
  const { runtime, backend } = runtimeHarness();
  await runtime.initialize();
  const data = runtime.getDataSnapshot(),
    all = runtime.getSnapshot();
  backend.onChange();
  assert.equal(runtime.getDataSnapshot(), data);
  assert.notEqual(runtime.getSnapshot(), all);
  await runtime.clearHistory();
});

test("recording finalization is retained after disposal but clearing history suppresses late reports", async () => {
  const { runtime, backend } = runtimeHarness();
  let finalize!: () => void;
  (backend as unknown as import("../src/audio/contracts").Backend).run = async (
    _id,
    _action,
    _settings,
    scope,
    emit,
  ) => {
    finalize = () =>
      emit("fileInfo", { paths: ["file.wav"], duration: 3 }, true);
    scope!.defer(finalize);
    return manual("Recording active");
  };
  const feature = features.find((f) => f.id === "record-file")!;
  await runtime.execute(feature, feature.actions[0], defaults(feature));
  await runtime.stopAll();
  assert(
    runtime
      .getSnapshot()
      .results[0].events.some((event) => event.name === "fileInfo"),
  );
  await runtime.clearHistory();
  finalize();
  assert.equal(runtime.getSnapshot().results.length, 0);
});

test("non-finite diagnostic samples remain distinguishable in exported observations", () => {
  const entry = result("non-finite");
  entry.events = [
    {
      at: "now",
      name: "response",
      value: { magnitude: [NaN, Infinity, -Infinity, 0] },
    },
  ];
  const restored = JSON.parse(exportResults([entry]));
  assert.deepEqual(restored.results[0].events[0].value.magnitude, [
    "NaN",
    "Infinity",
    "-Infinity",
    0,
  ]);
});

test("Stop all deactivates an explicitly activated iOS session", async () => {
  const { api, hooks, calls } = graphHarness("ios");
  Object.assign(api, {
    AudioRecorder: { consumeLastRecordingResult: () => null },
  });
  const backend = loadBackend(api, "ios")(hooks);
  await backend.run("session", "activate", {}, null, () => {});
  await backend.idle();
  assert.deepEqual(
    calls.filter((call) => call.startsWith("session ")),
    ["session true", "session false"],
  );
});

test("an unowned pending context resume cannot restart audio after Stop all cleanup", async () => {
  const { backend, context } = graphHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  context.resume = () =>
    gate.then(() => {
      context.state = "running";
    });
  const resume = backend.run("context", "resume", {}, null, () => {});
  const idle = backend.idle();
  release();
  await resume;
  await idle;
  assert.equal(context.state, "suspended");
});

test("rotated recording metadata is not silently truncated during persistence/export", () => {
  const entry = result("rotation");
  const paths = Array.from({ length: 200 }, (_, i) => `segment-${i}.wav`);
  entry.events = [{ at: "now", name: "fileInfo", value: { paths } }];
  assert.deepEqual(
    JSON.parse(exportResults([entry])).results[0].events[0].value.paths,
    paths,
  );
});

test("cleanup diagnostics retain nested native failure messages", () => {
  const message = formatError(
    new AggregateError(
      [
        new Error("native capture stop failed"),
        new AggregateError([new Error("disconnect failed")], "graph"),
      ],
      "cleanup",
    ),
  );
  assert.match(message, /native capture stop failed/);
  assert.match(message, /disconnect failed/);
});
test("validation checks do not pass an unrelated error as the expected API rejection", async () => {
  const { api, hooks } = graphHarness();
  Object.assign(api, {
    NotSupportedError: class extends Error {},
    IndexSizeError: class extends Error {},
  });
  const backend = loadBackend(api)(hooks);
  const outcome = await backend.run("errors", "check", {}, null, () => {});
  assert.equal(outcome.status, "failed");
  assert(outcome.assertions!.every((assertion) => !assertion.passed));
  await backend.idle();
});

test("late session events do not reorder an older Start above a newer Stop result", async () => {
  const history = new History({
    read: async () => null,
    write: async () => {},
  });
  const start = result("start"),
    stop = result("stop");
  await history.put(start);
  await history.put(stop);
  start.events.push({
    at: "later",
    name: "fileInfo",
    value: { paths: ["file.wav"] },
  });
  await history.put(start);
  assert.deepEqual(
    history.results.map((item) => item.id),
    ["stop", "start"],
  );
});

test("wave shaper replaces write-once curves and reuses a node for oversampling changes", async () => {
  const { api, context, hooks } = graphHarness();
  const nodes: {
    curve: Float32Array | null;
    oversample: string;
    disconnected: boolean;
  }[] = [];
  api.WaveShaperNode = class {
    channelCount = 2;
    channelCountMode = "max";
    channelInterpretation = "speakers";
    oversample = "none";
    disconnected = false;
    private data: Float32Array | null = null;
    constructor() {
      nodes.push(this);
    }
    get curve() {
      return this.data;
    }
    set curve(value: Float32Array | null) {
      assert.equal(this.data, null, "native curve is write-once");
      this.data = value;
    }
    connect() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  const backend = loadBackend(api)(hooks);
  const scope = new SessionScope("waveshaper");
  try {
    await backend.run(
      "waveshaper",
      "start",
      { drive: 3, curveSize: 256 },
      scope,
      () => {},
    );
    await backend.run(
      "waveshaper",
      "apply",
      { drive: 3, curveSize: 256, oversample: "4x" },
      null,
      () => {},
    );
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].oversample, "4x");
    await backend.run(
      "waveshaper",
      "apply",
      { drive: 5, curveSize: 512, oversample: "2x" },
      null,
      () => {},
    );
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].disconnected, true);
    assert.equal(nodes[1].curve?.length, 512);
    assert.equal(nodes[1].oversample, "2x");
    assert.equal(nodes[1].curve?.[0], Math.fround(Math.tanh(-5)));
    assert.equal(context.state, "running");
  } finally {
    await scope.dispose();
    await backend.idle();
  }
  assert(nodes.every((node) => node.disconnected));
});

test("native metadata defects remain failures and never trigger decoding fallback", async () => {
  for (const nativeDuration of [0, NaN, -1, 3]) {
    let decodes = 0;
    const api = {
      FileFormat: {},
      getAudioDuration: async () => nativeDuration,
      decodeAudioData: async () => {
        decodes++;
        throw Error("must not decode");
      },
    };
    const backend = loadBackend(api, "ios", {
      fixtureMetadata: { "stereo.ogg": { duration: 3 } },
    })({ channel: "stable" });
    const events: unknown[] = [];
    const result = await backend.run(
      "metadata",
      "check",
      { fixture: "stereo.ogg" },
      null,
      (name, value) => events.push({ name, value }),
    );
    assert.equal(result.status, nativeDuration === 3 ? "passed" : "failed");
    assert.equal(decodes, 0);
    assert.deepEqual(events, [
      {
        name: "metadata",
        value: { duration: nativeDuration, nativeDuration, source: "metadata" },
      },
    ]);
  }
});
test("metadata API errors are preserved without retry or substitute decoding", async () => {
  const api = {
    FileFormat: {},
    getAudioDuration: async () => {
      throw Error("native metadata error");
    },
    decodeAudioData: async () => {
      throw Error("must not decode");
    },
  };
  const backend = loadBackend(api, "ios")({ channel: "stable" });
  await assert.rejects(
    backend.run("metadata", "check", {}, null, () => {}),
    /native metadata error/,
  );
});

function notificationHarness() {
  const h = graphHarness();
  const shows: Record<string, unknown>[] = [];
  const listeners = new Map<string, (event?: unknown) => void>();
  let active = false;
  h.api.AudioManager.requestNotificationPermissions = async () => "Granted";
  h.api.PlaybackNotificationManager = {
    isActive: async () => active,
    hide: async () => {
      assert(active, "never hide an uncreated notification");
      active = false;
    },
    show: async (value: Record<string, unknown>) => {
      active = true;
      shows.push(value);
    },
    addEventListener: (name: string, callback: (event?: unknown) => void) => {
      listeners.set(name, callback);
      return { remove: () => listeners.delete(name) };
    },
  };
  return { ...h, shows, listeners };
}

test("native notification Pause and Play synchronize metadata in order, and paused updates are allowed", async () => {
  const { backend, context, shows, listeners } = notificationHarness();
  const scope = new SessionScope("buffer-source");
  try {
    await backend.run("buffer-source", "start", {}, scope, () => {});
    await backend.run(
      "playback-notification",
      "show",
      { state: "playing" },
      null,
      () => {},
    );
    listeners.get("playbackNotificationPause")!({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(context.state, "suspended");
    assert.equal(shows.at(-1)?.state, "paused");
    assert.equal(
      (
        await backend.run(
          "playback-notification",
          "show",
          { state: "paused" },
          null,
          () => {},
        )
      ).status,
      "manual",
    );
    listeners.get("playbackNotificationPlay")!({});
    listeners.get("playbackNotificationPause")!({});
    listeners.get("playbackNotificationPlay")!({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      shows.slice(-3).map((value) => value.state),
      ["playing", "paused", "playing"],
    );
    assert.equal(context.state, "running");
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});

test("Stop all prevents a queued notification transition from restarting audio", async () => {
  const { backend, context, shows, listeners } = notificationHarness();
  const scope = new SessionScope("buffer-source");
  await backend.run("buffer-source", "start", {}, scope, () => {});
  await backend.run("playback-notification", "show", {}, null, () => {});
  listeners.get("playbackNotificationPlay")!({});
  await scope.dispose();
  await backend.idle();
  assert.equal(shows.length, 1);
  assert.equal(context.state, "suspended");
  assert.equal(listeners.size, 0);
});

test("Hide before Show and repeated Hide are harmless on iOS", async () => {
  const { api, hooks } = graphHarness("ios");
  let active = false,
    hides = 0;
  api.PlaybackNotificationManager = {
    isActive: async () => active,
    hide: async () => {
      assert(active);
      active = false;
      hides++;
    },
  };
  const backend = loadBackend(api, "ios")(hooks);
  await backend.run("playback-notification", "hide", {}, null, () => {});
  active = true;
  await backend.run("playback-notification", "hide", {}, null, () => {});
  await backend.run("playback-notification", "hide", {}, null, () => {});
  assert.equal(hides, 1);
});

test("Stop all waits for an in-flight notification transition without publishing stale metadata", async () => {
  const { backend, context, shows, listeners } = notificationHarness();
  const scope = new SessionScope("buffer-source");
  await backend.run("buffer-source", "start", {}, scope, () => {});
  await backend.run("playback-notification", "show", {}, null, () => {});
  let release!: () => void,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  context.suspend = async () => {
    entered = true;
    await gate;
    context.state = "suspended";
  };
  listeners.get("playbackNotificationPause")!({});
  while (!entered) await Promise.resolve();
  const stopping = scope.dispose();
  release();
  await stopping;
  await backend.idle();
  assert.equal(shows.length, 1);
  assert.equal(context.state, "suspended");
});

test("Hide cancels queued notification updates and stale native listeners cannot recreate it", async () => {
  const { backend, shows, listeners } = notificationHarness();
  const scope = new SessionScope("buffer-source");
  try {
    await backend.run("buffer-source", "start", {}, scope, () => {});
    await backend.run("playback-notification", "show", {}, null, () => {});
    const oldPlay = listeners.get("playbackNotificationPlay")!;
    oldPlay({});
    await backend.run("playback-notification", "hide", {}, null, () => {});
    oldPlay({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shows.length, 1);
    assert.equal(listeners.size, 0);
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});

test("a rejected notification update preserves the current notification controls", async () => {
  const { backend, api, context, shows, listeners } = notificationHarness();
  const scope = new SessionScope("buffer-source");
  try {
    await backend.run("buffer-source", "start", {}, scope, () => {});
    await backend.run("playback-notification", "show", {}, null, () => {});
    api.AudioManager.requestNotificationPermissions = async () => "Denied";
    await assert.rejects(
      backend.run("playback-notification", "show", {}, null, () => {}),
      /permission denied/i,
    );
    listeners.get("playbackNotificationPause")!({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(context.state, "suspended");
    assert.equal(shows.at(-1)?.state, "paused");
  } finally {
    await scope.dispose();
    await backend.idle();
  }
});

test("a production child fault is retained by its supervisor without stopping the supervisor", async () => {
  const { runtime, backend } = runtimeHarness();
  let finish!: () => void,
    observed = "";
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = runtime.exclusiveStress(
    "production-supervisor",
    async (root) => {
      const remove = runtime.observeScenarioFaults(root, (error) => {
        observed = String(error);
      });
      root.defer(remove);
      const child = new SessionScope("record-file", root);
      root.defer(() => child.dispose());
      backend.onSessionError(child, new Error("Audio device disconnected"));
      await Promise.resolve();
      assert.equal(root.alive, true);
      assert.equal(child.alive, false);
      await gate;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(observed, /device disconnected/);
  finish();
  await running;
});
test("Stop all starts native pressure release even when audio cleanup reports an error", async () => {
  const { runtime } = runtimeHarness();
  let released = false;
  runtime.onStopAll(async () => {
    released = true;
  });
  const root = await runtime.sessions.replace("bad-audio");
  root.defer(() => {
    throw new Error("Native audio cleanup failed");
  });
  assert.equal(await runtime.stopAll(), false);
  assert.equal(released, true);
});
test("notification tests start their own audio before showing controls and Stop releases the owned session", async () => {
  for (const [id, companion] of [
    ["recording-notification", "record-file"],
    ["playback-notification", "buffer-source"],
  ]) {
    const { runtime, backend } = runtimeHarness();
    const calls: string[] = [];
    let cleaned = 0;
    backend.run = async (...args: unknown[]) => {
      calls.push(
        `${args[0]}:${args[1]}${args[1] === "control" ? `:${(args[2] as { control: string }).control}` : ""}`,
      );
      return manual("Started");
    };
    backend.idle = async () => {
      cleaned++;
    };
    const feature = features.find((item) => item.id === id)!;
    await runtime.execute(
      feature,
      { id: "start-with-audio", label: "Start", session: true },
      defaults(feature),
    );
    assert.deepEqual(calls, [
      `${companion}:start`,
      `${id}:show`,
      ...(id === "playback-notification"
        ? ["play", "pause", "stop"].map((control) => `${id}:control:${control}`)
        : []),
    ]);
    assert.equal(runtime.getSnapshot().activeId, id);
    await runtime.stopAll();
    assert.equal(cleaned, 1);
    assert.equal(runtime.getSnapshot().activeId, null);
  }
});
test("Stop while notification recorder is starting prevents the notification appearing later", async () => {
  const { runtime, backend } = runtimeHarness();
  let release!: () => void,
    entered = false;
  const calls: string[] = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.run = async (...args: unknown[]) => {
    calls.push(String(args[0]));
    if (args[0] === "record-file") {
      entered = true;
      await gate;
    }
    return manual("Started");
  };
  const feature = features.find(
    (item) => item.id === "recording-notification",
  )!;
  const start = runtime.execute(
    feature,
    { id: "start-with-audio", label: "Start", session: true },
    defaults(feature),
  );
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  const stop = runtime.stopAll();
  release();
  await start;
  await stop;
  assert.deepEqual(calls, ["record-file"]);
  assert.equal(runtime.getSnapshot().activeId, null);
});
test("a rejected notification setup cleans up its newly started recorder and retains the failure", async () => {
  const { runtime, backend } = runtimeHarness();
  let cleaned = false;
  backend.run = async (...args: unknown[]) => {
    if (args[0] === "recording-notification")
      throw new BlockedError("Notification permission denied");
    return manual("Recording");
  };
  backend.idle = async () => {
    cleaned = true;
  };
  const feature = features.find(
    (item) => item.id === "recording-notification",
  )!;
  await runtime.execute(
    feature,
    { id: "start-with-audio", label: "Start", session: true },
    defaults(feature),
  );
  assert(cleaned);
  assert.equal(runtime.getSnapshot().activeId, null);
  assert.equal(runtime.getSnapshot().results[0].status, "blocked");
});
test("system checks start their selected test audio without switching to another tab", async () => {
  const { runtime, backend } = runtimeHarness();
  const calls: string[] = [];
  backend.run = async (...args: unknown[]) => {
    calls.push(`${args[0]}:${args[1]}`);
    return manual("Ready");
  };
  const feature = features.find((item) => item.id === "system-events")!;
  await runtime.execute(
    feature,
    { id: "start-with-audio", label: "Start", session: true },
    { ...defaults(feature), testAudio: "recording" },
  );
  assert.deepEqual(calls, [
    "record-file:start",
    "system-events:observe",
    "recording-notification:show",
  ]);
  await runtime.stopAll();
});
test("recording recovery starts its own microphone and notification without consuming an old result", async () => {
  const { runtime, backend } = runtimeHarness();
  const calls: string[] = [];
  backend.run = async (...args: unknown[]) => {
    calls.push(`${args[0]}:${args[1]}`);
    return manual("Ready");
  };
  const feature = features.find((item) => item.id === "record-recovery")!;
  await runtime.execute(
    feature,
    { id: "start-with-audio", label: "Start", session: true },
    defaults(feature),
  );
  assert.deepEqual(calls, [
    "record-file:start",
    "record-recovery:inspect",
    "recording-notification:show",
  ]);
  await runtime.stopAll();
});
test("a notification-ended child cleanup error is preserved by the production supervisor", async () => {
  const { runtime, backend } = runtimeHarness();
  let observed = "";
  await runtime.exclusiveStress("production-supervisor", async (root) => {
    root.defer(
      runtime.observeScenarioFaults(root, (error) => {
        observed = String(error);
      }),
    );
    const child = new SessionScope("record-file", root);
    child.defer(() => {
      throw new Error("File finalization failed");
    });
    root.defer(() => child.dispose());
    backend.onSessionEnded(child);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.alive, true);
    assert.match(observed, /resources failed to stop/);
  });
});

test("feature Stop cancels its pending start instead of being ignored as busy", async () => {
  const { runtime, backend } = runtimeHarness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.run = async () => {
    await pending;
    return manual("Started");
  };
  const feature = features.find((item) => item.id === "oscillator")!;
  const starting = runtime.execute(
    feature,
    feature.actions.find((action) => action.id === "start")!,
    defaults(feature),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = runtime.execute(
    feature,
    { id: "stop", label: "Stop" },
    defaults(feature),
  );
  await stopping;
  release();
  await starting;
  assert.equal(runtime.getSnapshot().activeId, null);
  const results = runtime.getSnapshot().results;
  assert.equal(
    results.find((result) => result.action === "stop")?.status,
    "passed",
  );
  assert.equal(
    results.find((result) => result.action === "start")?.status,
    "blocked",
  );
});
