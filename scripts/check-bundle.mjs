import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dir = process.argv[2];
assert(dir, "Pass an Expo export directory created with --source-maps.");
assert.equal(require("react-native-audio-api/package.json").version, "0.13.6");
function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? walk(join(path, item.name)) : [join(path, item.name)],
  );
}
const files = walk(dir);
for (const platform of ["android", "ios"]) {
  const maps = files.filter(
    (path) => path.includes(`/js/${platform}/`) && path.endsWith(".map"),
  );
  assert(maps.length, `No ${platform} source map.`);
  const sources = maps.flatMap(
    (path) => JSON.parse(readFileSync(path, "utf8")).sources,
  );
  assert(
    sources.some((path) => path.includes("audio/common.ts")),
    `Audio sandbox absent: ${platform}`,
  );
  assert(
    !sources.some((path) => path.includes("nightly")),
    `Inactive backend bundled: ${platform}`,
  );
}
console.log("Android and iOS bundles contain the stable-only sandbox.");
