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
      return Response.json(await new Promise(done => { releaseOpen = (chat = { id: `opened-${body.id}`, name: `Opened ${body.id}`, provider: "omo" }) => done(chat); }));
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
const fixturePort = server.port;
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
  async function resolveOpen(chat, release = releaseOpen) {
    const done = page.waitForResponse(response => response.url().endsWith("/sessions/open"));
    release(chat); await done;
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
  await reset(split("root", "h", leaf("left"), leaf("right")));
  await startOpen(page.locator('[data-pane-id="right"] .th-picker-pane-item').filter({ hasText: "Discovered B" }));
  const oldSourceRelease = releaseOpen;
  await startOpen(page.locator('[data-pane-id="left"] .th-picker-pane-item').filter({ hasText: "Discovered B" }));
  await arm(`() => document.querySelector('[data-pane-id="left"] .th-termhead-name')?.textContent === 'Shared'`);
  await resolveOpen({ id: 'shared', name: 'Shared', provider: 'omo' }); await complete();
  // Distinct response metadata gives an exact DOM commit signal even when the
  // stale placement is correctly ignored and no chat reconnect should happen.
  await arm(`() => [...document.querySelectorAll('.th-tree-activation')].some(e => e.textContent === 'Older alias response')`);
  await resolveOpen({ id: 'shared', name: 'Older alias response', provider: 'omo' }, oldSourceRelease); await complete();
  assert.deepEqual(await titles(), ['Shared']);
  assert.equal(await page.locator('[data-pane-id="left"] .th-termhead-name').textContent(), 'Shared');
  assert.equal(await page.locator('[data-pane-id="right"] .th-picker-pane').count(), 1);
  results.push({ scenario: 'cross-pane-same-source-newer-intent', pass: true });

  await reset();
  await startOpen(page.locator('[data-pane-id="right"] .th-picker-pane-item').filter({ hasText: "Discovered B" }));
  await page.locator('[data-pane-id="left"] .th-files-toggle').focus();
  await page.locator('.th-tree-activation').filter({ hasText: /^Stored A$/ }).click();
  await arm(`() => [...document.querySelectorAll('.th-tree-activation')].some(e => e.textContent === 'Canonical alias response')`);
  await resolveOpen({ id: stored.id, name: 'Canonical alias response', provider: 'omo' }); await complete();
  assert.deepEqual(await titles(), ['Stored A']);
  assert.equal(await page.locator('[data-pane-id="left"] .th-termhead-name').textContent(), 'Stored A');
  assert.equal(await page.locator('[data-pane-id="right"] .th-picker-pane').count(), 1);
  results.push({ scenario: 'cross-pane-canonical-stored-intent', pass: true });

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
  const resizeLayouts = {
    h3: split("root", "h", split("inner", "h", leaf("a", stored.id), leaf("b")), leaf("c")),
    h4: split("root", "h", split("inner", "h", leaf("a", stored.id), leaf("b")), split("other", "h", leaf("c"), leaf("d"))),
    v3: split("root", "v", split("inner", "v", leaf("a", stored.id), leaf("b")), leaf("c")),
    v4: split("root", "v", split("inner", "v", leaf("a", stored.id), leaf("b")), split("other", "v", leaf("c"), leaf("d"))),
    mixed: split("root", "h", split("inner", "v", leaf("a", stored.id), leaf("b")), leaf("c")),
  };
  async function measureResize() {
    return page.evaluate(() => {
      const area = document.querySelector('.th-session-workarea').getBoundingClientRect();
      return { area: area.toJSON(), documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
        panes: [...document.querySelectorAll('.th-pane-wrap')].map(pane => {
          const rect = pane.getBoundingClientRect(), overlay = pane.querySelector('.th-pane-size');
          return { rect: rect.toJSON(), width: Number(overlay?.dataset.widthPercent), height: Number(overlay?.dataset.heightPercent),
            text: overlay?.textContent, pointerEvents: overlay && getComputedStyle(overlay).pointerEvents,
            controls: [...pane.querySelectorAll('.th-termhead button')].map(control => ({ label: control.getAttribute('aria-label') ?? control.title, rect: control.getBoundingClientRect().toJSON() })).filter(control => control.rect.width > 0) };
        }) };
    });
  }
  async function geometryMatches() {
    await page.evaluate(() => new Promise((done, fail) => {
      const timer = setTimeout(() => { ro.disconnect(); mo.disconnect(); fail(new Error('Overlay geometry deadline')); }, 8000);
      const area = document.querySelector('.th-session-workarea');
      const ro = new ResizeObserver(check), mo = new MutationObserver(check);
      function check() {
        const denominator = area.getBoundingClientRect();
        const panes = [...area.querySelectorAll('.th-pane-wrap')];
        if (panes.every(pane => {
          const rect = pane.getBoundingClientRect(), overlay = pane.querySelector('.th-pane-size');
          return overlay && Number(overlay.dataset.widthPercent) === Math.round(rect.width / denominator.width * 100)
            && Number(overlay.dataset.heightPercent) === Math.round(rect.height / denominator.height * 100);
        })) { clearTimeout(timer); ro.disconnect(); mo.disconnect(); done(true); }
      }
      ro.observe(area); for (const pane of area.querySelectorAll('.th-pane-wrap')) ro.observe(pane);
      mo.observe(area, { subtree: true, attributes: true, childList: true, characterData: true }); check();
    }));
  }
  for (const [width, height] of [[1440, 900], [1900, 1500]]) {
  for (const [name, tree] of Object.entries(resizeLayouts)) {
    await reset(tree);
    await page.setViewportSize({ width, height });
    assert.equal(await page.locator('.th-session-workarea').count(), 1);
    const origin = page.locator('[data-pane-id="a"] .th-pane-resize');
    await origin.focus(); await page.keyboard.press('Enter');
    // Header action exposes both the local and outer boundary without entering
    // any transcript. Choose the root boundary using only menu keyboard input.
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.locator('.th-pane-resize-menu [data-split-target="root"]').evaluate(e => document.activeElement === e), true);
    await page.keyboard.press('Enter');
    const divider = page.locator('[data-split-id="root"] > .th-divider');
    assert.equal(await divider.evaluate(e => document.activeElement === e), true);
    const samples = [];
    const previousRatio = Number(await divider.getAttribute('aria-valuenow'));
    for (const key of [name.startsWith('v') ? 'ArrowDown' : 'ArrowRight', name.startsWith('v') ? 'ArrowUp' : 'ArrowLeft', 'Home', 'End']) {
      await divider.press(key); await geometryMatches();
      const sample = await measureResize();
      if (width === 1900 && key.startsWith('Arrow')) {
        assert.equal(Number(await divider.getAttribute('aria-valuenow')), previousRatio + (key === 'ArrowDown' || key === 'ArrowRight' ? 5 : 0));
      }
      assert.equal(sample.panes.length, name.endsWith('4') ? 4 : 3);
      assert(sample.area.width < sample.viewportWidth); assert(sample.area.x >= 264);
      assert(sample.documentWidth <= sample.viewportWidth);
      for (const pane of sample.panes) {
        assert.equal(pane.pointerEvents, 'none');
        assert.deepEqual([...pane.text.matchAll(/(\d+)%/g)].map(match => Number(match[1])),
          [Math.round(pane.rect.width / sample.area.width * 100), Math.round(pane.rect.height / sample.area.height * 100)]);
        assert.equal(pane.width, Math.round(pane.rect.width / sample.area.width * 100));
        assert.equal(pane.height, Math.round(pane.rect.height / sample.area.height * 100));
        assert(pane.rect.left >= sample.area.left - 1 && pane.rect.right <= sample.area.right + 1);
        assert(pane.rect.top >= sample.area.top - 1 && pane.rect.bottom <= sample.area.bottom + 1);
        for (const control of pane.controls) assert(control.rect.left >= pane.rect.left - .5 && control.rect.right <= pane.rect.right + .5,
          `${name}/${key}: ${control.label} clipped: ${JSON.stringify({ control: control.rect, pane: pane.rect })}`);
      }
      samples.push({ key, ...sample });
    }
    await page.screenshot({ path: resolve(evidence, `resize-${name}-${width}.png`) });
    const ratio = await divider.getAttribute('aria-valuenow');
    await divider.press('Escape');
    assert.equal(await origin.evaluate(e => document.activeElement === e), true);
    assert.equal(await divider.getAttribute('aria-valuenow'), ratio);
    assert.equal(await page.locator('.th-pane-size').count(), 0);
    const rect = await divider.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
    await geometryMatches();
    if (width === 1900) await arm(`() => document.querySelector('[data-split-id="root"] > .th-divider').getAttribute('aria-valuenow') !== '${ratio}'`);
    await page.mouse.move(rect.x + rect.width / 2 - (name.startsWith('v') ? 0 : 60), rect.y + rect.height / 2 - (name.startsWith('v') ? 60 : 0));
    await page.mouse.up();
    if (width === 1900) await complete();
    await geometryMatches();
    assert.equal(await page.locator('.th-pane-size').count(), name.endsWith('4') ? 4 : 3);
    await divider.press('Escape'); assert.equal(await page.locator('.th-pane-size').count(), 0);
    results.push({ scenario: `resize-${name}-${width}`, pass: true, samples });
  }
  }
  await save('resize.json', results.filter(result => result.scenario?.startsWith('resize-')));
  assert.equal(requests.filter(r => r.method === "DELETE").length, 0);
  assert.equal(frames.filter(f => ["chat.abort", "chat.disconnect", "chat.close"].includes(f.type)).length, 0);
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ pass: false, error: String(error), stack: error.stack }); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const socket of sockets) socket.close(); await server.stop(true);
  await save("routing.json", results); await save("traffic.json", { requests, frames }); await save("errors.json", errors);
  await save("cleanup.json", { browserClosed: !!browser, serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: fixturePort, fixtureInMemoryOnly: true });
}
console.log(JSON.stringify(results, null, 2));
