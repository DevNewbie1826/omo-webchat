import assert from 'node:assert/strict';
import { models } from './pane-workspace-ui.mjs';

/** Same passive qa:wire hook as the existing model-control fixture. */
export async function installControlSignals(page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      set onmessage(handler) {
        super.onmessage = handler ? event => {
          handler.call(this, event);
          window.dispatchEvent(new CustomEvent('qa:wire', { detail: JSON.parse(event.data) }));
        } : null;
      }
    };
  });
}

/** Observe the App's received payload, not the fixture or routing proxy's upstream result. */
export async function confirmControl(page, fixture, intended, action, { timeout = 8000 } = {}) {
  await page.evaluate(timeout => {
    window.qaControlResult = new Promise(resolve => {
      const timer = setTimeout(() => { cleanup(); resolve({ missing: true }); }, timeout);
      function cleanup() { clearTimeout(timer); window.removeEventListener('qa:wire', received); }
      function received({ detail: frame }) {
        if (!['control.result', 'error'].includes(frame.type)) return;
        cleanup(); resolve(frame);
      }
      window.qaControlCleanup = cleanup;
      window.addEventListener('qa:wire', received);
    });
  }, timeout);
  try {
    const requested = fixture.wait('frame', f => f.type === 'chat.set');
    const [request, result] = await Promise.all([requested, page.evaluate(() => window.qaControlResult), action()]);
    assert.equal(request.sessionId, 'stored-a');
    assert.equal(typeof request.requestId, 'string'); assert(request.requestId.length > 0);
    if (intended.model) assert.deepEqual(request.model, intended.model);
    else assert.equal(request.thinkingLevel, intended.thinkingLevel);
    assert.equal(result.type, 'control.result', `Missing control.result: ${JSON.stringify(result)}`);
    assert.equal(result.sessionId, request.sessionId);
    assert.equal(result.requestId, request.requestId);
    assert.equal(result.command, intended.model ? 'set_model' : 'set_thinking_level');
    assert.equal(result.success, true);
    const selector = intended.model ? '.th-model-picker-label' : '.th-model-picker-thinking';
    const expected = intended.model ? models.find(m => m.provider === intended.model.provider && m.modelId === intended.model.modelId).name : intended.thinkingLevel;
    await page.evaluate(({ selector, expected }) => window.qaSignal(() => document.querySelector(selector)?.textContent === expected), { selector, expected });
    const final = await page.locator(selector).textContent();
    assert.equal(final, expected);
    return { request, result, final };
  } finally {
    await page.evaluate(() => { window.qaControlCleanup(); delete window.qaControlCleanup; delete window.qaControlResult; });
  }
}
