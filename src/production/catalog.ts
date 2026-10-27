import { featureLoadRecipe } from "../stress/feature-load";
import type { Feature } from "../workshop/types";
export const scenarios = [
  {
    id: "stop-pending",
    name: "Stop during unfinished work",
    story:
      "The user stops while audio is still starting, then immediately tries again.",
    automatic: true,
    action: "The runner stops a pending start and creates a fresh session.",
    expected:
      "Old work settles without restarting sound. The new session works.",
  },
  {
    id: "interruption",
    name: "Another app takes audio",
    story: "Music, a call, or another recorder takes audio away from this app.",
    automatic: false,
    action:
      "Open another audio app, start its sound or recorder, then stop it and return. Android helper instructions are available below.",
    expected:
      "Playback resumes only when the OS permits and the user still wants it. Interrupted recording requires Resume.",
  },
  {
    id: "notification-stop",
    name: "Notification Stop during disruption",
    story:
      "The user stops recording from a notification while changing apps or being interrupted.",
    automatic: false,
    action:
      "Background this app, interrupt audio, press the actual recording notification Stop, and return.",
    expected:
      "One finalization, no stuck microphone, and the next recording starts.",
  },
  {
    id: "pressure",
    name: "Phone under heavy load",
    story: "The phone is busy while audio must keep working.",
    automatic: true,
    action:
      "The app applies the selected environment: native CPU/RAM pressure, JavaScript pauses, delayed commands, or a combination.",
    expected:
      "Collect achieved pressure and faults, remove load, and verify recovery and a fresh session.",
  },
  {
    id: "volume",
    name: "Volume changed underneath us",
    story:
      "The user changes volume or mute while another app interrupts sound.",
    automatic: false,
    action:
      "Use the volume/mute controls below and hardware volume buttons, interrupt with another app, then return.",
    expected:
      "The latest user choices survive. System ducking is recorded separately from app gain.",
  },
  {
    id: "routes-background",
    name: "Routes and background change together",
    story: "The user locks the phone or disconnects headphones during audio.",
    automatic: false,
    action:
      "Switch apps, lock/unlock, disconnect/reconnect headphones or Bluetooth, and return. Removing from Recents is a separate build-dependent check.",
    expected:
      "Route and lifecycle events are recorded. Gaps or duplicate sound are reported; another session works.",
  },
  {
    id: "background-only",
    name: "Leave the app and return",
    story: "The user switches apps or locks the screen while audio is active.",
    automatic: false,
    action:
      "Leave the app for at least ten seconds, then return. Lock/unlock only if practical. No headphone or Bluetooth changes are required.",
    expected:
      "Real background/return events, valid audio or saved files, and a usable fresh session. App removal from Recents is separate.",
  },
  {
    id: "service-reset",
    name: "Real audio-service restart",
    story: "The phone’s system audio service disappears and restarts.",
    automatic: false,
    action:
      "iPhone: Settings → Developer → Reset Media Services. Root-capable Android: run the host service-reset tool. Then return and explicitly press Resume.",
    expected:
      "Verify a real native reset first, preserve RNAA’s original response, and test user-initiated rebuilding separately.",
  },
  {
    id: "combined",
    name: "Combined production failure",
    story: "Load, interruptions, route changes, and a user Stop overlap.",
    automatic: false,
    action:
      "Background the app under load, interrupt or change route, press Stop audio, return, end the disruption, and explicitly Resume.",
    expected:
      "No stale restart, valid retained recordings where possible, load released, and a fresh session works. Original failures remain findings.",
  },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
export function scenarioContract(
  id: ScenarioId,
  featureId: string,
  workloadFeatureId: string,
) {
  return {
    featureId,
    workloadFeatureId,
    platforms: id === "notification-stop" ? ["android"] : ["android", "ios"],
    requiredCapabilities:
      id === "service-reset"
        ? ["native-journal", "real-service-reset"]
        : id === "pressure" || id === "combined"
          ? ["native-journal", "native-pressure"]
          : ["audio-session"],
    expectedTransitions: ["baseline", "disruption", "recovery", "verification"],
    recoveryPolicy:
      "Documented client pause/resume handlers use existing public RNAA objects. No automatic retry or engine rebuild. Recording needs explicit Resume; stopped/reset sessions need a separately requested new session.",
    evidenceRequirements: [
      "Verified fault source",
      "Original response before repair",
      "Five-second recovery observation",
      "Fresh session",
      "Manual sound or recording-file review",
    ],
  };
}
export function scenario(id: string) {
  const found = scenarios.find((item) => item.id === id);
  if (!found) throw new Error("Choose a production scenario.");
  return found;
}
export function applicableScenarios(feature: Feature) {
  if (["permissions", "capabilities"].includes(feature.id)) return [];
  if (
    !featureLoadRecipe(feature).live &&
    !["context", "session", "graph"].includes(feature.id)
  )
    return scenarios.filter((item) =>
      ["stop-pending", "pressure"].includes(item.id),
    );
  return scenarios.filter(
    (item) =>
      item.id !== "notification-stop" ||
      feature.category === "Recording" ||
      feature.id === "recording-notification",
  );
}
export function pressureProfile(level: number, cores: number) {
  if (!Number.isInteger(level) || level < 1 || level > 10)
    throw new Error("Production level must be 1–10.");
  return {
    rounds: level <= 5 ? level : 1,
    workers:
      level < 6
        ? 0
        : level === 6
          ? 1
          : level === 7
            ? Math.max(1, Math.floor(cores / 2))
            : Math.max(1, cores),
    duty: level < 6 ? 0 : level === 6 ? 0.3 : level === 7 ? 0.6 : 0.85,
    memoryMiB: level < 6 ? 0 : level === 6 ? 16 : level === 7 ? 64 : 128,
    jsStallMs: level < 9 ? 0 : level === 9 ? 500 : 2000,
    expirySeconds: 180,
  };
}
export interface NativeEvent {
  sequence: number;
  at: number;
  name: string;
  value?: unknown;
  source: "native";
}
export interface NativeSnapshot {
  runId: string;
  at: number;
  appState: string;
  pressureActive: boolean;
  guardReason: string | null;
  memoryKind?: "resident" | "pss";
  residentBytes: number;
  availableBytes: number;
  thermal: number;
  allocatedBytes: number;
  workerBusyMs: number;
  workers: number;
  duty: number;
  cpuTimeMs: number;
  events: NativeEvent[];
  route?: Record<string, unknown>;
}
export interface FaultCapabilities {
  available: boolean;
  pressure: boolean;
  cores: number;
  realServiceReset: boolean;
  platform: string;
  reason?: string;
}
export type Stage = "baseline" | "disruption" | "recovery" | "verification";
export type ProductionCommand =
  | "end-disruption"
  | "resume"
  | "new-session"
  | "stop-audio"
  | "finish"
  | "mute"
  | "gain";
export interface ScenarioEvidence {
  contract?: ReturnType<typeof scenarioContract>;
  id: ScenarioId;
  stage: Stage;
  round: number;
  requestedFaults: number;
  verifiedFaults: number;
  source: "real-os" | "simulated-app" | "native-pressure";
  timeline: { stage: Stage; at: string; detail: string }[];
  nativeSamples: NativeSnapshot[];
  recovery: {
    round: number;
    elapsedMs: number;
    assisted: boolean;
    observed: boolean;
    kind?:
      | "original-session"
      | "documented-client-handler"
      | "existing-session-resume"
      | "separate-new-session";
  }[];
  findings: string[];
  appState: string;
  expectedBackground: boolean;
  userActionRequired: boolean;
  desired: {
    playing: boolean;
    recording: boolean;
    muted: boolean;
    gain: number;
    generation: number;
  };
  observed: Record<string, unknown>;
  clientActions?: {
    at: string;
    round: number;
    action: string;
    before: Record<string, unknown>;
    intent: Record<string, unknown>;
  }[];
  faultEvents?: {
    at: string;
    name: string;
    value: unknown;
    source: string;
    round: number;
    stage: Stage;
  }[];
}
