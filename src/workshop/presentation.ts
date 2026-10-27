import type { Feature, TestResult } from "./types";
const basic: Record<string, string[]> = {
  context: ["sampleRate"],
  offline: ["duration"],
  graph: ["channels"],
  buffer: ["frames", "channels"],
  automation: ["method", "gain"],
  decode: ["fixture", "input"],
  pcm: ["channels"],
  metadata: ["fixture"],
  concat: ["fixture"],
  "buffer-source": ["fixture", "loop"],
  queue: ["fixture"],
  "audio-tag": ["fixture", "input", "loop"],
  "media-route": ["fixture", "gain"],
  streamer: ["url"],
  "record-file": ["format", "preset"],
  "record-combined": ["format", "preset"],
  "record-pcm": ["callbackRate"],
  "record-graph": ["monitor"],
  "playback-notification": ["title"],
  "recording-notification": ["title"],
  session: ["category"],
};
export function basicFields(feature: Feature) {
  return (
    basic[feature.id] ??
    feature.fields
      .filter((field) => !field.advanced)
      .slice(0, 2)
      .map((field) => field.key)
  );
}
export function hasAudioSetup(feature: Feature) {
  return feature.workload.companion !== undefined;
}
export function transportPaused(
  feature: Feature,
  state: Record<string, unknown> | null,
) {
  return feature.category === "Recording"
    ? state?.recordingPaused === true
    : (state?.context as { state?: string } | undefined)?.state === "suspended";
}
export function primaryActions(
  feature: Feature,
  active: boolean,
  paused: boolean,
  queueEmpty = false,
) {
  if (feature.id === "queue" && active && queueEmpty) return ["start", "stop"];
  if (["recording-notification", "playback-notification"].includes(feature.id))
    return [];
  if (feature.id === "record-recovery") return ["inspect", "consume"];
  const ids = feature.actions.map((action) => action.id);
  if (ids.includes("start"))
    return active
      ? [paused ? "resume" : "pause", "apply", "stop"].filter(
          (id) => ids.includes(id) && !(feature.id === "iir" && id === "apply"),
        )
      : ["start"];
  if (feature.id === "context")
    return active ? [paused ? "resume" : "pause", "close"] : ["create"];
  return feature.id === "permissions"
    ? ["inspect", "microphone", "notification"]
    : [ids[0]];
}
export function actionLabel(id: string, feature: Feature) {
  if (id === "start")
    return feature.category === "Recording" ? "Record" : "Play";
  if (id === "check") return "Run quick check";
  if (feature.id === "record-recovery")
    return id === "consume"
      ? "Recover last saved file"
      : "Check recording state";
  return (
    (
      {
        create: "Start audio engine",
        close: "Stop audio engine",
        apply: "Apply changes",
      } as Record<string, string>
    )[id] ??
    feature.actions.find((action) => action.id === id)?.label ??
    id
  );
}
export const resultLabels = {
  running: "Working…",
  passed: "Check passed",
  failed: "Something failed",
  manual: "Ready for your check",
  blocked: "Could not run",
  unavailable: "Not available",
};
export function resultSummary(result: TestResult) {
  if (
    result.status === "failed" ||
    result.status === "blocked" ||
    result.status === "unavailable"
  )
    return result.summary;
  const file = [...result.events]
    .reverse()
    .find((event) => event.name === "fileInfo")?.value as
    | { paths?: string[]; duration?: number }
    | undefined;
  if (file?.paths?.length)
    return `Recording saved${typeof file.duration === "number" ? ` · ${file.duration.toFixed(1)} seconds` : ""}. You can replay it below.`;
  if (result.action === "start-with-audio")
    return result.featureId.endsWith("-notification")
      ? "Audio is running and the notification is shown. Try its controls, then stop here or from the notification."
      : "Test audio is running. Try the phone actions, then stop here.";
  if (result.action === "start")
    return result.featureId.startsWith("record-")
      ? "Recording started. Stop to save it, then listen back."
      : "Playback started. Listen and try the controls.";
  if (result.action === "stop") return "Stopped.";
  return result.summary;
}
