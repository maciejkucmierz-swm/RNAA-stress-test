import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function createFaultServer() {
  const audio = await readFile(
    fileURLToPath(new URL("../assets/audio/stereo.wav", import.meta.url)),
  );
  const counts = new Map();
  const journal = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.setHeader("Content-Type", "application/json");
      return response.end(
        JSON.stringify({
          service: "rnaa-stress-faults-v1",
          fixture: "stereo.wav",
          bytes: audio.length,
        }),
      );
    }
    if (url.pathname === "/stats") {
      response.setHeader("Content-Type", "application/json");
      return response.end(
        JSON.stringify(
          journal.filter((entry) => entry.run === url.searchParams.get("run")),
        ),
      );
    }
    if (
      url.pathname !== "/audio.wav" ||
      !["GET", "HEAD"].includes(request.method)
    ) {
      response.writeHead(404);
      return response.end();
    }
    const fault = url.searchParams.get("fault") ?? "normal",
      run = url.searchParams.get("run") ?? "manual";
    if (!["normal", "slow", "stall", "truncate", "retry"].includes(fault)) {
      response.writeHead(400);
      return response.end("Unknown fault");
    }
    const key = `${run}:${fault}`,
      count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (counts.size > 100) counts.delete(counts.keys().next().value);
    const entry = {
      at: new Date().toISOString(),
      run,
      fault,
      request: count,
      range: request.headers.range ?? null,
      injected: fault !== "normal",
    };
    journal.push(entry);
    if (journal.length > 500) journal.shift();
    if (fault === "retry" && count === 1) {
      response.writeHead(503, { "Retry-After": "1" });
      return response.end("Injected retryable failure");
    }
    let start = 0,
      end = audio.length - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!match) {
        response.writeHead(416);
        return response.end();
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start >= audio.length || end < start) {
        response.writeHead(416, { "Content-Range": `bytes */${audio.length}` });
        return response.end();
      }
    }
    const chunk = audio.subarray(start, end + 1);
    response.writeHead(request.headers.range ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Content-Length": chunk.length,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(request.headers.range
        ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` }
        : {}),
    });
    if (request.method === "HEAD") return response.end();
    if (fault === "truncate") {
      response.write(
        chunk.subarray(0, Math.max(1, Math.floor(chunk.length / 3))),
      );
      const timer = setTimeout(() => response.destroy(), 100);
      response.on("close", () => clearTimeout(timer));
      return;
    }
    let offset = 0,
      timer;
    const send = () => {
      if (response.destroyed) return;
      const size = fault === "slow" ? 4096 : 16384;
      const next = Math.min(chunk.length, offset + size);
      const writable = response.write(chunk.subarray(offset, next));
      offset = next;
      if (offset === chunk.length) return response.end();
      const schedule = () => {
        timer = setTimeout(
          send,
          fault === "stall" && offset === size
            ? 1500
            : fault === "slow"
              ? 25
              : 0,
        );
      };
      if (writable) schedule();
      else response.once("drain", schedule);
    };
    response.on("close", () => clearTimeout(timer));
    send();
  });
  return server;
}
async function main() {
  const port = Number(process.env.RNAA_STRESS_PORT ?? 8099);
  const server = await createFaultServer();
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `RNAA fault server: http://127.0.0.1:${port}; Android: adb -s SERIAL reverse tcp:${port} tcp:${port}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
