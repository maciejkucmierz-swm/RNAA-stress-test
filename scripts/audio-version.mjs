import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAudioPackage } from "./check-audio-integrity.mjs";

// Preparation records the installed baseline. It never installs, switches or
// changes a dependency, and never rewrites the integrity reference.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(root, "package.json"));
const audioApi = require("react-native-audio-api/package.json").version;
if (audioApi !== "0.13.6")
  throw new Error(
    "This sandbox requires published RNAA 0.13.6. Restore the lockfile and run npm ci.",
  );
const provenance = verifyAudioPackage(root);
mkdirSync(resolve(root, "src/audio"), { recursive: true });
writeFileSync(
  resolve(root, "src/audio/build-info.json"),
  JSON.stringify(
    {
      channel: "stable",
      audioApi,
      worklets: require("react-native-worklets/package.json").version,
      ...provenance,
    },
    null,
    2,
  ) + "\n",
);
console.log(`RNAA sandbox: stable / ${audioApi}, published package verified`);
