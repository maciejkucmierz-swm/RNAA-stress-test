import { pressureProfile } from "./catalog";

export const environments = [
  {
    id: "level",
    name: "Use the test level",
    explanation:
      "Levels 1–5 add no load. Levels 6–10 add native CPU/RAM pressure; 9–10 also pause app JavaScript.",
  },
  {
    id: "cpu",
    name: "Busy native threads",
    explanation:
      "Occupy several native worker threads with CPU work. This competes for CPU; it does not lock RNAA’s own threads.",
  },
  {
    id: "memory",
    name: "Less free RAM",
    explanation:
      "Hold up to 128 MiB of real memory, capped at 10% of available memory. This adds pressure; it does not turn the phone into a low-RAM model.",
  },
  {
    id: "js",
    name: "App JavaScript freezes",
    explanation:
      "Pause the app’s JavaScript for 0.5–2 seconds every 10 seconds. Native audio and the native expiry timer remain independent.",
  },
  {
    id: "latency",
    name: "Slow app commands",
    explanation:
      "Add seeded 250–1500 ms delays before audio starts and recovery commands. Stop all bypasses these delays. This is app latency, not network or Bluetooth latency.",
  },
  {
    id: "combined",
    name: "CPU + RAM + freezes + delays",
    explanation:
      "Combine native CPU/RAM pressure, repeated JavaScript pauses, and delayed app commands. A difficult environment, not an exact low-end phone simulation.",
  },
] as const;
export type EnvironmentId = (typeof environments)[number]["id"];
export function environmentProfile(
  level: number,
  cores: number,
  id: string = "level",
) {
  if (!environments.some((item) => item.id === id))
    throw new Error("Choose a supported test environment.");
  const base = pressureProfile(level, cores);
  const loaded = pressureProfile(Math.max(6, level), cores);
  const profile = { ...base, commandLatencyMs: 0, jsStallEveryMs: 10000 };
  if (id === "cpu")
    return {
      ...profile,
      workers: Math.min(Math.max(1, cores), Math.max(2, loaded.workers)),
      duty: loaded.duty,
      memoryMiB: 0,
      jsStallMs: 0,
    };
  if (id === "memory")
    return { ...profile, workers: 1, duty: 0.05, memoryMiB: 128, jsStallMs: 0 };
  if (id === "js" || id === "latency")
    return {
      ...profile,
      workers: 0,
      duty: 0,
      memoryMiB: 0,
      jsStallMs: id === "js" ? (level >= 9 ? 2000 : 500) : 0,
      commandLatencyMs: id === "latency" ? (level >= 6 ? 1500 : 750) : 0,
    };
  if (id === "combined")
    return {
      ...loaded,
      rounds: base.rounds,
      jsStallMs: level >= 9 ? 2000 : 500,
      commandLatencyMs: 1500,
      jsStallEveryMs: 10000,
    };
  return profile;
}
