import {
  watchdogDecision,
  simulatorAppAlive,
  androidOwnsFocusedWindow,
} from "./production-evidence.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const platform = option("--platform"),
  device = option("--device");
if (!["ios", "android"].includes(platform) || !device)
  throw new Error(
    "Usage: node scripts/stress-host.mjs --platform ios|android --device ID [--run ID] [--recover] [--output DIR]",
  );
const bundle = "com.rnaaworkshop.stresstest";
const output = option(
  "--output",
  join(tmpdir(), `rnaa-stress-host-${Date.now()}`),
);
await mkdir(output, { recursive: true });
const evidence = {
  platform,
  device,
  startedAt: new Date().toISOString(),
  samples: [],
  status: "waiting",
  recovery: false,
};
const command = async (file, argv) =>
  (await exec(file, argv, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
if (platform === "android") {
  try {
    await command("adb", ["-s", device, "shell", "run-as", bundle, "id"]);
  } catch {
    evidence.status = "blocked";
    evidence.error =
      "Private report access is unavailable. Ordinary release builds require manual in-app export; run-as monitoring is for debuggable builds only.";
    await writeFile(
      join(output, "host-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.error(`Blocked: ${evidence.error}`);
    process.exit(2);
  }
}
let container;
const physical = args.includes("--physical");
if (platform === "ios" && !physical)
  container = (
    await command("xcrun", [
      "simctl",
      "get_app_container",
      device,
      bundle,
      "data",
    ])
  ).trim();
const readAppFile = async (name) => {
  if (platform === "android")
    return command("adb", [
      "-s",
      device,
      "exec-out",
      "run-as",
      bundle,
      "cat",
      `files/${name}`,
    ]);
  if (!physical) return readFile(join(container, `Documents/${name}`), "utf8");
  const destination = join(output, `device-${name}`);
  await command("xcrun", [
    "devicectl",
    "device",
    "copy",
    "from",
    "--device",
    device,
    "--domain-type",
    "appDataContainer",
    "--domain-identifier",
    bundle,
    "--source",
    `Documents/${name}`,
    "--destination",
    destination,
    "--timeout",
    "5",
    "--json-output",
    join(output, "copy-status.json"),
  ]);
  return readFile(destination, "utf8");
};
const read = async () =>
  JSON.parse(await readAppFile("audio-stress-history-v1.json"));
let runId = option("--run"),
  last = "",
  lastMemory = 0,
  misses = 0;
let foregroundObservedSince;
const started = Date.now();
console.log(`Watching only this app's stress report. Evidence: ${output}`);
while (Date.now() - started < 7_500_000) {
  let report;
  let native = null;
  let observedAt = Date.now();
  try {
    const history = await read();
    report = runId
      ? history.reports.find((item) => item.id === runId)
      : history.reports.find((item) => item.verdict === "running");
    observedAt = Date.now();
    misses = 0;
  } catch (error) {
    if (++misses >= 3 && runId) {
      evidence.status = "report-unreadable";
      evidence.error = error.message;
      break;
    }
    if (!runId && Date.now() - started > 180000) {
      evidence.status = "no-run-started";
      evidence.error = error.message;
      break;
    }
  }
  if (!report && !runId && Date.now() - started > 180000) {
    evidence.status = "no-run-started";
    break;
  }
  if (report) {
    runId = report.id;
    evidence.runId = runId;
    const label = `${report.name}: ${report.phase}`;
    if (label !== last) {
      console.log(label);
      last = label;
    }
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    if (Date.now() - lastMemory > 5000 && platform === "android") {
      lastMemory = Date.now();
      try {
        const memory = await command("adb", [
          "-s",
          device,
          "shell",
          "dumpsys",
          "meminfo",
          bundle,
        ]);
        const total =
          memory.match(/TOTAL PSS:\s*(\d+)/) ?? memory.match(/TOTAL\s+(\d+)/);
        evidence.samples.push({
          at: new Date().toISOString(),
          pssKiB: total ? Number(total[1]) : null,
          phase: report.phase,
        });
      } catch {
        evidence.samples.push({ at: new Date().toISOString(), pssKiB: null });
      }
    }
    if (report.scenario) {
      try {
        native = JSON.parse(
          await readAppFile(`production-native-${report.id}.json`),
        );
        await writeFile(
          join(output, "native-evidence.json"),
          JSON.stringify(native, null, 2),
        );
      } catch {
        /* Missing evidence is not a confirmed foreground hang. */
      }
    }
    let processAlive = true;
    let foregroundWindowOwned;
    if (
      report.scenario &&
      observedAt - Date.parse(report.heartbeatAt) > 15000 &&
      platform === "android"
    ) {
      try {
        processAlive = !!(
          await command("adb", ["-s", device, "shell", "pidof", bundle])
        ).trim();
      } catch {
        try {
          processAlive =
            (await command("adb", ["-s", device, "get-state"])).trim() ===
            "device"
              ? false
              : null;
        } catch {
          processAlive = null;
        }
      }
      try {
        foregroundWindowOwned = androidOwnsFocusedWindow(
          await command("adb", ["-s", device, "shell", "dumpsys", "window"]),
          bundle,
        );
      } catch {
        foregroundWindowOwned = null;
      }
      // Keep only ownership of our window, never other apps' titles or window dumps.
      if (foregroundWindowOwned === true)
        foregroundObservedSince ??= Date.now();
      else foregroundObservedSince = undefined;
      evidence.samples.push({
        at: new Date().toISOString(),
        foregroundWindowOwned,
        foregroundObservedSince,
      });
    } else if (
      report.scenario &&
      observedAt - Date.parse(report.heartbeatAt) > 15000 &&
      platform === "ios" &&
      !physical
    ) {
      try {
        processAlive = simulatorAppAlive(
          await command("xcrun", [
            "simctl",
            "spawn",
            device,
            "launchctl",
            "list",
          ]),
          bundle,
        );
      } catch {
        processAlive = null;
      }
    }
    if (observedAt - Date.parse(report.heartbeatAt) <= 15000)
      foregroundObservedSince = undefined;
    const decision = watchdogDecision(
      report,
      native,
      observedAt,
      processAlive,
      foregroundWindowOwned,
      foregroundObservedSince,
    );
    if (decision === "failed-process-death") {
      evidence.status = decision;
      break;
    }
    if (decision.startsWith("inconclusive-")) {
      evidence.status = decision;
      break;
    }
    if (report.verdict !== "running") {
      evidence.status = report.verdict;
      break;
    }
    // Reports checkpoint every five seconds; allow two checkpoints plus command latency.
    // The app shows a live heartbeat, but the persisted host view has a 15s stale threshold.
    if (decision === "failed-watchdog") {
      evidence.status = "failed-watchdog";
      evidence.staleHeartbeat = report.heartbeatAt;
      if (platform === "android") {
        try {
          const pid = (
            await command("adb", ["-s", device, "shell", "pidof", bundle])
          ).trim();
          if (pid)
            await writeFile(
              join(output, "native-log.txt"),
              await command("adb", [
                "-s",
                device,
                "logcat",
                "-d",
                "--pid",
                pid.split(" ")[0],
                "-t",
                "150",
              ]),
            );
        } catch {
          /* Report and memory samples remain available if log collection fails. */
        }
      }
      if (args.includes("--recover")) {
        if (platform === "android")
          await command("adb", [
            "-s",
            device,
            "shell",
            "am",
            "force-stop",
            bundle,
          ]);
        else await command("xcrun", ["simctl", "terminate", device, bundle]);
        evidence.recovery = true;
      }
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (evidence.status === "waiting")
  evidence.status = "inconclusive-host-timeout";
evidence.finishedAt = new Date().toISOString();
await writeFile(
  join(output, "host-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(
  `Host verdict: ${evidence.status}. App restart or recovery never counts as a pass.`,
);
if (
  evidence.status.startsWith("failed") ||
  evidence.status === "report-unreadable"
)
  process.exitCode = 1;
