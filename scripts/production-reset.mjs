import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  args = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
const device = args.includes("--device") ? get("--device") : null;
const runId = args.includes("--run") ? get("--run") : null;
const bundle = "com.rnaaworkshop.stresstest";
if (
  !device ||
  (!args.includes("--preflight") &&
    (!runId ||
      !/^[\w-]{1,100}$/.test(runId) ||
      !args.includes("--allow-system-reset")))
)
  throw new Error(
    "Usage: --device SERIAL --preflight; or --device SERIAL --run RUN_ID --allow-system-reset (dedicated root-capable target only).",
  );
const adb = async (...argv) =>
  (
    await exec("adb", ["-s", device, ...argv], { timeout: 10000 })
  ).stdout.trim();
const write = (name, value) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "adb",
      ["-s", device, "shell", "run-as", bundle, "tee", `files/${name}`],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (data) => {
      error += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(error || `adb exit ${code}`)),
    );
    child.stdin.end(JSON.stringify(value));
  });
try {
  // Preflight evidence access before touching a system process. Root alone does
  // not make this run-as based test protocol available in ordinary release.
  try {
    await adb("shell", "run-as", bundle, "id");
  } catch {
    throw new Error(
      "App-private evidence access unavailable. This host reset protocol requires a debuggable app; ordinary release reports Blocked.",
    );
  }
  let root = [];
  if (!(await adb("shell", "id")).includes("uid=0")) {
    if (!(await adb("shell", "su", "0", "id")).includes("uid=0"))
      throw new Error("No root-capable audio-service reset available.");
    root = ["su", "0"];
  }
  const beforePid = await adb("shell", "pidof", "audioserver");
  if (!/^\d+$/.test(beforePid))
    throw new Error("Expected one audioserver PID. No service was signalled.");
  if (args.includes("--preflight")) {
    await write("production-host-capabilities.json", {
      realServiceReset: true,
      expiresAt: Date.now() + 600000,
      source: "host-root-preflight",
      beforePid,
    });
    console.log(
      "Root preflight passed for 10 minutes. Reopen the inline scenario panel. No service was stopped.",
    );
  } else {
    await adb("shell", ...root, "kill", "-TERM", beforePid);
    let afterPid = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        afterPid = await adb("shell", "pidof", "audioserver");
      } catch {
        continue;
      }
      if (/^\d+$/.test(afterPid) && beforePid !== afterPid) break;
    }
    const verified = /^\d+$/.test(afterPid) && afterPid !== beforePid;
    const evidence = {
      runId,
      verified,
      beforePid,
      afterPid,
      at: Date.now(),
      source: "host-audioserver-pid",
    };
    await write(`production-host-${runId}.json`, evidence);
    console.log(JSON.stringify(evidence));
    if (!verified) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Blocked: ${error.message}`);
  process.exitCode = 2;
}
