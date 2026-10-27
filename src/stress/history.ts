import type { StressReport } from "./runner";

// Completed reports stay unchanged between checkpoints. A review replaces the
// report object, so only that report needs encoding again after a manual edit.
export function reportEncoder() {
  const completed = new WeakMap<StressReport, string>();
  return (reports: StressReport[]) => {
    const entries = reports.map((report) => {
      if (report.verdict === "running") return JSON.stringify(report);
      let text = completed.get(report);
      if (text === undefined) {
        text = JSON.stringify(report);
        completed.set(report, text);
      }
      return text;
    });
    return `{"formatVersion":1,"reports":[${entries.join(",")}]}`;
  };
}
