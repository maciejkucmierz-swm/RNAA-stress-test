import type { Settings, TestResult } from "./types";

export interface HistoryStorage {
  read(): Promise<string | null>;
  write(value: string): void | Promise<void>;
}
export function redact(settings: Settings): Settings {
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !/headers|password|token|authorization/i.test(key),
    ),
  );
}
export function exportResults(results: TestResult[]) {
  return JSON.stringify(
    {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      results: results.map((result) => ({
        ...result,
        settings: redact(result.settings),
        events: result.events.map((event) => ({
          ...event,
          value: sanitize(event.value),
        })),
      })),
    },
    null,
    2,
  );
}
function sanitize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value))
    return String(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return "[binary omitted]";
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/headers|password|token|authorization/i.test(key))
        .map(([key, item]) => [key, sanitize(item)]),
    );
  return value;
}
export class History {
  results: TestResult[] = [];
  private writes = Promise.resolve();
  constructor(private storage: HistoryStorage) {}
  async load() {
    const value = await this.storage.read();
    if (!value) return;
    const parsed = JSON.parse(value);
    if (parsed.formatVersion !== 1 || !Array.isArray(parsed.results))
      throw new Error("Unsupported history format.");
    this.results = parsed.results.slice(0, 100);
  }
  put(result: TestResult) {
    // Updating an older session's events must not put it above a newer Stop or
    // transport result and make the UI show an obsolete "recording active" row.
    const existing = this.results.some((item) => item.id === result.id);
    this.results = existing
      ? this.results.map((item) => (item.id === result.id ? result : item))
      : [result, ...this.results].slice(0, 100);
    return this.save();
  }
  clear() {
    this.results = [];
    return this.save();
  }
  private save() {
    const payload = exportResults(this.results);
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.storage.write(payload));
    return this.writes;
  }
}
