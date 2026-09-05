/** C4 model control placement: actual production App, isolated in-memory HTTP/WS fixture.
 * QA_PLAYWRIGHT=/absolute/path/to/playwright-core/index.mjs bun test/qa/model-control.mjs EVIDENCE
 * Uses an already installed browser driver; adds no project dependency.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const leaf = (id, sessionId = null) => ({ kind: "leaf", id, sessionId });
const stored = { id: "stored-a", name: "Stored A", provider: "omo" };
const catalog = [{ provider: "provider-a", modelId: "model-a", name: "Model A" },
  { provider: "provider-b", modelId: "model-b", name: "Model B" }];
let layout, persistLayout = true;
const requests = [], frames = [], results = [], errors = [];
const sockets = new Set();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(req, server) {
    const url = new URL(req.url), path = url.pathname;
    requests.push({ method: req.method, path: path + url.search });
    if (path === "/api/v2/ws" && server.upgrade(req)) return;
    if (path === "/api/auth/check") return new Response(null, { status: 204 });
    if (path === "/api/providers") return Response.json([{ id: "omo", label: "omo", available: true }]);
    if (path === "/api/workspaces") return Response.json([{ id: "ws", name: "Workspace", path: "/fixture", chats: [stored] }]);
    if (path === "/api/layout") { if (req.method === "PUT" && persistLayout) layout = await req.json(); return Response.json({ layout }); }
    if (path === "/api/workspaces/ws/sessions") return Response.json({ items: [], nextCursor: "" });
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
        send({ type: "state", isStreaming: false, isCompacting: false,
          model: { provider: "provider-a", modelId: "model-a" }, thinkingLevel: "low" });
        send({ type: "models", models: catalog }); send({ type: "commands", commands: [] });
        send({ type: "entries", entries: [], final: true });
      }
      if (frame.type === "chat.stats") send({ type: "stats", cost: 0 });
    },
  },
});
const fixturePort = server.port;
let browser;
const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + "\n");
const modelSets = () => frames.filter(f => f.type === "chat.set" && f.model);
const thinkingSets = () => frames.filter(f => f.type === "chat.set" && f.thinkingLevel);
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
  });
  const arm = predicate => page.evaluate(source => { window.qaPending = window.qaSignal(new Function(`return (${source})`)()); }, predicate);
  const complete = () => page.evaluate(() => window.qaPending);
  async function reset(width, height) {
    layout = leaf("only", stored.id);
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector(".th-chat-pane .th-model-picker-btn")));
  }
  const geometry = () => page.evaluate(() => {
    const control = document.querySelector(".th-composer-model .th-model-picker-btn").getBoundingClientRect();
    const form = document.querySelector(".th-chat-input").getBoundingClientRect();
    const capsule = document.querySelector(".th-chat-input-inner").getBoundingClientRect();
    const textarea = document.querySelector(".th-chat-input textarea").getBoundingClientRect();
    const popup = document.querySelector(".th-model-picker-popover")?.getBoundingClientRect();
    return { control: control.toJSON(), form: form.toJSON(), capsule: capsule.toJSON(),
      textarea: textarea.toJSON(), popup: popup?.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth };
  });

  for (const narrow of [false, true]) {
    const width = narrow ? 390 : 1440, height = narrow ? 844 : 900;
    await reset(width, height);
    const before = modelSets().length, beforeThinking = thinkingSets().length;
    const trigger = page.locator(".th-composer-model .th-model-picker-btn");
    assert.equal(await trigger.count(), 1, "model trigger inside the composer band");
    assert.equal(await page.locator(".th-termhead .th-model-picker").count(), 0, "no header model picker");
    assert((await trigger.textContent()).includes("Model A"), "exact current model identity on the trigger");
    if (narrow) assert((await trigger.textContent()).includes("low"), "compact trigger shows the thinking level");
    const closed = await geometry();
    assert(closed.control.bottom <= closed.capsule.top + 1, "control above the capsule");
    assert(closed.control.bottom <= closed.textarea.top + 1, "control above the textarea");
    // Right-aligned at the reading-column right edge; the capsule keeps an
    // additional internal gutter, so the control may extend past it by that
    // gutter but never past the form edge.
    assert(closed.control.right >= closed.capsule.right - 1.5, "control reaches the reading-column right edge");
    assert(closed.control.right <= closed.form.right + 1, "control stays inside the composer band");
    if (narrow) assert(closed.control.height >= 44, "compact control keeps its 44px touch target");

    // Keyboard-only: open, filter to provider-b/model-b, select, then thinking high.
    await trigger.focus();
    await arm(`() => !!document.querySelector('.th-model-picker-popover')`);
    await page.keyboard.press("Enter"); await complete();
    if (narrow) {
      // Sheet: search is not focused; Tab cycles sheet controls until search.
      assert(!(await page.evaluate(() => document.activeElement?.classList.contains("th-model-picker-search"))),
        "narrow sheet does not focus search on open");
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => document.activeElement?.classList.contains("th-model-picker-search"))) break;
      }
      assert(await page.evaluate(() => document.activeElement?.classList.contains("th-model-picker-search")),
        "sheet Tab cycle reaches search");
    } else {
      assert(await page.evaluate(() => document.activeElement?.classList.contains("th-model-picker-search")),
        "desktop popup focuses search on open");
    }
    await page.keyboard.type("provider-b");
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.qaSignal(() =>
      document.querySelector(".th-composer-model .th-model-picker-btn")?.textContent.includes("Model B")));
    assert.equal(await page.locator(".th-model-picker-popover").count(), 0, "popup closed after selection");
    assert.deepEqual(modelSets().slice(before).map(f => f.model),
      [{ provider: "provider-b", modelId: "model-b" }], "exactly one exact-identity model request");

    await trigger.focus();
    await arm(`() => !!document.querySelector('.th-model-picker-popover')`);
    await page.keyboard.press("Enter"); await complete();
    const open = await geometry();
    assert(open.popup, "popup present");
    assert(open.popup.bottom <= open.control.top + 1, "popup opens upward above the control");
    assert(open.popup.top >= 0 && open.popup.bottom <= height, "popup within the viewport");
    assert(open.popup.left >= 0 && open.popup.right <= width + 1, "popup horizontally contained");
    assert(open.popup.bottom <= open.capsule.top + 1, "popup does not cover the composer capsule or send action");
    assert.equal(await page.locator(".th-model-picker-current").evaluate(e => e.textContent.includes("provider-b")), true,
      "current provider/model identity pinned in the popup");
    await page.screenshot({ path: resolve(evidence, `model-popup-${narrow ? "narrow" : "desktop"}.png`) });
    const high = page.locator(".th-model-picker-popover .th-thinking-level", { hasText: /^high$/ });
    await high.click();
    await page.evaluate(() => window.qaSignal(() => !document.querySelector(".th-model-picker-popover")
      || !!document.querySelector(".th-model-picker-popover .th-thinking-level--active")?.textContent?.includes("high")));
    assert.deepEqual(thinkingSets().slice(beforeThinking).map(f => f.thinkingLevel), ["high"],
      "exactly one thinking request for high");
    // The picker stays open after a thinking change; dismiss and verify focus restoration.
    if (narrow) {
      await page.locator(".th-model-picker-popover--sheet .th-model-picker-current .th-btn-icon").click();
    } else {
      await page.keyboard.press("Escape");
    }
    assert.equal(await page.locator(".th-model-picker-popover").count(), 0);
    assert(await trigger.evaluate(e => document.activeElement === e), "close restores focus to the trigger");

    // Composer remains functional: type and send a prompt, exactly once.
    // Mobile reserves Enter for newlines, so submission goes through the send action.
    const sendsBefore = frames.filter(f => f.type === "chat.send").length;
    await page.locator(".th-chat-input textarea").click();
    await page.keyboard.type(`c4 ${narrow ? "narrow" : "desktop"} prompt`);
    if (narrow) await page.locator(".th-chat-input .th-chat-send-btn").click();
    else await page.keyboard.press("Enter");
    await page.evaluate(() => window.qaSignal(() =>
      [...document.querySelectorAll(".th-chat-msg")].some(row => row.textContent?.includes("c4"))));
    const sends = frames.filter(f => f.type === "chat.send").slice(sendsBefore);
    assert.equal(sends.length, 1, "exactly one prompt transmitted");
    assert.equal(sends[0].run?.message, `c4 ${narrow ? "narrow" : "desktop"} prompt`);
    const after = await geometry();
    assert(after.scrollWidth <= after.viewport.width, "no horizontal overflow");
    results.push({ scenario: `model-control-${narrow ? "narrow" : "desktop"}`, pass: true,
      closed, open, sendCount: sends.length });
    await page.screenshot({ path: resolve(evidence, `model-after-${narrow ? "narrow" : "desktop"}.png`) });
  }
  assert.deepEqual(errors, []);

  // Short-pane clipping: a real persisted vertical split gives a wide
  // (>=601px) pane a ~225-300px tall band. The upward desktop popup must keep
  // its chrome (current identity, thinking controls, search) visible and every
  // model option reachable by scrolling and pointer hit-testing inside the
  // clipping .th-chat-main band.
  // Vertical split minimum pane spans lock the inner ratio under deficit, so
  // the band height is driven by the viewport: 900px yields ~297px, 700px
  // yields ~223px for the hosted top pane.
  const v3 = { kind: "split", id: "root", dir: "v", ratio: 0.7,
    first: { kind: "split", id: "inner", dir: "v", ratio: 0.5,
      first: leaf("top-a", stored.id), second: leaf("mid-b") },
    second: leaf("bottom-c") };
  for (const viewportHeight of [900, 700]) {
    layout = v3;
    // The App PUTs its loaded layout back on change; keep the seeded tree
    // authoritative for this scenario.
    persistLayout = false;
    await page.setViewportSize({ width: 1440, height: viewportHeight });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.evaluate(() => window.qaSignal(() =>
      !!document.querySelector('[data-pane-id="top-a"] .th-model-picker-btn')));
    const paneRect = await page.locator('[data-pane-id="top-a"]').evaluate(e => e.getBoundingClientRect().toJSON());
    assert(paneRect.width >= 601, `short-pane scenario needs a wide pane, got ${paneRect.width}`);
    assert(paneRect.height <= 300 && paneRect.height >= 150, `short-pane band height, got ${paneRect.height}`);
    const trigger = page.locator('[data-pane-id="top-a"] .th-composer-model .th-model-picker-btn');
    // Pointer hit-testing must work in the valid layout: a real click opens the picker.
    await trigger.click();
    await page.evaluate(() => window.qaSignal(() => !!document.querySelector(".th-model-picker-popover")));
    const short = await page.evaluate(() => {
      const pane = document.querySelector('[data-pane-id="top-a"]').getBoundingClientRect();
      const popup = document.querySelector(".th-model-picker-popover").getBoundingClientRect();
      const hit = (el) => {
        const rect = el.getBoundingClientRect();
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return point === el || el.contains(point);
      };
      const search = document.querySelector(".th-model-picker-search");
      const current = document.querySelector(".th-model-picker-current");
      const thinking = document.querySelector(".th-thinking-in-picker");
      const list = document.querySelector(".th-model-picker-list");
      return { pane: pane.toJSON(), popup: popup.toJSON(),
        searchHit: hit(search), currentHit: hit(current), thinkingHit: hit(thinking),
        listScroll: { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } };
    });
    assert(short.popup.height > 0, "popup has usable height in a short pane");
    assert(short.popup.top >= short.pane.top - 1,
      `popup clipped by the pane header: ${JSON.stringify({ popup: short.popup, pane: short.pane })}`);
    assert(short.popup.bottom <= short.pane.bottom + 1,
      `popup exceeds the pane band: ${JSON.stringify({ popup: short.popup, pane: short.pane })}`);
    for (const name of ["searchHit", "currentHit", "thinkingHit"]) {
      assert(short[name], `popup chrome ${name} not pointer-reachable: ${JSON.stringify(short)}`);
    }
    // Every model option is reachable: scroll the list so the target row is
    // visible, prove hit-testing, and click it for an exact chat.set.
    const shortSets = modelSets().length;
    const target = page.locator('[data-pane-id="top-a"] .th-model-picker-popover [role="option"]', { hasText: "Model B" });
    await target.scrollIntoViewIfNeeded();
    assert(await target.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return point === el || el.contains(point);
    }), "target option not pointer-reachable after scrolling");
    await target.click();
    await page.evaluate(() => window.qaSignal(() => !document.querySelector(".th-model-picker-popover")));
    assert.deepEqual(modelSets().slice(shortSets).map(f => f.model),
      [{ provider: "provider-b", modelId: "model-b" }], "short-pane selection sends exact identity");
    await page.screenshot({ path: resolve(evidence, `model-short-pane-${Math.round(paneRect.height)}.png`) });
    results.push({ scenario: `model-short-pane-${Math.round(paneRect.height)}`, pass: true, paneRect, short });
  }
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ pass: false, error: String(error), stack: error.stack }); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const socket of sockets) socket.close(); await server.stop(true);
  await save("model.json", results); await save("traffic.json", { requests, frames }); await save("errors.json", errors);
  await save("cleanup.json", { browserClosed: !!browser, serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: fixturePort, fixtureInMemoryOnly: true });
}
console.log(JSON.stringify(results, null, 2));
