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

/** Synchronous observer seam: no source/build I/O is needed to observe traffic. */
export function observeModelConnections(page) {
  // IDs are local to this one-page capture and persist across its navigations.
  const context = page.context();
  const contexts = [{ contextId: 1 }], pages = [{ pageId: 1, contextId: 1 }];
  const owner = pages[0];
  const connections = [], wire = [], lifecycle = [], subscriptions = [];
  const observe = (target, event, listener) => {
    target.on(event, listener);
    subscriptions.push(() => target.off(event, listener));
  };
  const terminalEvent = (kind, identity) => {
    lifecycle.push({ sequence: lifecycle.length + 1, kind, ...identity });
  };
  // One subscription per owner, not per socket. Navigation is not a close event.
  observe(context, "close", () => terminalEvent("context-close", contexts[0]));
  observe(page, "close", () => terminalEvent("page-close", owner));
  const onSocket = socket => {
    const connection = {
      socketId: connections.length + 1,
      ...owner,
      url: socket.url(),
      documentUrl: page.url(),
      closed: false,
    };
    connections.push(connection);
    const identity = { socketId: connection.socketId, ...owner };
    terminalEvent("socket-open", identity);
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
    observe(socket, "framesent", event => record("outbound", event));
    observe(socket, "framereceived", event => record("inbound", event));
    observe(socket, "close", () => {
      connection.closed = true; // Only this actual socket event may change the raw flag.
      terminalEvent("socket-close", identity);
    });
  };
  observe(page, "websocket", onSocket);

  return { contexts, pages, connections, wire, lifecycle,
    stop() { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); } };
}

/** Validate serialized receipts, not browser status or inferred socket closure. */
export function assertModelConnectionsTerminated({ contexts, pages, connections, lifecycle }) {
  assert(lifecycle.every((event, index) => event.sequence === index + 1), "lifecycle event order must be intact");
  assert.equal(new Set(connections.map(connection => connection.socketId)).size, connections.length,
    "socket identities must be unique");
  for (const connection of connections) {
    const { socketId, pageId, contextId, closed } = connection;
    assert(contexts.some(owner => owner.contextId === contextId)
      && pages.some(owner => owner.pageId === pageId && owner.contextId === contextId),
    `socket ${socketId}: recorded page/context ownership required`);
    const sameSocket = event => event.socketId === socketId && event.pageId === pageId && event.contextId === contextId;
    const opened = lifecycle.find(event => event.kind === "socket-open" && sameSocket(event));
    assert(opened, `socket ${socketId}: observed opening required`);
    const afterOpening = lifecycle.filter(event => event.sequence > opened.sequence);
    const socketClosed = afterOpening.some(event => event.kind === "socket-close" && sameSocket(event));
    assert.equal(closed, socketClosed, `socket ${socketId}: raw closed must mean an actual socket-close event`);
    const ownerClosed = afterOpening.some(event => event.contextId === contextId
      && (event.kind === "context-close" || (event.kind === "page-close" && event.pageId === pageId)));
    assert(socketClosed || ownerClosed, `socket ${socketId}: no observed terminal evidence`);
  }
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

  const screenshots = [];
  const observer = observeModelConnections(page);
  const { contexts, pages, connections, wire, lifecycle } = observer;

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
    observer.stop();
    await save("screenshots.json", screenshots);
    await save("ws-traffic.json", {
      source,
      buildDigest,
      directionReference: "outbound is browser to fixture; inbound is fixture to browser",
      correlationKey: ["socketId", "requestId"],
      terminalEvidenceNote: "closed records only socket-close; page/context-close proves owner destruction separately. Navigation and browser status are not terminal proof.",
      contexts,
      pages,
      lifecycle,
      connections,
      wire,
    });
    const end = await sourceSnapshot();
    await save("source-after.json", end);
    assert.deepEqual(end, snapshot, "source identity must remain unchanged throughout capture");
    // Save the raw receipt before rejecting incomplete or inconsistent evidence.
    assertModelConnectionsTerminated(observer);
  }

  return { shot, finish };
}
