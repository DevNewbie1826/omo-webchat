import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const digest = value => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

async function sourceSnapshot() {
  const files = [];
  const paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    .split("\0").filter(Boolean).sort();
  for (const path of paths) {
    files.push({ path, sha256: digest(await readFile(resolve(root, path))) });
  }
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  return {
    sha: git("rev-parse", "HEAD").trim(),
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    dirty: status !== "",
    status,
    worktreeDigest: digest(JSON.stringify(files)),
    files,
  };
}

/** Browser-side evidence covers both fixtures without changing their protocol. */
export async function createModelEvidence(page, directory) {
  const save = (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n");
  const snapshot = await sourceSnapshot();
  const { files, status, ...source } = snapshot;
  const assets = [];
  const dist = resolve(root, "frontend/dist");
  for (const path of (await readdir(dist, { recursive: true })).sort()) {
    const fullPath = resolve(dist, path);
    if ((await stat(fullPath)).isFile()) {
      assets.push({ path, sha256: digest(await readFile(fullPath)) });
    }
  }
  const buildDigest = digest(JSON.stringify(assets));
  await save("source.json", {
    ...snapshot,
    identityNote: "sha/tree identify HEAD; dirty plus worktreeDigest/files identify any uncommitted QA additions.",
    buildDigest,
    assets,
    command: process.argv,
    cwd: process.cwd(),
  });

  const screenshots = [], connections = [], wire = [];
  const onSocket = socket => {
    const connection = {
      socketId: connections.length + 1,
      url: socket.url(),
      documentUrl: page.url(),
      closed: false,
    };
    connections.push(connection);
    const record = (direction, event) => {
      const raw = typeof event.payload === "string" ? event.payload : event.payload.toString("utf8");
      const frame = JSON.parse(raw);
      wire.push({
        sequence: wire.length + 1,
        socketId: connection.socketId,
        url: connection.url,
        direction,
        requestId: frame.requestId ?? null,
        sessionId: frame.sessionId ?? frame.chatId ?? null,
        raw,
        frame,
      });
    };
    socket.on("framesent", event => record("outbound", event));
    socket.on("framereceived", event => record("inbound", event));
    socket.on("close", () => { connection.closed = true; });
  };
  page.on("websocket", onSocket);

  async function shot(name, metadata) {
    const viewport = page.viewportSize();
    const url = page.url();
    const pixels = await page.screenshot({ path: resolve(directory, name), type: "png" });
    const signatureValid = pixels.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const dimensions = signatureValid
      ? { width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) }
      : null;
    screenshots.push({
      file: name,
      ...metadata,
      viewport,
      url,
      source,
      buildDigest,
      capturedAt: new Date().toISOString(),
      sha256: digest(pixels),
      signatureValid,
      dimensions,
      wireSequence: wire.length,
    });
    assert(signatureValid, `${name}: capture must be PNG`);
    assert.deepEqual(dimensions, viewport, `${name}: capture must match requested viewport`);
  }

  async function finish() {
    page.off("websocket", onSocket);
    await save("screenshots.json", screenshots);
    await save("ws-traffic.json", {
      source,
      buildDigest,
      directionReference: "outbound is browser to fixture; inbound is fixture to browser",
      correlationKey: ["socketId", "requestId"],
      connections,
      wire,
    });
    const end = await sourceSnapshot();
    await save("source-after.json", end);
    assert.deepEqual(end, snapshot, "source identity must remain unchanged throughout capture");
  }

  return { shot, finish };
}
