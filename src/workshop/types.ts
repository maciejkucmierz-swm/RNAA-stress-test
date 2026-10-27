export const categories = [
  "Core",
  "Playback",
  "DSP",
  "Recording",
  "Worklets",
  "System",
] as const;
export type Category = (typeof categories)[number];
export type Settings = Record<string, string | number | boolean>;
export type Verdict =
  | "running"
  | "passed"
  | "failed"
  | "manual"
  | "blocked"
  | "unavailable";
export interface Field {
  key: string;
  label: string;
  value: string | number | boolean;
  options?: string[];
  advanced?: boolean;
}
export interface Action {
  id: string;
  label: string;
  session?: boolean;
  check?: boolean;
}
export type RepetitionKind =
  | "check"
  | "context"
  | "connections"
  | "edit"
  | "restart"
  | "queue"
  | "record"
  | "session"
  | "live-system"
  | "notification";
export interface Workload {
  kind: RepetitionKind;
  mode: "data" | "audio" | "system";
  capture: "none" | "file" | "samples" | "graph" | "combined";
  companion?: "playback" | "recording" | "select";
  defaultCompanion: "playback" | "recording";
  suite?:
    | "graph-churn"
    | "lifecycle-storm"
    | "notification-race"
    | "queue-pressure"
    | "recorder-endurance"
    | "worklet-budget"
    | "decode-flood"
    | "streaming-recovery";
}
export interface Feature {
  id: string;
  category: Category;
  title: string;
  api: string;
  description: string;
  fields: Field[];
  actions: Action[];
  workload: Workload;
  platforms?: string[];
  knownIssue?: string;
}
export interface Observation {
  at: string;
  name: string;
  value?: unknown;
}
export interface Assertion {
  name: string;
  passed: boolean;
  detail?: string;
}
export interface Outcome {
  status: Exclude<Verdict, "running">;
  summary: string;
  assertions?: Assertion[];
}
export interface TestResult extends Omit<Outcome, "status"> {
  status: Verdict;
  id: string;
  featureId: string;
  action: string;
  startedAt: string;
  finishedAt?: string;
  settings: Settings;
  environment: Record<string, unknown>;
  events: Observation[];
  droppedEvents: number;
  manualVerdict?: "passed" | "failed";
  notes?: string;
}
export class BlockedError extends Error {}
export class CancelledError extends Error {}
export const passed = (
  summary: string,
  assertions: Assertion[] = [],
): Outcome => ({
  status: assertions.every((a) => a.passed) ? "passed" : "failed",
  summary,
  assertions,
});
export const manual = (summary: string): Outcome => ({
  status: "manual",
  summary,
});
export function availability(
  feature: Feature,
  platform: string,
): string | undefined {
  if (feature.platforms && !feature.platforms.includes(platform))
    return `Available on ${feature.platforms.join(" / ")} only.`;
}

export function formatError(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.name}: ${error.message} [${error.errors.map(formatError).join("; ")}]`;
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
