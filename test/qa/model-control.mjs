/** C4 model control placement: actual production App, isolated in-memory HTTP/WS fixture.
 * QA_PLAYWRIGHT=/absolute/path/to/playwright-core/index.mjs bun test/qa/model-control.mjs EVIDENCE
 * Uses an already installed browser driver; adds no project dependency.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { startFixture } from "./pane-workspace-ui.mjs";
import { thinkingScenarios } from "./model-control-thinking.mjs";
import { shortMenuScenarios } from "./pane-workspace-short-menus.mjs";
import { createModelEvidence } from "./model-control-evidence.mjs";
const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { recursive: true });
const leaf = (id, sessionId = null) => ({ kind: "leaf", id, sessionId });
const stored = { id: "stored-a", name: "Stored A", provider: "omo" };
const catalog = [{ provider: "provider-a", modelId: "model-a", name: "Model A" },
  { provider: "provider-b", modelId: "model-b", name: "Model B" }];
let layout, seed = { reported: "high", catalog };
const requests = [], frames = [], results = [], errors = [];
const sockets = new Set(), pendingSends = new Map();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  async fetch(req, server) {
    const url = new URL(req.url), path = url.pathname;
    requests.push({ method: req.method, path: path + url.search });
    if (path === "/api/v2/ws" && server.upgrade(req)) return;
    if (path === "/api/auth/check") return new Response(null, { status: 204 });
    if (path === "/api/providers") return Response.json([{ id: "omo", label: "omo", available: true }]);
    if (path === "/api/workspaces") return Response.json([{ id: "ws", name: "Workspace", path: "/fixture", chats: [stored] }]);
    if (path === "/api/layout") { if (req.method === "PUT") layout = await req.json(); return Response.json({ layout }); }
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
      const send = value => ws.send(JSON.stringify({ sessionId: frame.sessionId ?? frame.chatId, ...value }));
      if (frame.type === "chat.create") {
        send({ type: "ready", resumed: true, piSessionId: frame.chatId });
        send({ type: "state", isStreaming: false, isCompacting: false,
          model: { provider: "provider-a", modelId: "model-a" }, thinkingLevel: seed.reported });
        if (seed.catalog) send({ type: "models", models: seed.catalog });
        if (seed.catalogFailure) send({ type: "error", code: "provider_error", command: "get_available_models", message: "fixture catalog failure" });
        send({ type: "commands", commands: [] });
        send({ type: "entries", entries: [], final: true });
      }
      if (frame.type === "chat.set") {
        send({ type: "ack", requestId: frame.requestId, command: frame.model ? "set_model" : "set_thinking" });
        send(frame.thinkingLevel && (seed.rejectThinking || seed.rejectThinkingLevel === frame.thinkingLevel)
          ? { type: "error", requestId: frame.requestId, command: "set_thinking_level", code: "provider_error", message: "fixture rejection" }
          : { type: "control.result", requestId: frame.requestId, command: frame.model ? "set_model" : "set_thinking_level", success: true });
      }
      if (frame.type === "chat.send") {
        // Admission owns request status, not a transcript row. Release only after
        // the browser has proved that boundary; echo once, then settle the request.
        pendingSends.set(frame.requestId, () => {
          pendingSends.delete(frame.requestId);
          send({ type: "message", message: { role: "user",
            blocks: [{ kind: "text", text: frame.run.message }], ts: 1 } });
          send({ type: "ack", requestId: frame.requestId, command: "chat.send", phase: "completed" });
        });
        send({ type: "ack", requestId: frame.requestId, command: "chat.send", phase: "admitted" });
      }
      if (frame.type === "chat.stats") send({ type: "stats", cost: 0 });
    },
  },
});
const fixturePort = server.port;
let browser, context, captureEvidence;
const save = (name, data) => writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + "\n");
const modelSets = () => frames.filter(f => f.type === "chat.set" && f.model);
const thinkingSets = () => frames.filter(f => f.type === "chat.set" && f.thinkingLevel);
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureEvidence = await createModelEvidence(page, evidence);
  const { shot } = captureEvidence;
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => {
    if (location.protocol !== "http:") return; // The reset document has an opaque origin.
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      set onmessage(handler) {
        super.onmessage = handler ? event => {
          handler.call(this, event);
          window.dispatchEvent(new CustomEvent('qa:wire', { detail: JSON.parse(event.data) }));
        } : null;
      }
    };
    localStorage.setItem("th-lang", "en"); localStorage.setItem("th-ws-expanded", '["ws"]');
    window.qaControl = command => new Promise((done, fail) => {
      const timer = setTimeout(() => { window.removeEventListener('qa:wire', listener); fail(new Error('Control deadline')); }, 8000);
      function listener(event) {
        if (event.detail.command !== command || !['control.result', 'error'].includes(event.detail.type)) return;
        clearTimeout(timer); window.removeEventListener('qa:wire', listener); done(event.detail);
      }
      window.addEventListener('qa:wire', listener);
    });
    window.qaSendAck = (phase, requestId) => new Promise((done, fail) => {
      const timer = setTimeout(() => { window.removeEventListener('qa:wire', listener); fail(new Error('Send ACK deadline: ' + phase)); }, 8000);
      function listener({ detail: frame }) {
        if (frame.type !== 'ack' || frame.command !== 'chat.send' || frame.sessionId !== 'stored-a'
          || frame.phase !== phase || (requestId && frame.requestId !== requestId)) return;
        clearTimeout(timer); window.removeEventListener('qa:wire', listener); done(frame);
      }
      window.addEventListener('qa:wire', listener);
    });
    window.qaSignal = predicate => new Promise((done, fail) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); fail(new Error("DOM signal deadline")); }, 8000);
      function check() { if (predicate()) { observer.disconnect(); clearTimeout(timer); done(true); } }
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); check();
    });
  });
  const arm = predicate => page.evaluate(source => { window.qaPending = window.qaSignal(new Function(`return (${source})`)()); }, predicate);
  const complete = () => page.evaluate(() => window.qaPending);
  async function reset(width, height, next = { reported: "high", catalog }) {
    await page.goto("about:blank");
    seed = next;
    layout = leaf("only", stored.id);
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.evaluate(expected => window.qaSignal(() =>
      document.querySelector(".th-model-picker-label")?.textContent === expected), seed.catalog?.length ? "Model A" : "provider-a/model-a");
  }
  const geometry = () => page.evaluate(() => {
    const control = document.querySelector(".th-chat-controls .th-model-picker-btn").getBoundingClientRect();
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
    const scenario = `model-control-${narrow ? "narrow" : "desktop"}`;
    const width = narrow ? 390 : 1440, height = narrow ? 844 : 900;
    await reset(width, height);
    const before = modelSets().length, beforeThinking = thinkingSets().length;
    const trigger = page.locator(".th-chat-controls .th-model-picker-btn");
    assert.equal(await trigger.count(), 1, "model trigger inside the merged status row");
    assert.equal(await page.locator(".th-termhead .th-model-picker").count(), 0, "no header model picker");
    assert((await trigger.textContent()).includes("Model A"), "exact current model identity on the trigger");
    assert.equal(await page.locator(".th-thinking-select").count(), 0, "no duplicate header select");
    assert((await trigger.textContent()).includes("high"), "trigger shows reported thinking at every width");
    assert((await trigger.getAttribute("aria-label")).includes("high"), "accessible thinking state");
    const closed = await geometry();
    assert(closed.control.bottom <= closed.capsule.top + 1, "control above the capsule");
    assert(closed.control.bottom <= closed.textarea.top + 1, "control above the textarea");
    // Right-aligned at the reading-column right edge; the capsule keeps an
    // additional internal gutter, so the control may extend past it by that
    // gutter but never past the form edge.
    assert(closed.control.right >= closed.capsule.right - 1.5, "control reaches the reading-column right edge");
    assert(closed.control.right <= closed.form.right + 1, "control stays inside the composer band");
    if (narrow) assert(closed.control.height >= 44, "compact control keeps its 44px touch target");
    await shot(`${scenario}-initial-closed.png`, { scenario, state: "initial-closed-high" });

    // Keyboard-only: open, traverse reasoning before search, select, then thinking max.
    await trigger.focus();
    await arm(`() => !!document.querySelector('.th-model-picker-popover')`);
    await page.keyboard.press("Enter"); await complete();
    assert(await page.locator(".th-model-picker-popover").evaluate(e => document.activeElement === e),
      "both presentations open with non-text container focus");
    await shot(`${scenario}-initial-open.png`, { scenario, state: "initial-open-high" });
    if (narrow) {
      await page.keyboard.press("Tab");
      assert(await page.locator(".th-model-picker-current .th-btn-icon").evaluate(e => document.activeElement === e));
    }
    for (const expected of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.textContent), expected);
    }
    await page.keyboard.press("Tab");
    assert(await page.locator(".th-model-picker-search").evaluate(e => document.activeElement === e),
      "forward Tab reaches search after reasoning");
    await page.keyboard.type("provider-b");
    await page.evaluate(() => { window.qaControlPending = window.qaControl('set_model'); });
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.qaControlPending);
    await page.evaluate(() => window.qaSignal(() =>
      document.querySelector(".th-chat-controls .th-model-picker-btn")?.textContent.includes("Model B")));
    assert.equal(await page.locator(".th-model-picker-popover").count(), 0, "popup closed after selection");
    assert.deepEqual(modelSets().slice(before).map(f => f.model),
      [{ provider: "provider-b", modelId: "model-b" }], "exactly one exact-identity model request");

    await trigger.focus();
    await arm(`() => !!document.querySelector('.th-model-picker-popover')`);
    await page.keyboard.press("Enter"); await complete();
    assert(await page.locator(".th-model-picker-popover").evaluate(e => document.activeElement === e),
      "reopening restores non-text initial focus");
    const open = await geometry();
    assert(open.popup, "popup present");
    assert(open.popup.bottom <= open.control.top + 1, "popup opens upward above the control");
    assert(open.popup.top >= 0 && open.popup.bottom <= height, "popup within the viewport");
    assert(open.popup.left >= 0 && open.popup.right <= width + 1, "popup horizontally contained");
    assert(open.popup.bottom <= open.capsule.top + 1, "popup does not cover the composer capsule or send action");
    assert.equal(await page.locator(".th-model-picker-current").evaluate(e => e.textContent.includes("provider-b")), true,
      "current provider/model identity pinned in the popup");
    await shot(`model-popup-${narrow ? "narrow" : "desktop"}.png`, { scenario, state: "model-b-confirmed-open-high" });
    const max = page.locator(".th-model-picker-popover .th-thinking-level", { hasText: /^max$/ });
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if (await max.evaluate(e => e === document.activeElement)) break;
    }
    assert(await max.evaluate(e => e === document.activeElement), "thinking max reachable from trigger using Tab");
    await page.evaluate(() => { window.qaControlPending = window.qaControl("set_thinking_level"); });
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.qaControlPending);
    await page.evaluate(() => window.qaSignal(() => !document.querySelector(".th-model-picker-popover")
      || !!document.querySelector(".th-model-picker-popover .th-thinking-level--active")?.textContent?.includes("max")));
    assert.deepEqual(thinkingSets().slice(beforeThinking).map(f => f.thinkingLevel), ["max"],
      "exactly one thinking request for max");
    await shot(`${scenario}-confirmed-max.png`, { scenario, state: "keyboard-confirmed-max" });
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
    const prompt = `c4 ${narrow ? "narrow" : "desktop"} prompt`;
    await page.keyboard.type(prompt);
    // Subscribe before submit. Observe actual App DOM and delivered wire without
    // intercepting sends or manufacturing production transcript state.
    await page.evaluate(() => {
      window.qaSendWire = [];
      window.qaPrematureUsers = 0;
      const sample = () => { window.qaPrematureUsers = Math.max(window.qaPrematureUsers,
        document.querySelectorAll('.th-chat-scrollport .th-chat-msg--user').length); };
      const observer = new MutationObserver(sample);
      observer.observe(document, { subtree: true, childList: true }); sample();
      window.qaSendListener = ({ detail: frame }) => {
        if (frame.sessionId !== 'stored-a') return;
        if (frame.type === 'message' && frame.message.role === 'user') {
          sample(); observer.disconnect(); window.qaSendWire.push(frame);
        } else if (frame.type === 'ack' && frame.command === 'chat.send') window.qaSendWire.push(frame);
      };
      window.addEventListener('qa:wire', window.qaSendListener);
      window.qaAdmission = Promise.all([window.qaSendAck('admitted'), window.qaSignal(() =>
        !!document.querySelector('.th-chat-send-status[data-send-phase="admitted"]'))]);
    });
    if (narrow) await page.locator(".th-chat-input .th-chat-send-btn").click();
    else await page.keyboard.press("Enter");
    const [admitted] = await page.evaluate(() => window.qaAdmission);
    const sends = frames.filter(f => f.type === "chat.send").slice(sendsBefore);
    assert.equal(sends.length, 1, "exactly one prompt transmitted");
    assert.equal(sends[0].run?.message, prompt);
    assert.equal(typeof sends[0].requestId, "string");
    assert(sends[0].requestId.length > 0, "request identity is present");
    assert.equal(admitted.requestId, sends[0].requestId, "admission belongs to the transmitted request");
    const requestId = admitted.requestId;
    assert.equal(await page.locator('.th-chat-send-status[data-send-phase="admitted"]').getAttribute('data-request-id'), requestId);
    assert.equal(await page.locator('.th-chat-scrollport .th-chat-msg--user').count(), 0, "admission creates no user row");
    assert.equal(await page.evaluate(() => window.qaPrematureUsers), 0, "no premature user row since submit");
    await page.evaluate(requestId => {
      window.qaCompletion = Promise.all([window.qaSendAck('completed', requestId), window.qaSignal(() =>
        document.querySelectorAll('.th-chat-scrollport .th-chat-msg--user').length === 1
        && !document.querySelector('.th-chat-send-status'))]);
    }, requestId);
    pendingSends.get(requestId)();
    const [completed] = await page.evaluate(() => window.qaCompletion);
    const { wire, prematureUsers } = await page.evaluate(() => {
      window.removeEventListener('qa:wire', window.qaSendListener);
      return { wire: window.qaSendWire, prematureUsers: window.qaPrematureUsers };
    });
    assert.equal(prematureUsers, 0, "no user row before canonical delivery");
    assert.deepEqual(wire, [admitted, { sessionId: stored.id, type: "message",
      message: { role: "user", blocks: [{ kind: "text", text: prompt }], ts: 1 } }, completed],
      "exactly one canonical message between correlated admitted/completed ACKs");
    assert.equal(await page.locator('.th-chat-scrollport .th-chat-msg--user').count(), 1);
    assert((await page.locator('.th-chat-scrollport .th-chat-msg--user').textContent()).includes(prompt));
    assert.equal(frames.filter(f => f.type === "chat.send").length - sendsBefore, 1, "completion does not resend");
    assert.equal(pendingSends.size, 0, "canonical release consumed exactly once");
    const after = await geometry();
    assert(after.scrollWidth <= after.viewport.width, "no horizontal overflow");
    results.push({ scenario: `model-control-${narrow ? "narrow" : "desktop"}`, pass: true,
      closed, open, sendCount: sends.length, prematureUsers, canonicalCount: 1, wire });
    await shot(`model-after-${narrow ? "narrow" : "desktop"}.png`, { scenario, state: "closed-max-after-send" });
  }
  assert.deepEqual(errors, []);

  await thinkingScenarios({ page, frames, results, reset,
    deliver: frame => { for (const socket of sockets) socket.send(JSON.stringify({ sessionId: stored.id, ...frame })); },
    shot,
  });

  // Shared strengthened checker replaces pane-only bounds and forced ancestor scrolling.
  // It checks all six short layouts plus 53 models, OPEN captures, ordinary wheel
  // and raw pointer selection, including complete search/thinking access.
  const fixture = startFixture({ port: 0 });
  try {
    await shortMenuScenarios({ fixture, save,
      async reset(seed, viewport) {
        fixture.reset(seed); await page.setViewportSize(viewport); await page.goto(fixture.url); return page;
      },
      shot,
      async scenario(name, action) { results.push({ scenario: name, pass: true, detail: await action() }); },
    });
    assert.deepEqual(fixture.unexpected, []);
  } finally {
    await save('bounded-menu-traffic.json', { frames: fixture.frames, requests: fixture.requests });
    await save('bounded-menu-cleanup.json', { url: fixture.url, ...await fixture.stop() });
  }
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ pass: false, error: String(error), stack: error.stack }); process.exitCode = 1;
} finally {
  // The recorder subscribed before navigation; await the actual owner teardown
  // before serializing evidence, rather than inferring it from browser shutdown.
  if (context) await context.close();
  if (browser) await browser.close();
  for (const socket of sockets) socket.close(); await server.stop(true);
  await save("model.json", results); await save("traffic.json", { requests, frames }); await save("errors.json", errors);
  await save("cleanup.json", { browserClosed: browser ? !browser.isConnected() : false, serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: fixturePort, fixtureInMemoryOnly: true });
  if (captureEvidence) await captureEvidence.finish();
}
console.log(JSON.stringify(results, null, 2));
