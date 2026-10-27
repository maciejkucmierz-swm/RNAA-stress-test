import { scenario } from "../production/catalog";
import { environmentProfile } from "../production/environment";
import type { Settings } from "../workshop/types";
import { featureLoadPlan } from "./feature-load";

export const stressFeatures = [
  {
    id: "graph-churn",
    name: "Graph Churn",
    minutes: 3,
    explanation:
      "Change sound effects and their connections repeatedly while a sound keeps playing.",
    usage:
      "A looping local buffer passes through a wave shaper. Replace its curve and reconnect the graph 100 times.",
    previous:
      "iOS live edits worked. Later Android edits were unverified after inspection timeouts. Session-owned replacements may accumulate until cleanup.",
    method:
      "Manual Android comparison without/with CDP first; runner generates load. Listen briefly by hand.",
    manual: [
      "Compare Android live edits with CDP disconnected and attached; record which setup was used.",
      "Listen for unexpected silence, repetition, or glitches.",
    ],
  },
  {
    id: "lifecycle-storm",
    name: "Lifecycle Storm",
    minutes: 3,
    explanation:
      "Start, pause, stop, and replace audio sessions rapidly without leaving old sound or resources behind.",
    usage:
      "100 seeded source/context cycles, including cancellation during decode/resume and recording finalization.",
    previous:
      "Individual lifecycle, demo switching, Stop all, and background-return checks completed. Sustained cycling was not tested.",
    method:
      "Runner performs the cycles. Argent only starts the preset and collects the result.",
    manual: [
      "After the run, confirm silence and start a normal demo successfully.",
    ],
  },
  {
    id: "notification-race",
    name: "Notification Race",
    minutes: 4,
    explanation:
      "Keep system Play/Pause controls and the actual sound in agreement when commands overlap.",
    usage:
      "100 seeded rounds of real notification updates and synthetic delivery to the same app handlers, including Hide/update races.",
    previous:
      "Real Android Pause → Play → Pause, suspended updates, and repeated Hide passed targeted retests. Recording controls finalized a short file.",
    method:
      "Use the runner for races. Operate real OS controls manually; do not spend minutes automating the notification drawer.",
    manual: [
      "Use actual OS Play → Pause → Play, then Hide and Stop; confirm displayed state matches sound.",
      "On Android, use recording notification Stop and confirm exactly one finalized recording.",
    ],
  },
  {
    id: "queue-pressure",
    name: "Queue Pressure",
    minutes: 3,
    explanation:
      "Feed small pieces of sound into a queue and check for missing, repeated, or reordered pieces.",
    usage:
      "Numbered PCM blocks at depths 1, 8, 32, and 128; jitter, starvation/refill, pause/restart, dequeue, and clear.",
    previous:
      "Default start failed before the pinned JS patch. Retests passed transport and completion events; sustained sample continuity was not measured.",
    method:
      "Runner checks sample summaries and completion IDs. A person performs a short listening check.",
    manual: [
      "Use Playback → Queued buffers for a short listening check. Numeric stress markers verify frames; starvation in the stress preset is deliberate.",
    ],
  },
  {
    id: "recorder-endurance",
    name: "Recorder Endurance",
    minutes: 5,
    explanation:
      "Record microphone audio to a file, sample callbacks, and a graph at the same time without losing data.",
    usage:
      "Three minutes of combined capture, with pause/resume, file rotation, and a bounded slow consumer. Speaker monitoring stays off.",
    previous:
      "Short combined captures, several formats, rotation, and replay worked. Long-session reliability remains unverified.",
    method:
      "Runner handles recording and file checks. Replay short sections by hand. Longer soaks run unattended.",
    manual: [
      "Replay retained segments around pause and rotation boundaries and confirm expected content.",
    ],
  },
  {
    id: "worklet-budget",
    name: "Worklet Budget",
    minutes: 4,
    explanation:
      "Find how much custom audio processing can run before sound processing falls behind.",
    usage:
      "Known tone through 1, 2, 4, and 8 processing nodes, on AudioRuntime/UIRuntime, with idle and busy UI phases.",
    previous:
      "Observe, gain processing, and generated sound produced valid sample metrics. No native processing limit has been measured.",
    method:
      "Runner generates load; native traces are needed for capacity. Listening is manual. Argent UI timing is not audio timing.",
    manual: ["Listen for dropouts during both idle and busy UI phases."],
  },
  {
    id: "decode-flood",
    name: "Decode Flood",
    minutes: 4,
    explanation:
      "Load several audio files together and check speed, correctness, memory demand, and recovery from bad files.",
    usage:
      "Local codecs at concurrency 1, 2, 4, and 8, resampling, malformed bytes, cancellation, and separate raw/fallback duration results.",
    previous:
      "HTTPS decoding fix passed. Native Ogg duration is still zero on both platforms; decoding yields the correct three-second fallback.",
    method:
      "Runner handles all repeated file work. Argent only starts and retrieves the report.",
    manual: [],
  },
  {
    id: "streaming-recovery",
    name: "Streaming Recovery",
    minutes: 4,
    explanation:
      "Recover streaming playback when the network stalls or fails while the user changes position or source.",
    usage:
      "Modern Audio component against a controlled local fault server; slow/stalled/truncated/error responses, seeks, pause/play, and source replacement.",
    previous:
      "Ordinary media, seek, routing, and legacy HLS paths were exercised. Controlled network-fault recovery has not been tested.",
    method:
      "Runner and local fault server generate repeatable faults. Check audible recovery and background/return manually.",
    manual: [
      "Confirm audible recovery after a stall, then background and return once.",
      "Legacy HLS streamer is a separate deprecated-path check, not covered by the modern player result.",
    ],
  },
] as const;

export type StressId =
  | (typeof stressFeatures)[number]["id"]
  | "feature-load"
  | "production-case";
export type StressProfile = "quick" | "capacity" | "soak-30" | "soak-120";
export function stressFeature(id: StressId, options?: StressOptions) {
  if (id === "production-case") {
    if (!options) throw new Error("Production settings required.");
    const selected = scenario(options.scenarioId ?? "");
    return {
      name: selected.name,
      explanation: selected.story,
      usage: selected.action,
      previous:
        "Production scenarios have independent evidence; previous functional passes are not qualification.",
      method: selected.automatic
        ? "Runner + native measurements; listening remains manual."
        : "Manual OS actions + runner recovery checks + native journal.",
      manual: [
        "Confirm actual sound/recording and the expected behaviour: " +
          selected.expected,
        "After completion, confirm no stuck sound/microphone and a normal session works.",
      ],
    };
  }
  if (id === "feature-load") {
    if (!options) throw new Error("Inline load settings are required.");
    const plan = featureLoadPlan(options);
    return {
      name: `${plan.feature.title} · level ${plan.level}`,
      explanation: plan.feature.description,
      usage: plan.usage,
      previous:
        "See this feature’s functional history; inline load results are separate.",
      method: plan.keepRunning
        ? "Live session with manual disruptions."
        : "In-app repeated operations, with manual listening where needed.",
      manual: plan.manual,
    };
  }
  return stressFeatures.find((feature) => feature.id === id)!;
}

export interface StressOptions {
  seed: number;
  profile: StressProfile;
  serverUrl: string;
  operator: "manual" | "argent";
  instrumentation: "disconnected" | "attached" | "unknown";
  memoryMiB: number;
  fileMiB: number;
  targetFeatureId?: string;
  targetSettings?: Settings;
  level?: number;
  scenarioId?: string;
  scenarioDuration?: "quick" | "thermal-15";
  environmentProfile?: string;
  loadMode?: "repeat" | "live";
  companion?: "playback" | "recording";
}
export const defaultStressOptions: StressOptions = {
  seed: 20261020,
  profile: "quick",
  serverUrl: "http://127.0.0.1:8099",
  operator: "manual",
  instrumentation: "unknown",
  memoryMiB: 96,
  fileMiB: 128,
};
export function stressLimits(id: StressId, options: StressOptions) {
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffffffff
  )
    throw new Error("Seed must be an unsigned 32-bit integer.");
  if (
    !Number.isFinite(options.memoryMiB) ||
    options.memoryMiB < 16 ||
    options.memoryMiB > 256
  )
    throw new Error("Owned-buffer budget must be 16–256 MiB.");
  if (
    !Number.isFinite(options.fileMiB) ||
    options.fileMiB < 8 ||
    options.fileMiB > 512
  )
    throw new Error("File budget must be 8–512 MiB.");
  if (id === "production-case") {
    scenario(options.scenarioId ?? "");
    if (
      !Number.isInteger(options.level) ||
      options.level! < 1 ||
      options.level! > 10
    )
      throw new Error("Production level must be 1–10.");
    environmentProfile(options.level!, 1, options.environmentProfile);
    if (
      options.scenarioDuration === "thermal-15" &&
      options.scenarioId !== "pressure"
    )
      throw new Error("Thermal runs are for Phone under heavy load only.");
    return {
      cycles: options.level! <= 5 ? options.level! : 1,
      recordingMs: options.scenarioDuration === "thermal-15" ? 900000 : 60000,
      runtimeMs: options.scenarioDuration === "thermal-15" ? 1200000 : 300000,
      memoryBytes: options.memoryMiB * 1024 * 1024,
      fileBytes: options.fileMiB * 1024 * 1024,
    };
  }
  if (options.profile.startsWith("soak") && id !== "recorder-endurance")
    throw new Error(
      "30/120 minute profiles are available for Recorder Endurance only.",
    );
  if (id === "feature-load") {
    const plan = featureLoadPlan(options);
    return {
      cycles: plan.cycles,
      recordingMs: plan.durationMs,
      runtimeMs: 300_000,
      memoryBytes: options.memoryMiB * 1024 * 1024,
      fileBytes: options.fileMiB * 1024 * 1024,
    };
  }
  const recordingMs =
    options.profile === "soak-120"
      ? 7_200_000
      : options.profile === "soak-30"
        ? 1_800_000
        : 180_000;
  return {
    cycles: options.profile === "quick" ? 100 : 1000,
    recordingMs,
    runtimeMs:
      id === "recorder-endurance"
        ? recordingMs + 120_000
        : options.profile === "quick"
          ? 300_000
          : 900_000,
    memoryBytes: options.memoryMiB * 1024 * 1024,
    fileBytes: options.fileMiB * 1024 * 1024,
  };
}
