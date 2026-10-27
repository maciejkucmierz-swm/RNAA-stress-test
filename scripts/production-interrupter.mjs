import { execFile } from "node:child_process";
import { promisify } from "node:util";
const args = process.argv.slice(2),
  get = (key, fallback) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const device = get("--device"),
  mode = get("--mode", "transient"),
  rounds = Number(get("--rounds", "5"));
if (
  !device ||
  !["transient", "permanent", "duck"].includes(mode) ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 20
)
  throw new Error(
    "Use --device SERIAL --mode transient|permanent|duck --rounds 1..20",
  );
console.log(
  (
    await promisify(execFile)("adb", [
      "-s",
      device,
      "shell",
      "am",
      "start",
      "-S",
      "-n",
      "com.rnaa.interrupter/.MainActivity",
      "--es",
      "mode",
      mode,
      "--ei",
      "seconds",
      "3",
      "--ei",
      "rounds",
      String(rounds),
    ])
  ).stdout,
);
