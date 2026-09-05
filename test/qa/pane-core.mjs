/** Actual production App, isolated in-memory HTTP/WS fixture. No user backend.
 * QA_PLAYWRIGHT=/absolute/path/to/playwright-core/index.mjs bun test/qa/pane-core.mjs EVIDENCE
 * Uses an already installed browser driver; adds no project dependency.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const leaf = (id, sessionId = null) => ({ kind: "leaf", id, sessionId });
const split = (id, dir, first, second, ratio = .5) => ({ kind: "split", id, dir, first, second, ratio });
const stored = { id: "stored-a", name: "Stored A", provider: "omo" };
const newer = { id: "newer", name: "Newer", provider: "omo" };
const catalog = [{ id: "discovered-b", name: "Discovered B", source: "discovered", recencyMs: 40 },
  { ...stored, source: "stored", recencyMs: 30 }, { id: "union", name: "Union row", source: "stored", recencyMs: 20 },
  { ...newer, source: "stored", recencyMs: 10 }];
let layout, releaseOpen, openStarted;
const requests = [], frames = [], results = [], errors = [];
const sockets = new Set();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(req, server) {
    const url = new URL(req.url), path = url.pathname;
    requests.push({ method: req.method, path: path + url.search });
    if (path === "/api/v2/ws" && server.upgrade(req)) return;
    if (path === "/api/auth/check") return new Response(null, { status: 204 });
    if (path === "/api/providers") return Response.json([{ id: "omo", label: "omo", available: true }]);
    if (path === "/api/workspaces") return Response.json([{ id: "ws", name: "Workspace", path: "/fixture", chats: [stored, newer] }]);
    if (path === "/api/layout") { if (req.method === "PUT") layout = await req.json(); return Response.json({ layout }); }
    if (path === "/api/workspaces/ws/sessions") return Response.json(url.searchParams.has("cursor")
      ? { items: [{ id: "discovered-c", name: "Discovered C", source: "discovered", recencyMs: 5 }], nextCursor: "" }
      : { items: catalog, nextCursor: "page2" });
    if (path.endsWith("/sessions/open")) {
      const body = await req.json(); openStarted?.(body);
      return Response.json(await new Promise(done => { releaseOpen = () => done({ id: `opened-${body.id}`, name: `Opened ${body.id}`, provider: "omo" }); }));
    }
    if (path.startsWith("/api/sessions/")) return Response.json({ sessions: [] });
    if (path.endsWith("/goal")) return Response.json({ goal: null });
    if (path.endsWith("/activity")) return Response.json({ history: {} });
    if (path.startsWith("/api/")) return new Response(`Unexpected ${path}`, { status: 404 });
    const file = Bun.file(resolve("frontend/dist", path === "/" ? "index.html" : path.slice(1)));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "hello", version: 2, serverVersion: "qa" })); },
    close(ws) { sockets.delete(ws); },
    message(ws, raw) {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      const send = value => ws.send(JSON.stringify({ sessionId: frame.chatId, ...value }));
      if (frame.type === "chat.create") {
        send({ type: "ready", resumed: true, piSessionId: frame.chatId });
        send({ type: "state", isStreaming: false, isCompacting: false, thinkingLevel: "off" });
        send({ type: "models", models: [] }); send({ type: "commands", commands: [] });
        send({ type: "entries", entries: [], final: true });
      }
      if (frame.type === "chat.stats") send({ type: "stats", cost: 0 });
    },
  },
});
let browser;
const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + "\n");
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => {
    localStorage.setItem("th-lang", "en"); localStorage.setItem("th-ws-expanded", '["ws"]');
    window.qaSignal = predicate => new Promise((done, fail) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); fail(new Error("DOM signal deadline")); }, 8000);
      function check() { if (predicate()) { observer.disconnect(); clearTimeout(timer); done(true); } }
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
    });
    window.qaReady = window.qaSignal(() => document.querySelectorAll('.th-picker-pane-item').length > 0);
  });
  const arm = predicate => page.evaluate(source => { window.qaPending = window.qaSignal(new Function(`return (${source})`)()); }, predicate);
  const complete = () => page.evaluate(() => window.qaPending);
  async function reset(tree = split("root", "h", leaf("left", stored.id), leaf("right")), narrow = false) {
    layout = tree; await page.setViewportSize({ width: narrow ? 390 : 1440, height: narrow ? 844 : 900 });
    await page.goto(`http://127.0.0.1:${server.port}`); await page.evaluate(() => window.qaReady);
  }
  const titles = () => page.locator(".th-termhead-name").allTextContents();
  async function startOpen(locator) {
    const started = new Promise(done => { openStarted = done; });
    await locator.click(); await started; openStarted = undefined;
  }
  async function resolveOpen() {
    const done = page.waitForResponse(response => response.url().endsWith("/sessions/open"));
    releaseOpen(); await done;
  }
  await reset();
  await page.locator('[data-pane-id="right"] select').focus();
  await arm(`() => document.querySelector('[data-pane-id="right"] .th-termhead-name')?.textContent === 'Stored A'`);
  await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click(); await complete();
  assert.deepEqual(await titles(), ["Stored A"]);
  assert.equal(await page.locator('.th-pane--focused').count(), 1);
  assert.equal(await page.locator('[data-pane-id="left"] .th-picker-pane').count(), 1);
  results.push({ scenario: "move-hosted-session", pass: true });
  await page.screenshot({ path: resolve(evidence, "routing-move.png") });

  await reset();
  await startOpen(page.locator('[data-pane-id="right"] .th-picker-pane-item').filter({ hasText: "Discovered B" }));
  await page.locator('[data-pane-id="left"] .th-files-toggle').focus();
  await arm(`() => document.querySelector('[data-pane-id="right"] .th-termhead-name')?.textContent === 'Opened discovered-b'`);
  await resolveOpen(); await complete();
  assert.deepEqual(await titles(), ["Stored A", "Opened discovered-b"]);
  assert.equal(await page.locator('[data-pane-id="left"] .th-pane--focused').count(), 1);
  results.push({ scenario: "deferred-captured-target-focus-preserved", pass: true });
  await page.screenshot({ path: resolve(evidence, "routing-deferred.png") });
  for (const mode of ["newer", "closed"]) {
    await reset(); await page.locator('[data-pane-id="right"] select').focus();
    await startOpen(page.locator('.th-tree-activation').filter({ hasText: "Discovered B" }));
    if (mode === "newer") await page.locator('.th-tree-activation').filter({ hasText: /^Newer$/ }).click();
    else await page.locator('[data-pane-id="right"] .th-pane-close').click();
    await arm(`() => [...document.querySelectorAll('.th-tree-activation')].some(e => e.textContent === 'Opened discovered-b')`);
    await resolveOpen(); await complete();
    assert.deepEqual(await titles(), mode === "newer" ? ["Stored A", "Newer"] : ["Stored A"]);
    results.push({ scenario: `deferred-${mode}`, pass: true });
  }
  for (const narrow of [false, true]) {
    await reset(narrow ? leaf("left") : split("root", "h", leaf("left", stored.id), leaf("right")), narrow);
    const scope = narrow ? '.th-empty' : '[data-pane-id="right"]';
    assert.equal(await page.locator(`${scope} .th-picker-pane-item`).filter({ hasText: "Union row" }).count(), 1);
    await arm(`() => [...document.querySelectorAll('${scope} .th-picker-pane-item')].some(e => e.textContent === 'Discovered C')`);
    await page.locator(`${scope} .th-picker-load-more`).click(); await complete();
    await startOpen(page.locator(`${scope} .th-picker-pane-item`).filter({ hasText: "Discovered C" }));
    await arm(`() => [...document.querySelectorAll('.th-termhead-name')].some(e => e.textContent === 'Opened discovered-c')`);
    await resolveOpen(); await complete();
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      panes: [...document.querySelectorAll('.th-chat-pane')].map(e => e.getBoundingClientRect().toJSON()) }));
    assert(geometry.scrollWidth <= geometry.width);
    results.push({ scenario: `paged-discovered-narrow-${narrow}`, pass: true, geometry });
    await page.screenshot({ path: resolve(evidence, `session-open-${narrow ? "narrow" : "split"}.png`) });
  }
  assert.equal(requests.filter(r => r.method === "DELETE").length, 0);
  assert.equal(frames.filter(f => /stop|disconnect/.test(f.type)).length, 0);
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ pass: false, error: String(error), stack: error.stack }); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const socket of sockets) socket.close(); await server.stop(true);
  await save("routing.json", results); await save("traffic.json", { requests, frames }); await save("errors.json", errors);
  await save("cleanup.json", { browserClosed: !!browser, serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: server.port, fixtureInMemoryOnly: true });
}
console.log(JSON.stringify(results, null, 2));
