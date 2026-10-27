import assert from "node:assert/strict";
import test from "node:test";
import type {
  historyEnvelope as HistoryEnvelope,
  jsonFile as JsonFile,
} from "../src/storage/json-file";
import { loadModule } from "./helpers/load-module";

function storageHarness() {
  const files = new Map<string, string>();
  let interruptMove = false;
  class MemoryFile {
    constructor(public uri: string) {}
    get name() {
      return this.uri;
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      files.set(this.uri, "");
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    textSync() {
      return files.get(this.uri)!;
    }
    async text() {
      return this.textSync();
    }
    delete() {
      files.delete(this.uri);
    }
    copy(to: MemoryFile) {
      files.set(to.uri, this.textSync());
    }
    move(to: MemoryFile) {
      if (interruptMove) throw new Error("Interrupted replacement");
      this.copy(to);
      this.delete();
      this.uri = to.uri;
    }
  }
  const module = loadModule("src/storage/json-file.ts", {
    "expo-file-system": { File: MemoryFile },
  }) as { jsonFile: typeof JsonFile; historyEnvelope: typeof HistoryEnvelope };
  const file = new MemoryFile("history");
  const store = module.jsonFile(file as never, (value) =>
    module.historyEnvelope(value, "results"),
  );
  const payload = (name: string) =>
    JSON.stringify({ formatVersion: 1, results: [{ id: name }] });
  return {
    files,
    store,
    payload,
    interrupt: () => {
      interruptMove = true;
    },
  };
}
test("history retains a last-good copy if replacement is interrupted", async () => {
  const h = storageHarness();
  h.store.write(h.payload("original"));
  h.interrupt();
  assert.throws(() => h.store.write(h.payload("new")), /Interrupted/);
  assert.equal(await h.store.read(), h.payload("original"));
});
test("damaged history is preserved before restoring the backup", async () => {
  const h = storageHarness();
  h.store.write(h.payload("original"));
  h.store.write(h.payload("later"));
  h.files.set("history", "{broken");
  assert.equal(await h.store.read(), h.payload("original"));
  assert.equal(h.files.get("history.corrupt"), "{broken");
  h.store.write(h.payload("fresh"));
  assert.equal(h.files.get("history.corrupt"), "{broken");
  assert.equal(await h.store.read(), h.payload("fresh"));
});
test("unsupported history stays readable as original evidence and is not accepted", async () => {
  const h = storageHarness();
  h.files.set("history", JSON.stringify({ formatVersion: 999, results: [] }));
  await assert.rejects(h.store.read(), /Unsupported/);
  assert.equal(h.files.get("history.corrupt"), h.files.get("history"));
});
