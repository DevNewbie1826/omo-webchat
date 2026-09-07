/** Composer-only setup: explicit public HTTP/WS state, never automatic send ACKs. */
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
      hasTouch: options.coarse ?? false, isMobile: options.mobile ?? options.coarse ?? false, colorScheme: 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page);
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
