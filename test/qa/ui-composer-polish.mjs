/** C3 compact right model row + C4 safe model sheet bounds: actual production App.
 * Isolated in-memory HTTP/WS fixture (design workbench seed), ephemeral ports.
 * QA_PLAYWRIGHT=/Users/mirage/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs \
 *   bun test/qa/ui-composer-polish.mjs EVIDENCE [c3|c4|all]
 *
 * The controlled fixture never auto-ACKs sends, so send/unknown states are
 * explicit fixture transitions and every wait is a DOM predicate completion.
 *
 * Environment emulation (documented, no product CSS injection):
 *  - Safe-area insets: CDP Emulation.setSafeAreaInsetsOverride produces real
 *    env(safe-area-inset-*) values in this Chrome build. It emulates the device
 *    environment; physical-device evidence remains a separate label.
 *  - Software keyboard: focusing the sheet search (the keyboard summon point)
 *    plus a coherent Playwright viewport resize,
 *    which fires the same visualViewport resize path as a keyboard.
 *  - Pan: coarse-pointer desktop rendering (mobile=false) lets CDP page-scale
 *    emulation bypass the SPA's mobile maximum-scale=1 policy. Native touch
 *    gestures then pan the actual visualViewport; no properties are mocked.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setupComposer, transition, safeBounds, fits, viewportState, assertViewportHeld, nativeCapture, nativeClosePoint, nativeMouse, nativeScroll } from "./ui-composer-fixture.mjs";

const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const evidence = resolve(process.argv[2]);
const phase = process.argv[3] ?? "all";
const theme = process.env.QA_THEME ?? 'dark';
assert.ok(['dark', 'light'].includes(theme), `Unknown theme: ${theme}`);
await mkdir(evidence, { recursive: true });
const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
const shot = async (page, name) => {
  const session = await page.context().newCDPSession(page);
  try { await writeFile(resolve(evidence, name), await nativeCapture(session)); }
  finally { await session.detach(); }
};
const requested = process.env.QA_SCENARIOS?.split(',');
let executed = 0;
const selected = label => {
  if (requested && !requested.includes(label)) return false;
  executed++; return true;
};
assert.ok(["all", "c3", "c4"].includes(phase), `Unknown phase: ${phase}`);
const results = [], failures = [], cleanup = [];
const root = resolve(import.meta.dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const binding = () => ({
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDiffSha256: sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root })),
  productDiffSha256: sha(execFileSync('git', ['diff', '--', 'frontend/src'], { cwd: root })),
  files: ['test/qa/ui-composer-polish.mjs', 'test/qa/ui-composer-fixture.mjs',
    ...readdirSync(resolve(root, 'frontend/dist'), { recursive: true }).filter(path => /\.(html|js|css)$/.test(path))
      .map(path => `frontend/dist/${path}`)].sort().map(path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })),
});
const beforeBinding = binding();
await save('run-binding-before.json', beforeBinding);
const record = (id, pass, actual) => {
  results.push({ id, pass, actual });
  if (!pass) failures.push({ id, actual });
};

/** Shared geometry readout for the compact status/model control row. */
const rowGeometry = () => {
  const rect = (element) => element ? element.getBoundingClientRect().toJSON() : null;
  return {
    pane: rect(document.querySelector('[data-pane-id="a"]') ?? document.querySelector(".th-pane")),
    row: rect(document.querySelector(".th-chat-controls")),
    status: rect(document.querySelector(".th-chat-status")),
    trigger: rect(document.querySelector(".th-model-picker-btn")),
    capsule: rect(document.querySelector(".th-chat-input-inner")),
    details: rect(document.querySelector(".th-chat-status-details")),
    sameRow: (() => {
      const row = document.querySelector(".th-chat-controls");
      const status = document.querySelector(".th-chat-status");
      const trigger = document.querySelector(".th-model-picker-btn");
      return !!row && !!status && !!trigger && row.contains(status) && row.contains(trigger);
    })(),
    order: (() => {
      const status = document.querySelector(".th-chat-status");
      const trigger = document.querySelector(".th-model-picker-btn");
      return !!status && !!trigger
        && !!(status.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
    liveScope: (() => {
      const status = document.querySelector(".th-chat-status");
      const trigger = document.querySelector(".th-model-picker-btn");
      return !!status && !!trigger && !status.contains(trigger)
        && status.getAttribute("role") === "status" && status.getAttribute("aria-live") === "polite";
    })(),
    composerDetached: (() => {
      const trigger = document.querySelector(".th-model-picker-btn");
      return !document.querySelector(".th-composer-model") && !!trigger && trigger.closest(".th-chat-input") === null;
    })(),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    viewport: { width: innerWidth, height: innerHeight },
  };
};
const within = (value, bound) => Math.abs(value - bound) <= 2;

/** Focus alone need not mutate or resize the DOM. Observe the actual focus event. */
async function focusByKey(page, key, selector) {
  await page.evaluate(selector => {
    window.qaFocusPending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.removeEventListener('focusin', focused, true); reject(new Error('Keyboard focus deadline')); }, 8000);
      function focused(event) {
        clearTimeout(timer); document.removeEventListener('focusin', focused, true);
        if (event.isTrusted && event.target.matches(selector) && document.activeElement === event.target) resolve(true);
        else reject(new Error(`Keyboard focused unexpected target: ${event.target.outerHTML}`));
      }
      document.addEventListener('focusin', focused, true);
    });
  }, selector);
  await Promise.all([page.evaluate(() => window.qaFocusPending), page.keyboard.press(key)]);
}

/** C3: one compact row — statuses left, model pinned right, details and
 * recovery reachable, model/thinking/search and send behavior intact. */
async function c3Scenario(browser, { width, height, coarse, paneWidth, label, keyboardHeight }) {
  if (!selected(label)) return;
  const q = await setupComposer(browser, { viewport: { width, height }, coarse, paneWidth, theme });
  const { page, fixture } = q;
  const sendFrames = () => fixture.frames.filter(frame => frame.type === "chat.send");
  const deliver = (frame, predicate) => transition(page, predicate, () => fixture.deliver("stored-a", frame));
  try {
    await save(`c3-${label}-startup.json`, { url: fixture.url, state: fixture.runState("stored-a"), traffic: fixture.traffic });
    record(`c3-${label}-theme`, await page.evaluate(() => document.documentElement.dataset.theme) === theme, { theme });
    if (label === 'desktop-1280') {
      await transition(page, "() => !!document.querySelector('.th-settings-panel')",
        () => page.locator('.th-settings-menu > button').click());
      for (const target of [theme === 'dark' ? 'light' : 'dark', theme]) {
        await transition(page, `() => document.documentElement.dataset.theme === '${target}' && localStorage.getItem('th-theme') === '${target}'`,
          () => page.getByRole('radio', { name: target === 'dark' ? 'Dark' : 'Light', exact: true }).click());
      }
      record(`c3-${label}-settings-theme-roundtrip`, true, await page.evaluate(() => ({ resolved: document.documentElement.dataset.theme, stored: localStorage.getItem('th-theme') })));
      await transition(page, "() => !document.querySelector('.th-settings-panel')", () => page.keyboard.press('Escape'));
    }
    record(`c3-${label}-queue-visible`, await page.locator('.th-queue-header').isVisible(), fixture.runState('stored-a').queue);
    await deliver({ type: "stats", cost: 0.125, contextUsage: { percent: 42, used: 42000, total: 100000 },
      tokens: { input: 30, cacheRead: 70, output: 5 } },
      "() => [...document.querySelectorAll('.th-chat-status-num')].some(n => n.textContent === '70%')");
    // The real transport is held offline, not React state. Subscribe before
    // dropping the owned socket and before bringing the network back online.
    await page.locator('.th-chat-input textarea').click();
    const focusBeforeReconnect = await page.locator('.th-chat-input textarea').evaluate(el => document.activeElement === el);
    const reconnectStart = fixture.traffic.length;
    const closed = fixture.wait('subscription', event => event.sessionId === 'stored-a' && event.action === 'close');
    await Promise.all([closed, transition(page,
      "() => !navigator.onLine && [...document.querySelectorAll('.th-chat-status > .th-chat-status-item--warn')].some(el => /reconnect/i.test(el.textContent))",
      async () => { await q.context.setOffline(true); fixture.disconnect('stored-a'); })]);
    const disconnected = await page.evaluate(rowGeometry);
    const offline = await page.evaluate(() => ({ online: navigator.onLine,
      urgent: [...document.querySelectorAll('.th-chat-status > .th-chat-status-item--warn')].map(el => {
        const rect = el.getBoundingClientRect(), owner = el.closest('.th-chat-status').getBoundingClientRect();
        const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { text: el.textContent, rect: rect.toJSON(), hit: el === at || el.contains(at),
          contained: rect.left >= owner.left && rect.right <= owner.right && rect.top >= owner.top && rect.bottom <= owner.bottom };
      }) }));
    record(`c3-${label}-reconnecting-priority`, !offline.online && offline.urgent.length > 0
      && offline.urgent.every(item => item.hit && item.contained)
      && disconnected.trigger.left >= disconnected.pane.left && disconnected.trigger.right <= disconnected.pane.right
      && within(disconnected.trigger.right, disconnected.capsule.right), { offline, geometry: disconnected });
    await shot(page, `c3-${label}-reconnecting.png`);
    const reattached = fixture.wait('subscription', event => event.sessionId === 'stored-a' && event.action === 'attach');
    await Promise.all([reattached, transition(page,
      "() => navigator.onLine && ![...document.querySelectorAll('.th-chat-status > .th-chat-status-item--warn')].some(el => /reconnect/i.test(el.textContent)) && !!document.querySelector('.th-chat-status-item--live')",
      () => q.context.setOffline(false))]);
    const focusAfterReconnect = await page.locator('.th-chat-input textarea').evaluate(el => document.activeElement === el);
    record(`c3-${label}-reconnected-no-resend`, sendFrames().length === 0 && fixture.subscribers('stored-a') === 1
      && focusBeforeReconnect && focusAfterReconnect,
      { focusBeforeReconnect, focusAfterReconnect, frames: sendFrames(), traffic: fixture.traffic.slice(reconnectStart) });
    await deliver({ type: "compaction.started" },
      "() => !!document.querySelector('.th-chat-status > .th-chat-status-item--warn')");

    // Meta+Enter is the public steer action on both touch and fine-pointer devices.
    // A running composer's arrow button is STOP, not send.
    const textarea = page.locator('.th-chat-input textarea');
    const steerText = "보류 중인 긴 한국어 요청 상태를 확인하기 위한 원본 텍스트입니다";
    await textarea.fill(steerText);
    const steered = fixture.wait('frame', f => f.type === 'chat.send' && f.run?.message === steerText);
    await transition(page, "() => !!document.querySelector('.th-chat-status-item--steer')",
      () => textarea.press('Meta+Enter'));
    const steer = await steered;
    record(`c3-${label}-steer`, steer.run.kind === 'steer' && sendFrames().length === 1, steer);

    const geometry = await page.evaluate(rowGeometry);
    if (paneWidth) record(`c3-${label}-actual-desktop-split`, Math.abs(geometry.pane.width - paneWidth) < 1
      && geometry.viewport.width === 1280 && !coarse, geometry);
    await shot(page, `c3-${label}-row.png`);
    const metrics = await page.evaluate(() => ({
      collapsed: !document.querySelector('.th-chat-status-details').open,
      direct: [...document.querySelectorAll('.th-chat-status .th-chat-status-num')].filter(el => !el.closest('.th-chat-status-details')).map(el => ({ text: el.textContent, rect: el.getBoundingClientRect().toJSON() })),
      disclosed: [...document.querySelectorAll('.th-chat-status-details .th-chat-status-num')].map(el => el.textContent),
    }));
    record(`c3-${label}-secondary-metrics-disclosure-only`, metrics.collapsed && metrics.direct.length === 0 && metrics.disclosed.length === 2 && metrics.disclosed.includes('42%') && metrics.disclosed.includes('70%'), metrics);
    record(`c3-${label}-shared-row`, geometry.sameRow && geometry.order && geometry.liveScope && geometry.composerDetached, geometry);
    record(`c3-${label}-right-edge`, !!geometry.trigger && !!geometry.capsule
      && within(geometry.trigger.right, geometry.capsule.right), geometry);
    record(`c3-${label}-one-row`, !!geometry.status && !!geometry.trigger
      && geometry.trigger.top < geometry.status.bottom && geometry.status.top < geometry.trigger.bottom
      && geometry.trigger.left >= geometry.status.right - 1, geometry);
    record(`c3-${label}-model-visible`, !!geometry.trigger && geometry.trigger.width > 0
      && geometry.trigger.right <= width && geometry.trigger.left >= 0
      && geometry.trigger.height >= (coarse ? 44 : 20), geometry);
    record(`c3-${label}-no-overflow`, geometry.overflow <= 0, geometry);

    // Establish focus through actual UI, then reach Details with Shift+Tab.
    // Keyboard focus scrolls the narrow status strip itself into view.
    await transition(page, "() => !!document.querySelector('.th-model-picker-popover')",
      () => page.locator('.th-model-picker-btn').click());
    await transition(page, "() => !document.querySelector('.th-model-picker-popover') && document.activeElement.matches('.th-model-picker-btn')",
      () => page.keyboard.press('Escape'));
    await focusByKey(page, 'Shift+Tab', '.th-chat-status-details summary');
    const summary = await page.locator('.th-chat-status-details summary').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { rect: rect.toJSON(), coarse: matchMedia('(pointer: coarse)').matches,
        hit: hit === el || el.contains(hit), visible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
    });
    record(`c3-${label}-details-target`, summary.coarse === coarse && summary.hit && summary.visible
      && (!coarse || (summary.rect.width >= 44 && summary.rect.height >= 44)), summary);
    await transition(page, "() => document.querySelector('.th-chat-status-details').open && document.activeElement.matches('.th-chat-status-details summary')",
      () => page.keyboard.press('Enter'));
    const openMetrics = await page.evaluate(() => ({
      direct: [...document.querySelectorAll('.th-chat-status .th-chat-status-num')].filter(el => !el.closest('.th-chat-status-details')).map(el => el.textContent),
      disclosed: [...document.querySelectorAll('.th-chat-status-details .th-chat-status-num')].map(el => el.textContent) }));
    record(`c3-${label}-open-secondary-metrics-disclosure-only`, openMetrics.direct.length === 0
      && openMetrics.disclosed.length === 2 && openMetrics.disclosed.includes('42%') && openMetrics.disclosed.includes('70%'), openMetrics);
    await shot(page, `c3-${label}-details-keyboard.png`);
    await transition(page, "() => !document.querySelector('.th-chat-status-details').open && document.activeElement.matches('.th-chat-status-details summary')",
      () => page.keyboard.press('Space'));
    record(`c3-${label}-details-keyboard`, true, { keys: ['Shift+Tab', 'Enter', 'Space'], focus: 'summary', summary });

    await transition(page, "() => document.querySelector('.th-chat-status-details')?.open === true",
      () => page.locator('.th-chat-status-details summary').click());
    const details = await page.evaluate(() => ({ text: document.querySelector('.th-chat-status-details')?.textContent,
      directUrgent: !!document.querySelector('.th-chat-status > .th-chat-status-item--warn') }));
    record(`c3-${label}-details-content`, details.text.includes('42%') && details.text.includes('70%') && details.directUrgent, details);
    await transition(page, "() => document.querySelector('.th-chat-status-details')?.open === false",
      () => page.locator('.th-chat-status-details summary').click());

    await transition(page, "() => !!document.querySelector('.th-model-picker-popover')",
      () => page.locator('.th-model-picker-btn').click());
    await transition(page, "() => document.querySelectorAll('.th-model-picker-list [role=option]').length === 1 && document.querySelector('.th-model-picker-list [role=option] span')?.textContent === 'provider-b'",
      () => page.locator('.th-model-picker-search').fill('provider-b'));
    const selected = fixture.wait('frame', f => f.type === 'chat.set' && f.model?.provider === 'provider-b');
    await transition(page, "() => !document.querySelector('.th-model-picker-popover') && document.querySelector('.th-model-picker-btn')?.textContent.includes('Model B')",
      () => page.locator('.th-model-picker-list [role=option]').click());
    const modelFrame = await selected;
    record(`c3-${label}-model-selection`, modelFrame.model.modelId === 'model-b'
      && fixture.frames.filter(f => f.type === 'chat.set' && f.model).length === 1
      && await page.locator('.th-model-picker-btn').evaluate(el => document.activeElement === el), modelFrame);
    await transition(page, "() => !!document.querySelector('.th-model-picker-popover')",
      () => page.locator('.th-model-picker-btn').click());
    const current = await page.locator('.th-model-picker-list [aria-selected=true]').allTextContents();
    record(`c3-${label}-current-selection`, current.length === 1 && current[0].includes('provider-b'), current);
    const thinking = fixture.wait('frame', f => f.type === 'chat.set' && f.thinkingLevel === 'high');
    await transition(page, "() => [...document.querySelectorAll('.th-thinking-level[aria-pressed=true]')].some(el => el.textContent === 'high')",
      () => page.locator('.th-thinking-level').getByText('high', { exact: true }).click());
    const thinkingFrame = await thinking;
    record(`c3-${label}-thinking`, thinkingFrame.thinkingLevel === 'high'
      && fixture.frames.filter(f => f.type === 'chat.set' && f.thinkingLevel).length === 1, thinkingFrame);
    await transition(page, "() => !document.querySelector('.th-model-picker-popover')",
      () => page.keyboard.press('Escape'));
    await shot(page, `c3-${label}-selected.png`);

    // Finish the exact steer, clear the fixture-owned queue, and end the seeded
    // run before testing an ordinary send. No automatic ACK can race recovery.
    await deliver({ type: 'ack', command: 'chat.send', requestId: steer.requestId, phase: 'completed' },
      "() => !document.querySelector('.th-chat-status-item--steer')");
    await deliver({ type: 'queue', revision: 2, items: [], engine: { pendingMessageCount: 0, ordered: [] } },
      "() => !document.querySelector('.th-queue-header')");
    await deliver({ type: 'compaction.done' }, "() => !document.querySelector('.th-chat-status-item--warn')");
    await deliver({ type: 'run.done', reason: 'stop' }, "() => !document.querySelector('.th-chat-status-item--live') && document.querySelector('.th-chat-send-btn')?.type === 'submit'");

    const original = '원본 복구 요청 ' + 'inspectable original '.repeat(12) + 'TAIL-ALPHA';
    await textarea.fill(original);
    const submitted = fixture.wait('frame', f => f.type === 'chat.send' && f.run?.message === original);
    await transition(page, "() => !!document.querySelector('.th-chat-send-status[data-send-phase=sending]') && document.querySelector('textarea').value === ''",
      () => page.locator('.th-chat-send-btn').click());
    const request = await submitted;
    const selector = `[data-request-id="${request.requestId}"]`;
    const probe = suffix => page.locator(`${selector} ${suffix}`);
    await deliver({ type: 'run.done', reason: 'local_command' },
      `() => !!document.querySelector('${selector}[data-send-phase=unknown] .th-send-restore')`);
    // Keep a newer unsent draft so inspection cannot accidentally masquerade as recovery.
    await textarea.fill('newer unsent draft');
    const before = { sends: sendFrames().length, queue: fixture.runState('stored-a').queue,
      status: await page.locator(selector).evaluate(el => el.outerHTML) };
    for (const close of ['escape', 'button']) {
      await transition(page, "() => !!document.querySelector('.th-chat-original-text')",
        () => probe('.th-chat-send-preview').click());
      const inspected = await page.locator('.th-chat-original-text').textContent();
      await transition(page, "() => !document.querySelector('.th-chat-original-text')",
        () => close === 'escape' ? page.keyboard.press('Escape') : page.locator('[role=dialog] .th-modal-close').click());
      const after = { sends: sendFrames().length, queue: fixture.runState('stored-a').queue,
        status: await page.locator(selector).evaluate(el => el.outerHTML), draft: await textarea.inputValue(),
        focusRestored: await probe('.th-chat-send-preview').evaluate(el => document.activeElement === el) };
      record(`c3-${label}-inspection-${close}`, inspected === original && after.draft === 'newer unsent draft'
        && after.focusRestored && after.sends === before.sends && after.status === before.status
        && JSON.stringify(after.queue) === JSON.stringify(before.queue), { original, inspected, before, after });
    }
    const recoveryBounds = await probe('.th-send-restore').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { rect: rect.toJSON(), inRow: !!el.closest('.th-chat-controls'), hit: el === at || el.contains(at),
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
    });
    await transition(page, `() => !document.querySelector('${selector}') && document.querySelector('textarea').value === ${JSON.stringify(original)} && document.activeElement === document.querySelector('textarea')`,
      () => probe('.th-send-restore').click());
    const recovered = { text: await textarea.inputValue(), sends: sendFrames().length, bounds: recoveryBounds,
      focus: await textarea.evaluate(el => document.activeElement === el) };
    record(`c3-${label}-recovery`, recovered.text === original && recovered.focus && recovered.sends === before.sends
      && recoveryBounds.inRow && recoveryBounds.hit && recoveryBounds.inViewport, recovered);
    await shot(page, `c3-${label}-recovered.png`);
    // Deliberate resubmit is the next and only send: prove restored text really
    // traverses the public transport, rather than only changing the DOM.
    const resubmitted = fixture.wait('frame', f => f.type === 'chat.send' && f.run?.message === original);
    await transition(page, "() => document.querySelector('textarea').value === '' && !!document.querySelector('.th-chat-send-status[data-send-phase=sending]')",
      () => page.locator('.th-chat-send-btn').click());
    const resend = await resubmitted;
    record(`c3-${label}-resubmit`, sendFrames().length === before.sends + 1 && resend.requestId !== request.requestId && resend.run.message === original, { resend, frames: sendFrames() });
    if (keyboardHeight) {
      await textarea.focus();
      await transition(page, `() => document.documentElement.hasAttribute('data-th-keyboard-open') && visualViewport.height === ${keyboardHeight}`,
        () => page.setViewportSize({ width, height: keyboardHeight }));
      const short = await page.evaluate(rowGeometry);
      record(`c3-${label}-keyboard-fixed-band`, short.row.top >= 0 && short.row.bottom <= keyboardHeight
        && short.capsule.top >= 0 && short.capsule.bottom <= keyboardHeight && within(short.trigger.right, short.capsule.right), short);
      const held = { ...await page.evaluate(viewportState), keyboardOpen: true };
      assert.equal(held.vv.height, keyboardHeight);
      await shot(page, `c3-${label}-keyboard-row.png`);
      const afterCapture = await page.evaluate(viewportState);
      assertViewportHeld(afterCapture, held);
      record(`c3-${label}-keyboard-capture-held`, true, { held, afterCapture });
    }
    record(`c3-${label}-runtime`, q.errors.length === 0 && fixture.unexpected.length === 0, { errors: q.errors, unexpected: fixture.unexpected });
  } catch (error) {
    failures.push({ id: `c3-${label}-threw`, actual: String(error?.stack ?? error) });
    await shot(page, `c3-${label}-failure.png`);
  } finally {
    cleanup.push({ label, ...await q.close() });
    await save(`c3-${label}-events.json`, fixture.traffic);
  }
}

/** C4: safe visual-viewport sheet and real close control. */
async function c4Scenario(browser, { width, height, insets, keyboard, pan, keyboardHeight, tight, label }) {
  if (!selected(label)) return;
  const q = await setupComposer(browser, { viewport: { width, height }, coarse: true, mobile: !pan, theme });
  const { page, fixture } = q;
  const step = async (name, predicate, action) => {
    try { await transition(page, predicate, action); }
    catch (error) { throw new Error(`[${name}] ${error.message}`); }
  };
  try {
    const session = await page.context().newCDPSession(page);
    const safe = insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    await save(`c4-${label}-startup.json`, { url: fixture.url, viewport: { width, height }, insets: safe,
      mobile: !pan, coarse: true,
      emulation: 'Chrome CDP safe-area, coherent Playwright resize, desktop-renderer page scale and native pre-pan; not physical-device evidence' });
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: safe });
    const read = () => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      return { sheet: rect('.th-model-picker-popover--sheet'),
        close: rect('.th-model-picker-popover--sheet .th-model-picker-current .th-btn-icon'),
        header: rect('.th-model-picker-current'), list: rect('.th-model-picker-list'),
        vv: { top: visualViewport.offsetTop, left: visualViewport.offsetLeft,
          width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
        css: { top: document.documentElement.style.getPropertyValue('--th-vv-top'),
          left: document.documentElement.style.getPropertyValue('--th-vv-left') },
        layout: { width: innerWidth, height: innerHeight },
        keyboardOpen: document.documentElement.hasAttribute('data-th-keyboard-open') };
    };
    if (pan) {
      // Focus the trigger through UI before zooming, then pan the non-scroll
      // app header while the chooser is CLOSED. Inside-sheet gestures scroll
      // choices; outside-sheet gestures correctly dismiss an open chooser.
      await step('focus-trigger-open', "() => !!document.querySelector('.th-model-picker-popover--sheet')",
        () => page.locator('.th-model-picker-btn').click());
      const prePan = await page.evaluate(read), preBounds = safeBounds(prePan.vv, safe);
      record(`c4-${label}-pre-pan-safe-bounds`, fits(prePan.sheet, preBounds) && fits(prePan.close, preBounds)
        && prePan.close.width >= 44 && prePan.close.height >= 44, { prePan, preBounds });
      await step('focus-trigger-close', "() => !document.querySelector('.th-model-picker-popover--sheet') && document.activeElement.matches('.th-model-picker-btn')",
        () => page.keyboard.press('Escape'));
      await step('zoom', '() => visualViewport.scale === 2',
        () => session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 }));
      await step('native-prepan', '() => visualViewport.offsetTop > 0 && visualViewport.offsetLeft > 0',
        () => session.send('Input.synthesizeScrollGesture', { x: 120, y: 20,
          xDistance: -63, yDistance: -63, speed: 4000, gestureSourceType: 'touch' }));
      record(`c4-${label}-native-prepan`, true, await page.evaluate(viewportState));
    }
    await step("open-sheet", "() => !!document.querySelector('.th-model-picker-popover--sheet')",
      () => pan ? page.keyboard.press('Enter') : page.locator('.th-model-picker-btn').click());
    record(`c4-${label}-theme`, await page.evaluate(() => document.documentElement.dataset.theme) === theme, { theme });
    if (pan) {
      const opened = await page.evaluate(read);
      assertViewportHeld(opened, { ...opened, pan: true });
      record(`c4-${label}-open-retains-pan`, true, opened);
    }
    await page.locator('.th-model-picker-search').fill('model');
    if (pan) {
      const searched = await page.evaluate(read);
      assertViewportHeld(searched, { ...searched, pan: true });
      record(`c4-${label}-search-retains-pan`, true, searched);
    }
    if (keyboard) {
      // Landscape must shrink by >100px too; the previous 390 -> 300 scenario
      // never entered the public keyboard-open state.
      const shrink = keyboardHeight ?? (height > 500 ? height - 300 : height - 160);
      await transition(page, `() => document.documentElement.hasAttribute('data-th-keyboard-open') && Math.abs(visualViewport.height - ${shrink}) < 1`,
        () => page.setViewportSize({ width, height: shrink }));
    }
    if (tight) {
      // Over-constrained height: the fixed chrome (thinking, search) can
      // exceed the measured sheet bound. The pinned header and close must
      // stay bounded and genuinely hit-testable, the search must scroll into
      // view within the sheet, and the list must keep a usable scrollport —
      // a bounded rectangle with hidden or unreachable content is a failure,
      // not a pass.
      // Mobile input is touch: swipe up over the fixed chrome region to
      // scroll the sheet (the search/keyboard state keeps focus untouched).
      const sheetBox = await page.locator('.th-model-picker-popover--sheet').boundingBox();
      const sheetScroll = await nativeScroll(page, session, '.th-model-picker-popover--sheet',
        { x: sheetBox.x + sheetBox.width / 2, y: sheetBox.y + 60,
          xDistance: 0, yDistance: -260, speed: 4000, gestureSourceType: 'touch' });
      record(`c4-${label}-sheet-native-scroll`, sheetScroll.scrollTop > 0, sheetScroll);
      const exposed = await page.evaluate(() => {
        const sheet = document.querySelector('.th-model-picker-popover--sheet').getBoundingClientRect();
        const search = document.querySelector('.th-model-picker-search').getBoundingClientRect();
        const hit = document.elementFromPoint(search.x + search.width / 2,
          Math.min(Math.max(search.y + search.height / 2, sheet.top + 1), sheet.bottom - 1));
        const searchEl = document.querySelector('.th-model-picker-search');
        return { sheet: sheet.toJSON(), search: search.toJSON(),
          complete: search.top >= sheet.top + 1 && search.bottom <= sheet.bottom - 1,
          hit: hit === searchEl || searchEl.contains(hit) };
      });
      record(`c4-${label}-search-reachable`, exposed.complete && exposed.hit, exposed);
      const listZone = await page.locator('.th-model-picker-popover--sheet').boundingBox();
      const listScroll = await nativeScroll(page, session, '.th-model-picker-list',
        { x: listZone.x + listZone.width / 2, y: listZone.y + listZone.height - 15,
          xDistance: 0, yDistance: -3000, speed: 4000, gestureSourceType: 'touch' });
      record(`c4-${label}-list-native-scroll`, listScroll.scrollTop > 0, listScroll);
      const listRead = await page.evaluate(() => {
        const sheet = document.querySelector('.th-model-picker-popover--sheet').getBoundingClientRect();
        const list = document.querySelector('.th-model-picker-list');
        const listRect = list.getBoundingClientRect();
        const options = [...list.querySelectorAll('[role=option]')];
        // A touch-targetable option shows at least a 20px visible band at the
        // scroll edge and owns the point that a real finger would land on.
        const targetable = options.filter(element => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          const visible = Math.min(rect.bottom, sheet.bottom, listRect.bottom) - Math.max(rect.top, listRect.top, sheet.top);
          return visible >= 20 && (hit === element || element.contains(hit));
        });
        return { list: listRect.toJSON(), scrollable: list.scrollHeight > list.clientHeight,
          viewport: list.clientHeight, scrollTop: list.scrollTop, targetable: targetable.length };
      });
      record(`c4-${label}-list-scrollport`, listRead.scrollable && listRead.viewport >= 44
        && listRead.scrollTop > 0 && listRead.targetable >= 1, listRead);
    }
    // Exercise a real resize/clamp update while the panned sheet is open.
    // Keep width fixed so the public keyboard baseline is not reset.
    if (pan) {
      await step('open-pan-resize', `() => visualViewport.height === ${(height - 40) / 2} && visualViewport.offsetTop > 0 && visualViewport.offsetLeft > 0`,
        () => page.setViewportSize({ width, height: height - 40 }));
    }
    const expected = { ...await page.evaluate(viewportState), pan: !!pan, keyboardOpen: !!keyboard };
    if (keyboard) assert.equal(expected.vv.height, keyboardHeight ?? (height > 500 ? height - 300 : height - 160));
    if (pan) assert.equal(expected.vv.scale, 2);
    await page.evaluate(() => {
      const sample = () => window.qaViewportSamples.push({ vv: { top: visualViewport.offsetTop, left: visualViewport.offsetLeft,
        width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
        layout: { width: innerWidth, height: innerHeight },
        keyboardOpen: document.documentElement.hasAttribute('data-th-keyboard-open') });
      window.qaViewportSamples = [];
      visualViewport.addEventListener('resize', sample);
      visualViewport.addEventListener('scroll', sample);
      new MutationObserver(sample).observe(document.documentElement, { attributes: true, attributeFilter: ['data-th-keyboard-open'] });
      sample();
      // Context destruction owns these scenario-long subscriptions.
    });
    const heldEvents = async () => {
      const samples = await page.evaluate(() => window.qaViewportSamples);
      await save(`c4-${label}-viewport-events.json`, { expected, samples });
      for (const sample of samples) assertViewportHeld(sample, expected);
      return samples;
    };
    const checkpoint = async name => {
      const actual = await page.evaluate(read);
      await save(`c4-${label}-${name}.json`, { expected, actual, cached: page.viewportSize() });
      assertViewportHeld(actual, expected);
      await heldEvents();
      assert.deepEqual(page.viewportSize(), expected.layout, 'Playwright cached viewport disagrees with browser');
      const bounds = safeBounds(actual.vv, safe);
      record(`c4-${label}-${name}-held`, fits(actual.sheet, bounds) && fits(actual.close, bounds)
        && actual.close.width >= 44 && actual.close.height >= 44, { expected, actual, bounds });
      return actual;
    };
    await checkpoint('before-capture');
    const readout = await page.evaluate(read);
    const bounds = safeBounds(readout.vv, safe);
    await shot(page, `c4-${label}-sheet.png`);
    await checkpoint('after-capture');
    // At every scale and offset, the complete sheet and 44px close header
    // must fit all four sides of the safe visual rectangle.
    record(`c4-${label}-safe-bounds`, fits(readout.close, bounds) && fits(readout.sheet, bounds)
      && readout.close.width >= 44 && readout.close.height >= 44, { safe, bounds, readout });
    if (pan) {
      // Native pan must retain both containment and the pinned header.
      const pinned = readout.close.left >= readout.header.left - 0.5
        && readout.close.right <= readout.header.right + 0.5
        && readout.close.top >= readout.header.top - 0.5
        && readout.close.bottom <= readout.header.bottom + 0.5;
      record(`c4-${label}-zoom-tracked`, pinned && readout.css.top !== '' && readout.css.left !== ''
        && readout.sheet.top >= readout.vv.top
        && readout.sheet.top < readout.vv.top + readout.vv.height,
        { readout, pinned });
    }
    // Native keyboard navigation to the last matching choice scrolls the real
    // list. The header/close must remain pinned while choices move beneath it.
    assert.equal(await page.locator('.th-model-picker-search').evaluate(el => document.activeElement === el), true);
    await transition(page, "() => document.querySelector('.th-model-picker-list').scrollTop > 0 && document.querySelector('.th-model-picker-list [role=option]:last-child').hasAttribute('data-active')",
      () => page.keyboard.press('ArrowUp'));
    const scrolled = await checkpoint('after-navigation');
    record(`c4-${label}-pinned-header`, within(readout.header.top, scrolled.header.top)
      && within(readout.close.top, scrolled.close.top), { before: readout, after: scrolled });
    await shot(page, `c4-${label}-navigated.png`);
    await checkpoint('after-navigation-capture');
    const pointer = await nativeClosePoint(page, session, safe);
    await save(`c4-${label}-native-calibration.json`, pointer);
    await checkpoint('immediately-before-close');
    const native = [];
    await transition(page, "() => !document.querySelector('.th-model-picker-popover--sheet') && document.activeElement?.classList.contains('th-model-picker-btn')", async () => {
      const down = await nativeMouse(page, session, 'mousePressed', pointer.point);
      native.push(down);
      assert.ok(down.close, 'trusted press must target visible close');
      assertViewportHeld(down, expected);
      const up = await nativeMouse(page, session, 'mouseReleased', pointer.point);
      native.push(up);
      assert.ok(up.close, 'trusted release must target visible close');
      assertViewportHeld(up, expected);
    });
    const afterClose = await page.evaluate(() => ({ closed: !document.querySelector('.th-model-picker-popover--sheet'),
      focusIsTrigger: document.activeElement?.classList.contains('th-model-picker-btn') === true }));
    const closedViewport = await page.evaluate(viewportState);
    assertViewportHeld(closedViewport, expected);
    await heldEvents();
    record(`c4-${label}-close-restores`, pointer.moved.close && afterClose.closed && afterClose.focusIsTrigger,
      { pointer, native, ...afterClose, closedViewport });
    record(`c4-${label}-runtime`, q.errors.length === 0 && fixture.unexpected.length === 0,
      { errors: q.errors, unexpected: fixture.unexpected });
    await session.detach();
  } catch (error) {
    failures.push({ id: `c4-${label}-threw`, actual: String(error?.stack ?? error) });
    await shot(page, `c4-${label}-failure.png`);
  } finally {
    // Context destruction also removes all CDP emulation; no fallback swallows errors.
    cleanup.push({ label, ...await q.close() });
    await save(`c4-${label}-events.json`, fixture.traffic);
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await save('browser.json', { version: browser.version(), channel: 'chrome', driver: process.env.QA_PLAYWRIGHT });
  if (phase === "all" || phase === "c3") {
    await c3Scenario(browser, { width: 1280, height: 800, coarse: false, label: "desktop-1280" });
    await c3Scenario(browser, { width: 390, height: 844, coarse: true, label: "mobile-390" });
    await c3Scenario(browser, { width: 844, height: 390, coarse: true, label: "landscape-844" });
    await c3Scenario(browser, { width: 1280, height: 800, coarse: false, paneWidth: 600, label: "pane-600" });
    await c3Scenario(browser, { width: 1280, height: 800, coarse: false, paneWidth: 340, label: "pane-340" });
    await c3Scenario(browser, { width: 844, height: 270, coarse: false, label: "landscape-270",
      shortViewport: true, keyboardHeight: 150 });
  }
  if (phase === "all" || phase === "c4") {
    await c4Scenario(browser, { width: 390, height: 844, label: "portrait-zero-insets" });
    await c4Scenario(browser, { width: 844, height: 390, label: "landscape-zero-insets" });
    await c4Scenario(browser, { width: 390, height: 844,
      insets: { top: 59, right: 0, bottom: 34, left: 0 }, label: "portrait-insets" });
    await c4Scenario(browser, { width: 844, height: 390,
      insets: { top: 0, right: 47, bottom: 0, left: 47 }, label: "landscape-insets" });
    await c4Scenario(browser, { width: 390, height: 844, keyboard: true,
      insets: { top: 59, right: 0, bottom: 34, left: 0 }, label: "portrait-insets-keyboard" });
    await c4Scenario(browser, { width: 844, height: 390, keyboard: true,
      insets: { top: 0, right: 47, bottom: 0, left: 47 }, label: "landscape-insets-keyboard" });
    await c4Scenario(browser, { width: 390, height: 844, pan: true,
      insets: { top: 59, right: 47, bottom: 34, left: 47 }, label: "portrait-insets-pan" });
    await c4Scenario(browser, { width: 844, height: 390, keyboard: true, keyboardHeight: 150, tight: true,
      insets: { top: 0, right: 47, bottom: 0, left: 47 }, label: "landscape-tight-keyboard" });
  }
} finally {
  await browser.close();
  await save("ui-composer-cleanup.json", { browserClosed: true, scenarios: cleanup });
  const afterBinding = binding();
  await save('run-binding-after.json', afterBinding);
  record('run-binding-stable', JSON.stringify(beforeBinding) === JSON.stringify(afterBinding), { before: beforeBinding, after: afterBinding });
}
record('scenario-selection', executed > 0 && (!requested || requested.length === executed), { requested, executed });
await save("ui-composer-results.json", { phase, theme, scope: requested ? 'focused probe; not full acceptance' : 'matrix', results, failures, cleanup });
console.log(`ui-composer-polish phase=${phase} pass=${results.filter(r => r.pass).length} fail=${failures.length}`);
for (const failure of failures) console.log(`FAIL ${failure.id}: ${JSON.stringify(failure.actual).slice(0, 400)}`);
if (failures.length) process.exitCode = 1;
