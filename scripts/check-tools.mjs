import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
for (const name of readdirSync(new URL(".", import.meta.url))) {
  if (name.endsWith(".mjs"))
    execFileSync(process.execPath, [
      "--check",
      new URL(name, import.meta.url).pathname,
    ]);
}
console.log("Maintained host scripts passed syntax checks.");
