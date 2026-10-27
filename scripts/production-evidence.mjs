// A background-suspended JS runtime is not automatically a foreground hang.
/**
 * @param {boolean | null} processAlive
 * @param {boolean | null | undefined} foregroundWindowOwned
 * @param {number | undefined} foregroundObservedSince
 */
export function watchdogDecision(
  report,
  native,
  observedAt = Date.now(),
  processAlive = true,
  foregroundWindowOwned = undefined,
  foregroundObservedSince = undefined,
) {
  if (report.verdict !== "running") return report.verdict;
  if (processAlive === null) return "inconclusive-target-unreachable";
  if (!processAlive) return "failed-process-death";
  if (native?.guardReason) return "inconclusive-native-guard";
  if (observedAt - Date.parse(report.heartbeatAt) <= 15000) return "running";
  if (foregroundWindowOwned === false) return "expected-background-suspension";
  if (foregroundWindowOwned === null) return "inconclusive-foreground-unknown";
  // Background time is not foreground hang time. Require a continuous measured
  // foreground window before applying the stale-heartbeat threshold after return.
  if (
    foregroundWindowOwned === true &&
    Number.isFinite(foregroundObservedSince) &&
    observedAt - foregroundObservedSince < 15000
  )
    return "foreground-observation-pending";
  const fresh = native?.runId === report.id && observedAt - native.at < 10000;
  if (fresh && ["background", "inactive"].includes(native.appState))
    return "expected-background-suspension";
  if (report.scenario && !fresh) return "inconclusive-missing-native-heartbeat";
  return "failed-watchdog";
}
export function androidOwnsFocusedWindow(windows, bundle) {
  const focus = windows
    .split("\n")
    .find(
      (line) =>
        line.includes("mCurrentFocus=") && !/mCurrentFocus=null/.test(line),
    );
  if (!focus) return null;
  return focus.includes(`${bundle}/`);
}
export function simulatorAppAlive(list, bundle) {
  return list.split("\n").some((line) => {
    const [pid, , label = ""] = line.trim().split(/\s+/);
    return (
      /^\d+$/.test(pid) &&
      (label.startsWith(`application.${bundle}.`) ||
        label.startsWith(`UIKitApplication:${bundle}[`))
    );
  });
}
