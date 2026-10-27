import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAudioPackage } from "../scripts/check-audio-integrity.mjs";

test("installed RNAA matches the locked published archive", () => {
  assert.equal(verifyAudioPackage().distribution, "npm-unmodified");
});
test("qualification rejects a dependency patch or a different locked archive", () => {
  const root = mkdtempSync(join(tmpdir(), "rnaa-integrity-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "node_modules/react-native-audio-api"), {
      recursive: true,
    });
    const content = "published source";
    const hash = createHash("sha256").update(content).digest("hex");
    const reference = {
      version: "test",
      integrity: "sha512-test",
      resolved: "https://registry.npmjs.org/test.tgz",
      files: { "source.js": hash },
      fingerprint: createHash("sha256")
        .update(`source.js\0${hash}\n`)
        .digest("hex"),
    };
    const lock = {
      packages: {
        "node_modules/react-native-audio-api": {
          version: reference.version,
          integrity: reference.integrity,
          resolved: reference.resolved,
        },
      },
    };
    writeFileSync(
      join(root, "scripts/rnaa-published-integrity.json"),
      JSON.stringify(reference),
    );
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    writeFileSync(
      join(root, "node_modules/react-native-audio-api/source.js"),
      content,
    );
    assert.equal(verifyAudioPackage(root).publishedFiles, 1);
    writeFileSync(
      join(root, "node_modules/react-native-audio-api/source.js"),
      "local repair",
    );
    assert.throws(() => verifyAudioPackage(root), /package was modified/);
    writeFileSync(
      join(root, "node_modules/react-native-audio-api/source.js"),
      content,
    );
    lock.packages["node_modules/react-native-audio-api"].integrity =
      "sha512-other";
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
    assert.throws(() => verifyAudioPackage(root), /does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
