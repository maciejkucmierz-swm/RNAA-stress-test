import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import test from "node:test";

test("audio fixtures have unique Android resource names and retain their public keys and content", () => {
  const source = readFileSync(
    new URL("../src/audio/fixtures.ts", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(
    readFileSync(
      new URL("../assets/audio/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const assets = [
    ...source.matchAll(
      /["']([^"']+)["']:\s*require\(\s*["']([^"']+)["']\s*\)/g,
    ),
  ];
  assert.deepEqual(
    assets.map((match) => match[1]).sort(),
    Object.keys(manifest).sort(),
  );
  const resourceNames = assets.map(([, , path]) =>
    basename(path, extname(path))
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, ""),
  );
  assert.equal(
    new Set(resourceNames).size,
    assets.length,
    "Android drops extensions when naming raw resources",
  );
  for (const [, name, path] of assets) {
    const bytes = readFileSync(
      new URL(`../src/audio/${path}`, import.meta.url),
    );
    assert.equal(bytes.length, manifest[name].bytes, name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      manifest[name].sha256,
      name,
    );
  }
});
