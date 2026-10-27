import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { verifyAudioPackage } from "./check-audio-integrity.mjs";
verifyAudioPackage();
const require = createRequire(import.meta.url);
const config = JSON.parse(
  execFileSync(
    process.execPath,
    [
      require.resolve("expo/bin/cli"),
      "config",
      "--type",
      "introspect",
      "--json",
    ],
    { encoding: "utf8" },
  ),
);
const version = require("react-native-audio-api/package.json").version;
assert.equal(version, "0.13.6");
const plugin = config.plugins.find(
  (value) => Array.isArray(value) && value[0] === "react-native-audio-api",
)[1];
assert.equal(plugin.disableFFmpeg, false);
assert.equal(plugin.enableFFmpeg, undefined);
assert.equal(plugin.disableStaticExternalLibs, false);
assert.equal(config.ios.bundleIdentifier, "com.rnaaworkshop.stresstest");
assert.equal(config.android.package, config.ios.bundleIdentifier);
assert.equal(config.extra.audioApiVersion, version);
const mods = config._internal.modResults;
assert(mods.ios.infoPlist.UIBackgroundModes.includes("audio"));
assert(mods.ios.infoPlist.NSMicrophoneUsageDescription);
const manifest = mods.android.manifest.manifest;
assert.equal(mods.ios.infoPlist.RNAAProductionFaultsEnabled, true);
assert.equal(
  manifest.application[0]["meta-data"].find(
    (item) => item.$["android:name"] === "RNAAProductionFaultsEnabled",
  ).$["android:value"],
  "true",
);
for (const permission of [
  "RECORD_AUDIO",
  "POST_NOTIFICATIONS",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "FOREGROUND_SERVICE_MICROPHONE",
]) {
  assert(
    manifest["uses-permission"].some(
      (item) => item.$["android:name"] === `android.permission.${permission}`,
    ),
  );
}
const service = manifest.application[0].service.find((item) =>
  item.$["android:name"].includes("CentralizedForegroundService"),
).$;
assert.equal(
  service["android:stopWithTask"],
  process.env.RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL === "1" ? "false" : "true",
);
assert.equal(
  service["android:foregroundServiceType"],
  "mediaPlayback|microphone",
);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(lock.packages[""].dependencies["react-native-audio-api"], version);
assert.equal(
  lock.packages["node_modules/react-native-audio-api"].version,
  version,
);
console.log(
  `Plugin, permissions, identifiers and lockfile verified: ${version}`,
);
