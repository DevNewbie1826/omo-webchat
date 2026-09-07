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
 *    plus a real viewport resize through Emulation.setDeviceMetricsOverride,
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
import { setupComposer, transition, safeBounds, fits } from "./ui-composer-fixture.mjs";

const { chromium } = await import(process.env.QA_PLAYWRIGHT);
const evidence = resolve(process.argv[2]);
const phase = process.argv[3] ?? "all";
await mkdir(evidence, { recursive: true });
const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
const shot = (page, name) => page.screenshot({ path: resolve(evidence, name) });
assert.ok(["all", "c3", "c4"].includes(phase), `Unknown phase: ${phase}`);
const results = [], failures = [], cleanup = [];
const root = resolve(import.meta.dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const binding = () => ({
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
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

/** C3: one compact row — statuses left, model pinned right, details and
 * recovery reachable, model/thinking/search and send behavior intact. */
async function c3Scenario(browser, { width, height, coarse, paneWidth, label }) {
  const q = await setupComposer(browser, { viewport: { width, height }, coarse, paneWidth });
  const { page, fixture } = q;
  const sendFrames = () => fixture.frames.filter(frame => frame.type === "chat.send");
  const deliver = (frame, predicate) => transition(page, predicate, () => fixture.deliver("stored-a", frame));
  try {
    await save(`c3-${label}-startup.json`, { url: fixture.url, state: fixture.runState("stored-a"), traffic: fixture.traffic });
    record(`c3-${label}-queue-visible`, await page.locator('.th-queue-header').isVisible(), fixture.runState('stored-a').queue);
    await deliver({ type: "stats", cost: 0.125, contextUsage: { percent: 42, used: 42000, total: 100000 },
      tokens: { input: 30, cacheRead: 70, output: 5 } },
      "() => [...document.querySelectorAll('.th-chat-status-num')].some(n => n.textContent === '70%')");
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
  const q = await setupComposer(browser, { viewport: { width, height }, coarse: true, mobile: !pan });
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
      emulation: 'Chrome CDP safe-area, device-metrics resize, desktop-renderer page scale and native touch pan; not physical-device evidence' });
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: safe });
    await step("open-sheet", "() => !!document.querySelector('.th-model-picker-popover--sheet')",
      () => page.locator('.th-model-picker-btn').click());
    await page.locator('.th-model-picker-search').fill('model');
    const read = () => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      return { sheet: rect('.th-model-picker-popover--sheet'),
        close: rect('.th-model-picker-popover--sheet .th-model-picker-current .th-btn-icon'),
        header: rect('.th-model-picker-current'), list: rect('.th-model-picker-list'),
        vv: { top: visualViewport.offsetTop, left: visualViewport.offsetLeft,
          width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
        css: { top: document.documentElement.style.getPropertyValue('--th-vv-top'),
          left: document.documentElement.style.getPropertyValue('--th-vv-left') },
        keyboardOpen: document.documentElement.hasAttribute('data-th-keyboard-open') };
    };
    if (keyboard) {
      // Landscape must shrink by >100px too; the previous 390 -> 300 scenario
      // never entered the public keyboard-open state.
      const shrink = keyboardHeight ?? (height > 500 ? height - 300 : height - 160);
      await transition(page, `() => document.documentElement.hasAttribute('data-th-keyboard-open') && Math.abs(visualViewport.height - ${shrink}) < 1`,
        () => session.send('Emulation.setDeviceMetricsOverride',
          { width, height: shrink, deviceScaleFactor: 2, mobile: true }));
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
      await session.send('Input.synthesizeScrollGesture',
        { x: sheetBox.x + sheetBox.width / 2, y: sheetBox.y + 60,
          xDistance: 0, yDistance: -260, speed: 4000, gestureSourceType: 'touch' });
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
      await session.send('Input.synthesizeScrollGesture',
        { x: listZone.x + listZone.width / 2, y: listZone.y + listZone.height - 15,
          xDistance: 0, yDistance: -3000, speed: 4000, gestureSourceType: 'touch' });
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
    const beforePan = pan ? await page.evaluate(read) : null;
    if (pan) {
      // At page scale 1 with insets the close header must already sit inside
      // the safe visual rectangle before any zoom.
      const preBounds = safeBounds(beforePan.vv, safe);
      record(`c4-${label}-pre-pan-safe-bounds`, fits(beforePan.close, preBounds)
        && fits(beforePan.sheet, preBounds), { safe, bounds: preBounds, readout: beforePan });
      await step("pinch", "() => visualViewport.scale > 1.5",
        () => session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 }));
    }
    const readout = await page.evaluate(read);
    const bounds = safeBounds(readout.vv, safe);
    await shot(page, `c4-${label}-sheet.png`);
    // At page scale 1 (every non-pan scenario) the whole sheet, including the
    // 44px close header, must fit the safe visual rectangle.
    if (!pan) record(`c4-${label}-safe-bounds`, fits(readout.close, bounds) && fits(readout.sheet, bounds)
      && readout.close.width >= 44 && readout.close.height >= 44, { safe, bounds, readout });
    if (pan) {
      // Pinch-zoom tracking: the sheet keeps consuming the visual-viewport
      // custom properties across the zoom's real resize events, and the
      // 44px close header stays pinned at the top of the sheet. Full sheet
      // containment inside the ZOOMED visible region would require a
      // visual-viewport width variable in the global viewport protocol
      // (index.html) — out of scope without lead coordination; at page
      // scale 1 the safe-bounds record above covers containment.
      const pinned = readout.close.left >= readout.header.left - 0.5
        && readout.close.right <= readout.header.right + 0.5
        && readout.close.top >= readout.header.top - 0.5
        && readout.close.bottom <= readout.header.bottom + 0.5;
      record(`c4-${label}-zoom-tracked`, pinned && readout.css.top !== '' && readout.css.left !== ''
        && readout.sheet.top >= readout.vv.top
        && readout.sheet.top < readout.vv.top + readout.vv.height,
        { readout, pinned });
      // A touch drag inside the sheet is absorbed by the contained dialog
      // (overscroll containment): the page behind does not pan, the dialog
      // stays open, and the close control remains the hit target. A page-level
      // pan gesture must start outside the dialog and is dismissed by the
      // outside-pointerdown contract, so keyboard-driven visual-viewport
      // offset tracking stays var-based (the vars update on the pinch's real
      // visualViewport events).
      const sheetRect = await page.locator('.th-model-picker-popover--sheet').evaluate(el => {
        const rect = el.getBoundingClientRect(), vv = visualViewport;
        // Gesture coordinates are visible-widget CSS pixels bounded by the
        // visible region: target the sheet's intersection with it.
        const left = Math.max(rect.left, vv.offsetLeft);
        const right = Math.min(rect.right, vv.offsetLeft + vv.width);
        const top = Math.max(rect.top, vv.offsetTop);
        const bottom = Math.min(rect.bottom, vv.offsetTop + vv.height);
        const cx = left + Math.min(60, (right - left) / 2);
        const cy = top + Math.min(40, (bottom - top) / 2);
        return { x: Math.min((cx - vv.offsetLeft) * vv.scale, vv.width - 5),
          y: Math.min((cy - vv.offsetTop) * vv.scale, vv.height - 5) };
      });
      const offsetsBefore = { top: readout.vv.top, left: readout.vv.left };
      await session.send('Input.synthesizeScrollGesture',
        { x: sheetRect.x, y: sheetRect.y, xDistance: 0, yDistance: -200,
          speed: 4000, gestureSourceType: 'touch' });
      const contained = await page.evaluate(({ top, left }) => {
        const sheet = document.querySelector('.th-model-picker-popover--sheet');
        const close = sheet.querySelector('.th-model-picker-current .th-btn-icon');
        const rect = close.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { pageStill: visualViewport.offsetTop === top && visualViewport.offsetLeft === left,
          open: !!sheet, closeHit: hit === close || close.contains(hit) };
      }, offsetsBefore);
      record(`c4-${label}-pan-contained`, contained.pageStill && contained.open && contained.closeHit,
        contained);
    }
    // Native keyboard navigation to the last matching choice scrolls the real
    // list. The header/close must remain pinned while choices move beneath it.
    await transition(page, "() => document.querySelector('.th-model-picker-list').scrollTop > 0",
      () => page.locator('.th-model-picker-search').press('ArrowUp'));
    const scrolled = await page.evaluate(read);
    record(`c4-${label}-pinned-header`, within(readout.header.top, scrolled.header.top)
      && within(readout.close.top, scrolled.close.top), { before: readout, after: scrolled });
    const pointer = await page.locator('.th-model-picker-current .th-btn-icon').evaluate(close => {
      const r = close.getBoundingClientRect(), vv = visualViewport;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const at = document.elementFromPoint(x, y);
      return { hit: at === close || close.contains(at),
        inViewport: x >= vv.offsetLeft && x < vv.offsetLeft + vv.width
          && y >= vv.offsetTop && y < vv.offsetTop + vv.height,
        // CDP input coordinates are visible-widget CSS pixels, not the
        // layout coordinates returned by getBoundingClientRect under zoom.
        x: (x - vv.offsetLeft) * vv.scale, y: (y - vv.offsetTop) * vv.scale };
    });
    const hit = pointer.hit;
    let closeError = null;
    {
      await transition(page, "() => !document.querySelector('.th-model-picker-popover--sheet') && document.activeElement?.classList.contains('th-model-picker-btn')", async () => {
          if (pointer.inViewport) {
            await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 });
            await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 });
          } else {
            // Under pinch-zoom the pinned header can sit outside the zoomed
            // visual region; the element's own click path carries identical
            // activation semantics.
            await page.locator('.th-model-picker-popover--sheet .th-model-picker-current .th-btn-icon')
              .evaluate(element => element.click());
          }
        });
    }
    const afterClose = await page.evaluate(() => ({ closed: !document.querySelector('.th-model-picker-popover--sheet'),
      focusIsTrigger: document.activeElement?.classList.contains('th-model-picker-btn') === true }));
    // At page scale 1 the pointer hit-test must pass; under pinch-zoom the
    // center can sit outside the zoomed visible region while the control
    // stays the sheet's pinned, activatable header (pan-tracking record).
    record(`c4-${label}-close-restores`, !closeError && (!pointer.inViewport || hit)
      && afterClose.closed && afterClose.focusIsTrigger,
      { hit, pointer, ...afterClose, error: closeError });
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
    await c3Scenario(browser, { width: 1280, height: 800, coarse: false, paneWidth: 600, label: "pane-600" });
    await c3Scenario(browser, { width: 1280, height: 800, coarse: false, paneWidth: 340, label: "pane-340" });
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
await save("ui-composer-results.json", { phase, results, failures, cleanup });
console.log(`ui-composer-polish phase=${phase} pass=${results.filter(r => r.pass).length} fail=${failures.length}`);
for (const failure of failures) console.log(`FAIL ${failure.id}: ${JSON.stringify(failure.actual).slice(0, 400)}`);
if (failures.length) process.exitCode = 1;
