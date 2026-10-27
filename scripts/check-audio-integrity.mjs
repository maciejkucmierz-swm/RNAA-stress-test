import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reference files came from the npm archive whose SHA-512 matches package-lock.
// Generated build outputs are not published files and are not part of this hash.
export function verifyAudioPackage(
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const reference = JSON.parse(
    readFileSync(
      resolve(root, "scripts/rnaa-published-integrity.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  ).packages["node_modules/react-native-audio-api"];
  if (
    lock.version !== reference.version ||
    lock.integrity !== reference.integrity ||
    lock.resolved !== reference.resolved
  ) {
    throw new Error(
      "RNAA integrity reference does not match the locked published release. Verify the official archive before changing the reference.",
    );
  }
  const entries = [];
  for (const path of Object.keys(reference.files).sort()) {
    const actual = createHash("sha256")
      .update(
        readFileSync(
          resolve(root, "node_modules/react-native-audio-api", path),
        ),
      )
      .digest("hex");
    if (actual !== reference.files[path])
      throw new Error(
        `RNAA package was modified: ${path}. Restore the published dependency; do not patch it.`,
      );
    entries.push(`${path}\0${actual}\n`);
  }
  const fingerprint = createHash("sha256")
    .update(entries.join(""))
    .digest("hex");
  if (fingerprint !== reference.fingerprint)
    throw new Error("RNAA reference fingerprint is inconsistent.");
  return {
    distribution: "npm-unmodified",
    integrity: reference.integrity,
    fingerprint,
    publishedFiles: entries.length,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(verifyAudioPackage(), null, 2));
