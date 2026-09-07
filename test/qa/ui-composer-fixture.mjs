/** Composer-only setup: explicit public HTTP/WS state, never automatic send ACKs. */
import assert from 'node:assert/strict';
import { startFixture } from './pane-workspace-ui.mjs';
import { designSeed, installSignals, arm, complete, seedLive } from './design-workbench-fixture.mjs';

export function startComposerFixture(options = {}) {
  return startFixture({ ...designSeed('single'), ...options, controlled: true, port: 0 });
}

/** Register the exact DOM predicate before the action and await its completion. */
export async function transition(page, predicate, action) {
  await arm(page, predicate);
  // Start awaiting in the browser before the action too, so a failed action
  // cannot leave an unhandled page-side deadline rejection.
  await Promise.all([complete(page), action()]);
}

export async function setupComposer(browser, options = {}) {
  const fixture = startComposerFixture({ layout: options.paneWidth ? 'two' : 'single' });
  let context;
  try {
    context = await browser.newContext({ viewport: options.viewport,
      hasTouch: options.coarse ?? false, isMobile: options.mobile ?? options.coarse ?? false, colorScheme: options.theme ?? 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page, { theme: options.theme ?? 'dark' });
    const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url);
    await attached;
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-queue-header')
      && document.querySelector('.th-activity-bar') && document.querySelector('.th-goal-bar')
      && document.querySelector('[data-tool-call-id="design-failed"]')
      && [...document.querySelectorAll('.th-chat-status-num')].some(n => n.textContent === '42%')));
    await seedLive(page, fixture);
    if (options.paneWidth) {
      const divider = await page.locator('.th-divider').boundingBox();
      const split = await page.locator('.th-split').boundingBox();
      const ratio = options.paneWidth / (split.width - divider.width);
      const persisted = fixture.wait('layout', layout => layout.kind === 'split' && Math.abs(layout.ratio - ratio) < 0.002);
      await transition(page, `() => Math.abs(document.querySelector('[data-pane-id="a"]').getBoundingClientRect().width - ${options.paneWidth}) < 1`, async () => {
        await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
        await page.mouse.down();
        await page.mouse.move(split.x + options.paneWidth + divider.width / 2, divider.y + divider.height / 2);
        await page.mouse.up();
      });
      await persisted;
    }
    return { page, context, fixture, errors, async close() {
      await context.close();
      return { contextClosed: true, url: fixture.url, ...await fixture.stop() };
    } };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Composer setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

/** Layout-coordinate safe rectangle for getBoundingClientRect/elementFromPoint. */
export function safeBounds(viewport, insets) {
  return { top: viewport.top + insets.top, left: viewport.left + insets.left,
    right: viewport.left + viewport.width - insets.right,
    bottom: viewport.top + viewport.height - insets.bottom };
}

export function fits(rect, bounds) {
  return !!rect && rect.top >= bounds.top - 0.5 && rect.left >= bounds.left - 0.5
    && rect.right <= bounds.right + 0.5 && rect.bottom <= bounds.bottom + 0.5;
}

/** Read browser-owned geometry only. Never write viewport objects or product CSS. */
export function viewportState() {
  return { vv: { top: visualViewport.offsetTop, left: visualViewport.offsetLeft,
    width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
    layout: { width: innerWidth, height: innerHeight },
    keyboardOpen: document.documentElement.hasAttribute('data-th-keyboard-open') };
}

/** Reject restored metrics, a lost keyboard marker, or zero-offset zoom. */
export function assertViewportHeld(actual, expected) {
  for (const key of ['width', 'height', 'scale']) {
    assert.ok(Math.abs(actual.vv[key] - expected.vv[key]) < 0.5,
      `visualViewport ${key} restored/changed: ${JSON.stringify({ actual, expected })}`);
  }
  assert.deepEqual(actual.layout, expected.layout, 'layout viewport restored/changed');
  assert.equal(actual.keyboardOpen, expected.keyboardOpen, 'keyboard marker restored/changed');
  if (expected.pan) assert.ok(actual.vv.left > 0 && actual.vv.top > 0,
    `nonzero X/Y pan required: ${JSON.stringify(actual.vv)}`);
}

/** Fail before sending input: the complete target must be safely visible. */
export function assertNativeTarget(rect, viewport, insets, hit) {
  assert.ok(fits(rect, safeBounds(viewport, insets)), 'native target is outside safe visual bounds');
  assert.ok(rect.width >= 44 && rect.height >= 44, 'native target must be at least 44x44');
  assert.ok(hit, 'native target does not own its center');
}

/** Subscribe before each native event; capture its actual target/client point.
 * Calibration probes use the outer 1..9px band, never activation.
 */
export async function nativeMouse(page, session, type, point) {
  const eventName = { mouseMoved: 'mousemove', mousePressed: 'mousedown', mouseReleased: 'mouseup' }[type];
  await page.evaluate(eventName => {
    window.qaNativePending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { document.removeEventListener(eventName, observed, true); reject(new Error(`Native ${eventName} deadline`)); }, 8000);
      function observed(event) {
        clearTimeout(timer); document.removeEventListener(eventName, observed, true);
        resolve({ trusted: event.isTrusted, x: event.clientX, y: event.clientY,
          target: event.target instanceof Element ? event.target.outerHTML : null,
          close: event.target instanceof Element && !!event.target.closest('.th-model-picker-current .th-btn-icon'),
          vv: { left: visualViewport.offsetLeft, top: visualViewport.offsetTop,
            width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
          layout: { width: innerWidth, height: innerHeight },
          keyboardOpen: document.documentElement.hasAttribute('data-th-keyboard-open') });
      }
      document.addEventListener(eventName, observed, true);
    });
  }, eventName);
  const [observed] = await Promise.all([page.evaluate(() => window.qaNativePending),
    session.send('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })]);
  assert.ok(observed.trusted, 'input must be trusted');
  return observed;
}

/** Infer CDP->client projection from two real native events, not scale guesses. */
export async function nativeClosePoint(page, session, insets) {
  const first = await nativeMouse(page, session, 'mouseMoved', { x: 1, y: 1 });
  const second = await nativeMouse(page, session, 'mouseMoved', { x: 9, y: 9 });
  const sx = (second.x - first.x) / 8, sy = (second.y - first.y) / 8;
  assert.ok(sx > 0 && sy > 0, 'native coordinate calibration must be invertible');
  const target = await page.locator('.th-model-picker-current .th-btn-icon').evaluate(close => {
    const rect = close.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const at = document.elementFromPoint(x, y);
    return { rect: rect.toJSON(), x, y, hit: close === at || close.contains(at),
      vv: { left: visualViewport.offsetLeft, top: visualViewport.offsetTop, width: visualViewport.width, height: visualViewport.height } };
  });
  assertNativeTarget(target.rect, target.vv, insets, target.hit);
  const point = { x: 1 + (target.x - first.x) / sx, y: 1 + (target.y - first.y) / sy };
  const moved = await nativeMouse(page, session, 'mouseMoved', point);
  assert.ok(moved.close && Math.abs(moved.x - target.x) < 1 && Math.abs(moved.y - target.y) < 1,
    `native event missed close: ${JSON.stringify({ point, target, moved })}`);
  return { point, target, calibration: { first, second, sx, sy }, moved };
}

/** Exactly one native buffer. No Playwright screenshot viewport reconciliation. */
export async function nativeCapture(session) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  return Buffer.from(data, 'base64');
}

/** Gesture completion means the exact scroll owner emitted scroll + scrollend. */
export async function nativeScroll(page, session, selector, gesture) {
  await page.locator(selector).evaluate(element => {
    window.qaScrollPending = new Promise((resolve, reject) => {
      let scrolled = false;
      const cleanup = () => { clearTimeout(timer); element.removeEventListener('scroll', changed); element.removeEventListener('scrollend', ended); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native scroll owner deadline')); }, 8000);
      function changed(event) { if (event.target === element) scrolled = true; }
      function ended(event) {
        if (!scrolled || event.target !== element) return;
        cleanup(); resolve({ trusted: event.isTrusted, scrollTop: element.scrollTop, clientHeight: element.clientHeight });
      }
      element.addEventListener('scroll', changed);
      element.addEventListener('scrollend', ended);
    });
  });
  const [event] = await Promise.all([page.evaluate(() => window.qaScrollPending),
    session.send('Input.synthesizeScrollGesture', gesture)]);
  assert.ok(event.trusted, 'scroll completion must be native');
  return event;
}
