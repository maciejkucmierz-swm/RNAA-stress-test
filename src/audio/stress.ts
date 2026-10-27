import { File } from "expo-file-system";
import { Platform } from "react-native";
import * as API from "react-native-audio-api";
import { scheduleOnRN } from "react-native-worklets";
import type { StressId, StressOptions } from "../stress/catalog";
import { stressWave } from "../stress/fixtures";
import { StressBudgetError, type StressProbe } from "../stress/runner";
import { SessionScope } from "../workshop/session";
import { BlockedError, CancelledError, type Settings } from "../workshop/types";
import type { Emit, NativeStressPort } from "./contracts";
import { fixtureBytes, fixtureMetadata, fixturePath } from "./fixtures";
const noEvents: Emit = () => {};
function finite(buffer: API.AudioBuffer) {
  for (let ch = 0; ch < buffer.numberOfChannels; ch++)
    if (!buffer.getChannelData(ch).every(Number.isFinite)) return false;
  return true;
}
function firstChannelRms(buffer: API.AudioBuffer) {
  const data = buffer.getChannelData(0),
    frames = Math.min(data.length, 16384);
  let energy = 0;
  for (let index = 0; index < frames; index++)
    energy += data[index] * data[index];
  return Math.sqrt(energy / Math.max(1, frames));
}
async function child<T>(
  root: SessionScope,
  name: string,
  task: (scope: SessionScope) => Promise<T>,
) {
  const scope = new SessionScope(name, root);
  try {
    root.ensureActive();
    return await task(scope);
  } finally {
    await scope.dispose();
    root.ensureActive();
  }
}
async function until(
  probe: StressProbe,
  condition: () => boolean,
  timeoutMs: number,
  description: string,
) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end)
      throw new Error(`Timed out waiting for ${description}.`);
    await probe.wait(50);
  }
}

async function graphChurn(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  probe.tick("Looping buffer; replacing wave-shaper curves");
  let initial = 0,
    latest = 0;
  const emit: Emit = (name, value) => {
    if (name === "waveShaperOwnership") {
      latest = (value as { trackedNodes: number }).trackedNodes;
      if (!initial) initial = latest;
      probe.metric("sessionOwnedNodes", latest);
    }
  };
  await probe.operation("start-wave-shaper", () =>
    port.backend.run(
      "waveshaper",
      "start",
      { fixture: "stereo.wav", drive: 1, curveSize: 256 },
      root,
      emit,
    ),
  );
  for (let index = 0; index < probe.report.limits.cycles; index++) {
    await probe.operation(`replace-curve-${index + 1}`, () =>
      port.backend.run(
        "waveshaper",
        "apply",
        {
          drive: 2 + (index % 9),
          curveSize: [256, 512, 1024][Math.floor(probe.random() * 3)],
          oversample: ["none", "2x", "4x"][index % 3],
        },
        root,
        emit,
      ),
    );
    if (index % 10 === 0)
      await child(root, "graph-branch", async (scope) => {
        const ctx = port.context(),
          branch = ctx.createGain();
        branch.gain.value = 0;
        scope.defer(() => branch.disconnect());
        branch.connect(ctx.destination);
        branch.disconnect(ctx.destination);
        branch.connect(ctx.destination);
      });
    await probe.wait(probe.report.options.profile === "quick" ? 1000 : 100);
  }
  probe.metric("initialOwnedNodes", initial);
  probe.metric("replacementOwnershipGrowth", latest - initial);
  probe.check(
    "Every curve replacement acknowledged",
    probe.report.counters.completed >= probe.report.limits.cycles + 1,
    "Fresh sequence numbers and completed promises, not a previous UI summary.",
  );
  probe.unverified(
    "Native node reclamation and process memory",
    `JS session ownership grew from ${initial} to ${latest}. Native retained-object counts and post-cleanup memory require a trace; this is not a leak verdict.`,
  );
}

async function lifecycleStorm(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  probe.tick(
    "Cycling sources, context states, cancellation, and recorder finalization",
  );
  const path = await fixturePath("stereo.wav");
  let preventedLateStarts = 0,
    finalized = 0;
  for (let index = 0; index < probe.report.limits.cycles; index++) {
    await probe.operation(`lifecycle-${index + 1}`, () =>
      child(root, "lifecycle-cycle", async (scope) => {
        const ctx = port.context();
        const source = ctx.createBufferSource();
        let started = false;
        scope.defer(() => {
          if (started) source.stop();
          source.disconnect();
        });
        const decoding = scope.hold(ctx.decodeAudioData(path));
        if (index % 7 === 0) {
          const completion = decoding.then((buffer) => {
            scope.ensureActive();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start();
            started = true;
          });
          // Attach rejection handling before cancellation, so no promise is unhandled.
          const settled = completion.then(
            () => "started",
            (error) =>
              error instanceof CancelledError
                ? "cancelled"
                : Promise.reject(error),
          );
          await scope.dispose();
          if ((await settled) === "cancelled") preventedLateStarts++;
        } else {
          source.buffer = await decoding;
          scope.ensureActive();
          const gain = ctx.createGain();
          gain.gain.value = 0.03;
          source.connect(gain);
          gain.connect(ctx.destination);
          scope.defer(() => gain.disconnect());
          await scope.hold(ctx.resume());
          scope.ensureActive();
          source.start();
          started = true;
          await probe.wait(80);
          await scope.hold(ctx.suspend());
          const resuming = scope.hold(ctx.resume());
          if (index % 5 === 0) await scope.dispose();
          await resuming;
        }
      }),
    );
    if (index % 25 === 24) {
      await child(root, "record-finalization", async (scope) => {
        await port.backend.run(
          "record-file",
          "start",
          {
            format: "Wav",
            channels: 1,
            preset: "Low",
            fileNamePrefix: "stress-lifecycle",
          },
          scope,
          noEvents,
        );
        await probe.wait(150);
        const stop = scope.dispose();
        await stop;
        await scope.dispose();
        finalized++;
      });
    }
    if (index % 10 === 9)
      await probe.operation("close-context", () =>
        port.backend.run("context", "close", {}, root, noEvents),
      );
    await probe.wait(probe.report.options.profile === "quick" ? 700 : 20);
  }
  probe.metric("cancelledDecodeStartsPrevented", preventedLateStarts);
  probe.metric("recorderFinalizations", finalized);
  probe.check(
    "Cancelled decode cannot start an old source",
    preventedLateStarts === Math.ceil(probe.report.limits.cycles / 7),
    `${preventedLateStarts} late starts prevented.`,
  );
  probe.check(
    "Recorder finalization is idempotent",
    finalized === Math.floor(probe.report.limits.cycles / 25),
    "Each short recording was disposed twice, with one owned stop.",
  );
  await probe.operation("fresh-session-after-churn", async () => {
    await child(root, "lifecycle-recovery", async (scope) => {
      const env = port.environment({}, scope, noEvents),
        tone = env.tone();
      tone.connect(env.output);
      await scope.hold(env.context.resume());
      scope.ensureActive();
      tone.start();
      await probe.wait(100);
    });
  });
  probe.unverified(
    "Native resource counts",
    "Context/source ownership and recovery were exercised; native retained counts require external profiling.",
  );
}

async function notificationRace(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  probe.tick("Notification handler races; real OS controls remain manual");
  await port.backend.run(
    "oscillator",
    "start",
    { frequency: 440 },
    root,
    noEvents,
  );
  const settings = {
    title: "RNAA stress test",
    artist: "Notification Race",
    duration: 300,
    state: "playing",
  };
  let transitions = 0,
    races = 0;
  const emit: Emit = (name, value) => {
    if (name === "notificationPlaybackState") {
      transitions++;
      probe.event(name, value);
    }
  };
  for (let index = 0; index < probe.report.limits.cycles; index++) {
    await probe.operation("show-notification", () =>
      port.backend.run("playback-notification", "show", settings, root, emit),
    );
    await probe.operation("synthetic-pause-play", async () => {
      const pause = port.dispatchPlayback("playbackNotificationPause");
      const play = port.dispatchPlayback("playbackNotificationPlay");
      await Promise.all([pause, play]);
      if (port.context().state !== "running")
        throw new Error("Last Play did not leave the context running.");
    });
    await probe.operation("hide-update-race", async () => {
      const update = port.backend.run(
        "playback-notification",
        "show",
        { ...settings, state: index % 2 ? "paused" : "playing" },
        root,
        emit,
      );
      const guarded = update.catch((error) => {
        if (!(error instanceof BlockedError)) throw error;
        races++;
      });
      await port.backend.run(
        "playback-notification",
        "hide",
        {},
        root,
        noEvents,
      );
      await guarded;
      await port.backend.run(
        "playback-notification",
        "hide",
        {},
        root,
        noEvents,
      );
      if (
        Platform.OS === "android" &&
        (await API.PlaybackNotificationManager.isActive())
      )
        throw new Error("Notification remained active after Hide settled.");
    });
    await probe.wait(probe.report.options.profile === "quick" ? 600 : 25);
  }
  probe.metric("syntheticStateTransitions", transitions);
  probe.metric("expectedSupersededShows", races);
  probe.check(
    "Ordered Pause/Play handler completion",
    transitions === probe.report.limits.cycles * 2,
    `${transitions} transitions; these are synthetic handler deliveries, not OS button taps.`,
  );
  probe.check(
    "Hide/update races settled",
    true,
    "No unexpected native exception; repeated Hide completed. Android active-state checked each round.",
  );
  if (Platform.OS === "ios")
    probe.unverified(
      "iOS system card removal",
      "The OS owns lock-screen media presentation; verify removal manually.",
    );
  await child(root, "notification-stop-boundary", async (scope) => {
    await port.backend.run(
      "oscillator",
      "start",
      { frequency: 440 },
      scope,
      noEvents,
    );
    await port.backend.run(
      "playback-notification",
      "show",
      settings,
      scope,
      emit,
    );
    await probe.operation("synthetic-scoped-stop", () =>
      port.dispatchPlayback("playbackNotificationStop"),
    );
    await scope.dispose();
    probe.check(
      "Synthetic Stop disposed its owned graph",
      !scope.alive,
      "The same Stop handler used by OS events ended the nested graph; this does not certify a real OS button.",
    );
  });
  await child(root, "notification-pending-stop", async (scope) => {
    await port.backend.run(
      "oscillator",
      "start",
      { frequency: 440 },
      scope,
      noEvents,
    );
    const showing = port.backend.run(
      "playback-notification",
      "show",
      settings,
      scope,
      emit,
    );
    const settled = showing.catch((error) => {
      if (!(error instanceof BlockedError)) throw error;
    });
    await scope.dispose();
    await port.backend.idle();
    await settled;
    probe.check(
      "Pending update drained across cleanup",
      port.context().state === "suspended",
      "Disposed the owned scope and ran the same backend idle cleanup used by Stop all; a full Stop all cancellation remains a separate runner regression.",
    );
  });
}

// Samples are reduced to bounded run-length summaries on the worklet runtime.
// Raw PCM is never retained in the UI, history, or exported telemetry.
async function queuePressure(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  for (const depth of [1, 8, 32, 128])
    await probe.operation(`queue-depth-${depth}`, () =>
      child(root, `queue-depth-${depth}`, async (scope) => {
        probe.tick(`Queued PCM: depth ${depth}`);
        const env = port.environment({}, scope, noEvents),
          ctx = env.context;
        const queue = env.track(ctx.createBufferQueueSource());
        const expected: string[] = [],
          ended: string[] = [],
          observed: number[] = [];
        const frameCounts: Record<number, number> = {};
        let badSamples = 0,
          summaries = 0;
        const report = (runs: number[], invalid: number) => {
          if (!scope.alive) return;
          summaries++;
          badSamples += invalid;
          for (let index = 0; index < runs.length; index += 2) {
            const id = runs[index],
              frames = runs[index + 1];
            if (id > 0) {
              if (observed.at(-1) !== id) observed.push(id);
              frameCounts[id] = (frameCounts[id] ?? 0) + frames;
            }
          }
        };
        const observer = env.track(
          ctx.createWorkletNode(
            (data) => {
              "worklet";
              const runs: number[] = [];
              let previous = -1,
                invalid = 0;
              for (let index = 0; index < data[0].length; index++) {
                const value = data[0][index],
                  id = Math.round(value * 256);
                if (
                  !Number.isFinite(value) ||
                  Math.abs(value - id / 256) > 0.00001 ||
                  id < 0 ||
                  id > 128
                )
                  invalid++;
                if (id === previous) runs[runs.length - 1]++;
                else {
                  runs.push(id, 1);
                  previous = id;
                }
              }
              scheduleOnRN(report, runs, invalid);
            },
            2048,
            1,
            "AudioRuntime",
          ),
        );
        queue.connect(observer);
        observer.connect(env.output);
        queue.onBufferEnded = (event) => {
          if (scope.alive) ended.push(event.bufferId);
        };
        scope.defer(() => {
          queue.onBufferEnded = null;
        });
        const frames = 2048;
        for (let index = 0; index < depth; index++) {
          const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
          buffer.getChannelData(0).fill((index + 1) / 256);
          expected.push(queue.enqueueBuffer(buffer));
        }
        await scope.hold(ctx.resume());
        scope.ensureActive();
        queue.start();
        await until(
          probe,
          () => ended.length >= depth,
          ((depth * frames) / ctx.sampleRate) * 1000 + 5000,
          `queue depth ${depth} completion`,
        );
        await probe.wait(250);
        probe.check(
          `Queue ${depth}: completion order`,
          JSON.stringify(ended) === JSON.stringify(expected),
          `${ended.length}/${expected.length} buffer IDs completed.`,
        );
        probe.check(
          `Queue ${depth}: rendered block order`,
          JSON.stringify(observed) ===
            JSON.stringify(Array.from({ length: depth }, (_, i) => i + 1)),
          `Observed ${observed.length} blocks in ${summaries} bounded sample summaries.`,
        );
        probe.check(
          `Queue ${depth}: exact rendered frames`,
          badSamples === 0 &&
            expected.every((_, index) => frameCounts[index + 1] === frames),
          `Invalid samples ${badSamples}; per-block frames expected ${frames}.`,
        );
        probe.metric(`queue.${depth}.expectedFrames`, depth * frames);
        probe.metric(
          `queue.${depth}.observedFrames`,
          Object.values(frameCounts).reduce((sum, value) => sum + value, 0),
        );
        // Deliberate starvation is separate from the supported-load integrity gate.
        let recovered = 0;
        for (
          let cycle = 0;
          cycle < (probe.report.options.profile === "quick" ? 10 : 100);
          cycle++
        ) {
          queue.pause();
          queue.clearBuffers();
          await probe.wait(50 + Math.floor(probe.random() * 100));
          const refill = ctx.createBuffer(1, frames, ctx.sampleRate);
          refill.getChannelData(0).fill(1 / 256);
          const removed = queue.enqueueBuffer(refill);
          queue.dequeueBuffer(removed);
          const refillId = queue.enqueueBuffer(refill);
          queue.start(0, 0);
          await until(
            probe,
            () => ended.includes(refillId),
            5000,
            "starvation refill",
          );
          queue.pause();
          queue.clearBuffers();
          if (!ended.includes(removed)) recovered++;
        }
        probe.check(
          `Queue ${depth}: starvation recovery`,
          recovered === (probe.report.options.profile === "quick" ? 10 : 100),
          `${recovered} seeded producer-delay/refill cycles. Injected silence, dequeue, explicit-offset restart, and clear are separate from continuity checks.`,
        );
        await probe.wait(100);
      }),
    );
  probe.check(
    "Queue workload completed",
    true,
    "Four queue-depth levels completed on the native engine with PCM summaries.",
  );
}

async function recorderEndurance(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  probe.tick("Combined microphone capture; monitoring off");
  const settings: Settings = {
    format: "Wav",
    preset: "Custom",
    recordRate: 16000,
    callbackRate: 16000,
    channels: 1,
    bitDepth: "Bit16",
    bufferLength: 1024,
    rotateBytes: 1024 * 1024,
    monitor: false,
    fileNamePrefix: `stress-${Date.now()}`,
    stressConsumerDelayMs: 180,
  };
  // Admit before recording: conservative PCM + headers margin, not a process-RSS claim.
  const expectedBytes =
    (probe.report.limits.recordingMs / 1000) * 16000 * 2 * 1.1;
  if (expectedBytes > probe.report.limits.fileBytes)
    throw new BlockedError(
      "Recording profile exceeds the file ceiling. Increase the file budget or select a shorter profile.",
    );
  const files = new Set<string>();
  let callbacks = 0,
    callbackFrames = 0,
    invalid = 0,
    backlog = 0,
    peakBacklog = 0,
    dropped = 0;
  let fileDuration = 0;
  const emit: Emit = (name, value) => {
    if (name === "captureCounters") {
      const stats = value as {
        callbacks: number;
        frames: number;
        invalid: number;
        backlog: number;
        peakBacklog: number;
        dropped: number;
      };
      callbacks = stats.callbacks;
      callbackFrames = stats.frames;
      invalid = stats.invalid;
      backlog = stats.backlog;
      peakBacklog = stats.peakBacklog;
      dropped = stats.dropped;
      probe.metric("callbackFrames", callbackFrames);
      probe.metric("consumerBacklog", backlog);
    }
    if (name === "fileInfo") {
      const info = value as API.FileInfo;
      info.paths.forEach((path) => files.add(path));
      fileDuration = info.duration;
    }
  };
  const start = Date.now();
  let pausedMs = 0;
  await child(root, "stress-combined-capture", async (scope) => {
    await probe.operation("start-combined-capture", () =>
      port.backend.run("record-combined", "start", settings, scope, emit),
    );
    while (Date.now() - start < probe.report.limits.recordingMs) {
      if (
        !pausedMs &&
        Date.now() - start >= probe.report.limits.recordingMs / 2
      ) {
        await probe.operation("pause-recording", () =>
          port.backend.run("record-combined", "pause", settings, scope, emit),
        );
        const pause = Date.now();
        await probe.wait(1000);
        await probe.operation("resume-recording", () =>
          port.backend.run("record-combined", "resume", settings, scope, emit),
        );
        pausedMs += Date.now() - pause;
      }
      const estimated =
        ((Date.now() - start - pausedMs) / 1000) * 16000 * 2 * 1.1;
      if (estimated >= probe.report.limits.fileBytes)
        throw new StressBudgetError(
          "Recording reached the estimated file ceiling.",
        );
      await probe.wait(250);
    }
  });
  let bytes = 0,
    decodedSeconds = 0,
    decodedFrames = 0;
  for (const path of files)
    await probe.operation("validate-recorded-segment", async () => {
      const file = new File(path);
      bytes += file.size;
      if (bytes > probe.report.limits.fileBytes)
        throw new StressBudgetError(
          "Finalized files exceeded the file ceiling.",
        );
      const buffer = await root.hold(API.decodeAudioData(path));
      root.ensureActive();
      if (!finite(buffer))
        throw new Error("Recorded segment has non-finite samples.");
      decodedSeconds += buffer.duration;
      decodedFrames += buffer.length;
      probe.event("recordedSegment", {
        path,
        frames: buffer.length,
        seconds: buffer.duration,
        bytes: file.size,
      });
    });
  const activeSeconds = (Date.now() - start - pausedMs) / 1000;
  probe.metric("files", files.size);
  probe.metric("fileBytes", bytes);
  probe.metric("fileReportedSeconds", fileDuration);
  probe.metric("decodedSeconds", decodedSeconds);
  probe.metric("decodedFrames", decodedFrames);
  probe.metric("callbackCount", callbacks);
  probe.metric("consumerPeakBacklog", peakBacklog);
  probe.metric("consumerDropped", dropped);
  probe.check(
    "Rotated files are nonempty and decodable",
    files.size >= 2 && bytes > 0,
    `${files.size} segments; ${decodedSeconds.toFixed(3)} decoded seconds.`,
  );
  probe.check(
    "PCM callbacks are valid and bounded",
    callbacks > 0 && invalid === 0 && dropped === 0 && peakBacklog <= 32,
    `${callbacks} callbacks; invalid ${invalid}, dropped ${dropped}, backlog ${backlog}.`,
  );
  probe.check(
    "Recording duration agrees with active time",
    Math.abs(decodedSeconds - activeSeconds) < 3,
    `Decoded ${decodedSeconds.toFixed(3)} s versus wall-clock active estimate ${activeSeconds.toFixed(3)} s; tolerance 3 s includes startup/finalization.`,
  );
  probe.check(
    "Callback frames agree with file duration",
    Math.abs(callbackFrames / 16000 - decodedSeconds) < 0.5,
    `Callback ${callbackFrames} frames at 16 kHz; tolerance 0.5 s for callback flush boundaries.`,
  );
  await child(root, "record-restart", async (scope) => {
    await port.backend.run("record-pcm", "start", settings, scope, noEvents);
    await probe.wait(200);
  });
  probe.unverified(
    "Native callback continuity and graph capture",
    "File/frame counts are checked; native per-frame discontinuity counters and graph-output integrity require further instrumentation. Files remain available in Recording for manual replay.",
  );
}

async function workletBudget(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  for (const runtime of ["AudioRuntime", "UIRuntime"] as const)
    for (const count of [1, 2, 4, 8])
      for (const busyUI of [false, true]) {
        await probe.operation(
          `worklets-${runtime}-${count}-${busyUI ? "busy" : "idle"}`,
          () =>
            child(root, `worklets-${runtime}-${count}`, async (scope) => {
              probe.tick(
                `${runtime}: ${count} processors; ${busyUI ? "busy" : "idle"} UI`,
              );
              probe.metric("uiLoadActive", busyUI);
              const env = port.environment({}, scope, noEvents),
                ctx = env.context;
              let reports = 0,
                bad = 0,
                rmsTotal = 0;
              const report = (rms: number, invalid: number) => {
                if (scope.alive) {
                  reports++;
                  bad += invalid;
                  rmsTotal += rms;
                }
              };
              const buffer = ctx.createBuffer(
                2,
                ctx.sampleRate,
                ctx.sampleRate,
              );
              for (let ch = 0; ch < 2; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < data.length; i++)
                  data[i] = Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
              }
              const source = env.track(ctx.createBufferSource());
              source.buffer = buffer;
              source.loop = true;
              let upstream: API.AudioNode = source;
              for (let index = 0; index < count; index++) {
                const node = env.track(
                  ctx.createWorkletProcessingNode((input, output, frames) => {
                    "worklet";
                    for (let ch = 0; ch < output.length; ch++)
                      for (let i = 0; i < frames; i++)
                        output[ch][i] = input[ch][i] * 0.9;
                  }, runtime),
                );
                upstream.connect(node);
                upstream = node;
              }
              const observer = env.track(
                ctx.createWorkletNode(
                  (data) => {
                    "worklet";
                    let energy = 0,
                      invalid = 0;
                    for (let i = 0; i < data[0].length; i++) {
                      const value = data[0][i];
                      energy += value * value;
                      if (!Number.isFinite(value)) invalid++;
                    }
                    scheduleOnRN(
                      report,
                      Math.sqrt(energy / data[0].length),
                      invalid,
                    );
                  },
                  8192,
                  2,
                  runtime,
                ),
              );
              upstream.connect(observer);
              observer.connect(env.output);
              await scope.hold(ctx.resume());
              scope.ensureActive();
              source.start();
              await probe.wait(
                probe.report.options.profile === "quick" ? 5000 : 30000,
              );
              const expected = Math.SQRT1_2 * 0.9 ** count,
                average = rmsTotal / Math.max(1, reports);
              probe.check(
                `${runtime}/${count}/${busyUI ? "busy" : "idle"} signal`,
                reports > 0 && bad === 0 && Math.abs(average - expected) < 0.04,
                `${reports} summaries; RMS ${average.toFixed(5)}, expected ${expected.toFixed(5)} ± 0.04; invalid ${bad}.`,
              );
              probe.metric(
                `${runtime}.${count}.${busyUI ? "busy" : "idle"}.rms`,
                average,
              );
            }),
        );
      }
  probe.metric("uiLoadActive", false);
  probe.unverified(
    "Native rendering deadlines and supported capacity",
    "RNAA 0.13.6 exposes no whole-graph deadline counter. Sample checks cannot certify zero underruns. Collect Perfetto/Instruments evidence on physical hardware before declaring capacity.",
  );
}

async function decodeFlood(
  port: NativeStressPort,
  root: SessionScope,
  probe: StressProbe,
) {
  probe.tick("Local codec decode batches and raw duration probes");
  const fixtures = [
    "stereo.wav",
    "stereo.mp3",
    "stereo.flac",
    "stereo.ogg",
    "stereo.opus",
    "stereo.aac",
    "stereo.m4a",
    "stereo.mp4",
  ];
  const paths = await Promise.all(fixtures.map(fixturePath));
  let peakOwned = 0,
    cancelled = 0;
  const batches = probe.report.options.profile === "quick" ? 2 : 20;
  for (const concurrency of [1, 2, 4, 8])
    for (let batch = 0; batch < batches; batch++) {
      const indexes = Array.from(
        { length: concurrency },
        (_, index) => (batch * concurrency + index) % fixtures.length,
      );
      const estimated = indexes.reduce(
        (sum, index) =>
          sum +
          Math.ceil(fixtureMetadata[fixtures[index]].duration * 48000) *
            fixtureMetadata[fixtures[index]].channels *
            4 *
            3,
        0,
      );
      if (estimated > probe.report.limits.memoryBytes)
        throw new BlockedError(
          "Decode batch exceeds the conservative owned-buffer ceiling.",
        );
      await probe.operation(
        `decode-concurrency-${concurrency}-batch-${batch}`,
        async () => {
          const jobs = indexes.map(async (index) => {
            const targetRate = batch % 2 ? 16000 : 48000;
            const buffer = await root.hold(
              API.decodeAudioData(paths[index], targetRate),
            );
            root.ensureActive();
            const metadata = fixtureMetadata[fixtures[index]];
            if (
              !finite(buffer) ||
              Math.abs(firstChannelRms(buffer) - 0.3 * Math.SQRT1_2) > 0.04 ||
              Math.abs(buffer.duration - metadata.duration) > 0.15 ||
              buffer.sampleRate !== targetRate ||
              buffer.numberOfChannels !== metadata.channels
            )
              throw new Error(
                `Decoded format/sample mismatch: ${fixtures[index]}`,
              );
            return buffer;
          });
          // Settle every native decode before admitting another batch or releasing ownership.
          const results = await Promise.allSettled(jobs);
          const error = results.find((result) => result.status === "rejected");
          if (error?.status === "rejected") throw error.reason;
          let owned = 0;
          for (const result of results)
            if (result.status === "fulfilled")
              owned += result.value.length * result.value.numberOfChannels * 4;
          peakOwned = Math.max(peakOwned, owned);
        },
      );
      await probe.wait(100);
    }
  for (const seconds of [15, 60])
    for (const concurrency of [1, 2, 4, 8]) {
      const inputBytes = 44 + seconds * 16000 * 2;
      const estimated = inputBytes + concurrency * seconds * 48000 * 4 * 3;
      if (estimated > probe.report.limits.memoryBytes) {
        probe.event("decodeAdmissionLimited", {
          seconds,
          concurrency,
          estimatedBytes: estimated,
          budgetBytes: probe.report.limits.memoryBytes,
        });
        continue;
      }
      const input = stressWave(seconds);
      await probe.operation(
        `generated-${seconds}s-concurrency-${concurrency}`,
        async () => {
          const jobs = Array.from({ length: concurrency }, async () => {
            const buffer = await root.hold(API.decodeAudioData(input, 48000));
            root.ensureActive();
            if (
              !finite(buffer) ||
              Math.abs(firstChannelRms(buffer) - 0.25 * Math.SQRT1_2) > 0.02 ||
              buffer.numberOfChannels !== 1 ||
              Math.abs(buffer.duration - seconds) > 0.01 ||
              buffer.sampleRate !== 48000
            )
              throw new Error("Generated WAV decode/resampling mismatch.");
            return buffer.length * 4;
          });
          const results = await Promise.allSettled(jobs);
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
          const bytes = results.reduce(
            (sum, result) =>
              sum + (result.status === "fulfilled" ? result.value : 0),
            0,
          );
          peakOwned = Math.max(peakOwned, bytes);
          probe.event("generatedDecode", {
            seconds,
            concurrency,
            decodedBytes: bytes,
            estimatedAdmissionBytes: estimated,
          });
        },
      );
    }
  const malformed = new Uint8Array([1, 3, 3, 7, 0, 0, 0, 0]).buffer;
  let rejected = false;
  try {
    await root.hold(API.decodeAudioData(malformed));
  } catch {
    rejected = true;
  }
  probe.check(
    "Malformed input rejects",
    rejected,
    "Malformed bytes must not produce a successful buffer.",
  );
  await child(root, "decode-cancellation", async (scope) => {
    const pending = scope.hold(API.decodeAudioData(paths[0])).then(() => {
      scope.ensureActive();
    });
    const completion = pending.catch((error) => {
      if (error instanceof CancelledError) cancelled++;
      else throw error;
    });
    await scope.dispose();
    await completion;
  });
  const bytes = await fixtureBytes("stereo.ogg");
  for (const [kind, input] of [
    ["local", paths[3]],
    ["arrayBuffer", bytes],
  ] as const) {
    const nativeDuration = await root.hold(API.getAudioDuration(input));
    root.ensureActive();
    const decodedDuration = (await root.hold(API.decodeAudioData(input)))
      .duration;
    probe.event("oggDuration", {
      input: kind,
      nativeDuration,
      decodedDuration,
      source: "separate-public-api-checks",
    });
    probe.check(
      `Ogg ${kind}: native metadata duration`,
      Math.abs(nativeDuration - 3) < 0.05,
      `Raw native duration ${nativeDuration}; no substitute is used.`,
    );
    probe.check(
      `Ogg ${kind}: decoded sample duration`,
      Math.abs(decodedDuration - 3) < 0.05,
      `Independent decodeAudioData check: ${decodedDuration} seconds. This does not replace the metadata result.`,
    );
  }
  probe.metric("peakOwnedDecodedBytes", peakOwned);
  probe.metric("cancelledDecodeStartsPrevented", cancelled);
  probe.check(
    "Decode batches and cancellation completed",
    cancelled === 1,
    "Each native batch settled; disposed decode completion did not start playback.",
  );
  probe.unverified(
    "Process peak/retained memory",
    "Owned PCM and generated 15/60-second inputs are admission-bounded. Process RSS, decoder scratch allocations, and GC reclamation need native profiling; skipped combinations are recorded as admission-limited.",
  );
}

async function streamingRecovery(
  port: NativeStressPort,
  options: StressOptions,
  root: SessionScope,
  probe: StressProbe,
) {
  const base = options.serverUrl.replace(/\/$/, "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?$/.test(base))
    throw new BlockedError(
      "Use the local fault server URL (127.0.0.1, localhost, or Android emulator 10.0.2.2).",
    );
  probe.tick("Checking controlled local fault server");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 3000);
  const unregisterAbort = root.defer(() => controller.abort());
  try {
    const response = await fetch(`${base}/health`, {
      signal: controller.signal,
    });
    const info = await response.json();
    if (!response.ok || info.service !== "rnaa-stress-faults-v1")
      throw new Error("Unexpected fixture server.");
    probe.event("faultServer", info);
  } catch (error) {
    throw new BlockedError(
      `Start npm run stress:server and map port 8099 to the device. ${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    unregisterAbort();
  }
  for (const fault of ["normal", "slow", "stall", "truncate", "retry"]) {
    await child(root, `stream-${fault}`, async (scope) => {
      probe.tick(`Modern Audio component: ${fault}`);
      let loaded = false,
        position = 0,
        plays = 0,
        errors = 0,
        waiting = 0;
      const emit: Emit = (name, value) => {
        if (name !== "position")
          probe.event(
            `media.${fault}.${name}`,
            value instanceof Error ? value.message : value,
          );
        else probe.metric(`stream.${fault}.position`, Number(value));
        if (name === "load") loaded = true;
        if (name === "position") position = Number(value);
        if (name === "play" || name === "playing") plays++;
        if (name === "error") errors++;
        if (name === "waiting") waiting++;
      };
      const settings = {
        input: "url",
        url: `${base}/audio.wav?fault=${fault}&run=${probe.report.id}`,
        autoPlay: true,
        loop: true,
        controls: false,
        volume: 0.1,
        stressExpectedNetworkFailure: fault === "truncate" || fault === "retry",
      };
      await probe.operation(`mount-${fault}`, () =>
        port.backend.run("audio-tag", "start", settings, scope, emit),
      );
      if (fault === "truncate" || fault === "retry") {
        await probe.wait(3000);
        probe.event("originalStreamingOutcome", {
          fault,
          errors,
          loaded,
          position,
          waiting,
          repaired: false,
        });
        probe.unverified(
          `Stream ${fault}: original-source recovery`,
          "The original faulted source was observed but sustained recovery was not established. A later normal source is a separate usability check.",
        );
        // A controlled source replacement is explicit app recovery; no automatic retry claim.
      } else {
        try {
          await until(
            probe,
            () => loaded && position > 0,
            15000,
            `${fault} playback progress`,
          );
        } finally {
          probe.event("streamProgressGate", {
            fault,
            loaded,
            position,
            plays,
            errors,
            waiting,
            contextState: port.backend.mediaContext?.state ?? null,
          });
        }
        for (
          let index = 0;
          index < (options.profile === "quick" ? 8 : 333);
          index++
        ) {
          await probe.operation("seek-pause-resume", async () => {
            await port.backend.run(
              "audio-tag",
              "seek",
              { seek: 0.25 + probe.random() * 2 },
              scope,
              emit,
            );
            await port.backend.run("audio-tag", "pause", {}, scope, emit);
            await port.backend.run("audio-tag", "resume", {}, scope, emit);
          });
          await probe.wait(150);
        }
        probe.check(
          `Stream ${fault}: playback progressed`,
          loaded && position > 0 && plays > 0,
          `Position ${position}, play/playing ${plays}, waiting ${waiting}, errors ${errors}.`,
        );
      }
    });
    await child(root, `stream-${fault}-recovery`, async (scope) => {
      let loaded = false,
        progress = 0;
      const emit: Emit = (name, value) => {
        if (name === "load") loaded = true;
        if (name === "position") progress = Number(value);
      };
      await port.backend.run(
        "audio-tag",
        "start",
        {
          input: "url",
          url: `${base}/audio.wav?fault=normal&run=${probe.report.id}-${fault}`,
          autoPlay: true,
          loop: true,
          controls: false,
        },
        scope,
        emit,
      );
      await until(
        probe,
        () => loaded && progress > 0,
        10000,
        "clean source recovery",
      );
      probe.check(
        `Stream ${fault}: separate normal-source usability`,
        true,
        "Separate normal source emitted load and position after the original outcome was recorded and its scope disposed. This does not pass original-source recovery.",
      );
    });
  }
  const stats = (await (
    await fetch(`${base}/stats?run=${encodeURIComponent(probe.report.id)}`)
  ).json()) as { fault: string; injected: boolean }[];
  probe.event("faultServerRequests", stats);
  probe.check(
    "Controlled faults reached the server",
    ["slow", "stall", "truncate", "retry"].every((fault) =>
      stats.some((entry) => entry.fault === fault && entry.injected),
    ),
    `${stats.length} app-owned fixture requests recorded by the local server.`,
  );
  probe.unverified(
    "Duplicate audio, cache growth, and legacy HLS",
    "Fresh modern-player load/position is checked. Audible duplication and background recovery remain manual; native cache growth and the deprecated streamer need separate evidence.",
  );
}

export async function executeNativeStress(
  id: StressId,
  options: StressOptions,
  root: SessionScope,
  probe: StressProbe,
  port: NativeStressPort,
) {
  probe.metric("processMemoryMeasured", false);
  probe.metric("nativeRenderDeadlinesMeasured", false);
  if (id === "feature-load" || id === "production-case")
    throw new BlockedError(
      "Inline feature workloads are dispatched by the app runner.",
    );
  const tasks = {
    "graph-churn": graphChurn,
    "lifecycle-storm": lifecycleStorm,
    "notification-race": notificationRace,
    "queue-pressure": queuePressure,
    "recorder-endurance": recorderEndurance,
    "worklet-budget": workletBudget,
    "decode-flood": decodeFlood,
  };
  if (id === "streaming-recovery")
    await streamingRecovery(port, options, root, probe);
  else await tasks[id](port, root, probe);
  probe.tick("Workload complete; draining owned resources");
}
