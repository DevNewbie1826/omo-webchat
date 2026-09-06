/** Reusable actual-App setup. No synthetic DOM, style overrides, user server or disk state. */
import { startFixture } from './pane-workspace-ui.mjs';

export const prose = '대화의 흐름과 도구 실행 결과를 분리하면서 세션과 입력 상태를 보존합니다. ';
export const output = Array.from({ length: 70 }, (_, i) => `record ${i}: ${prose} const value = inspect(sessionId);`).join('\n');
export function designSeed(layout = 'single') {
  const messages = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `${prose.repeat(8)}\n\n\`\`\`ts\nconst session_${i} = { id: "stored-a", preserved: true };\n\`\`\`` }));
  messages.push({ role: 'assistant', content: 'Assistant continuation A.' },
    { role: 'assistant', content: 'Assistant continuation B.' },
    { role: 'user', content: '새 사용자 요청: 실행 기록을 확인하고 대화를 계속하세요.' },
    { role: 'assistant', content: [
      { type: 'text', text: prose.repeat(3) }, { type: 'text', text: '```ts\nconst preserved = session.id;\n```' },
      { type: 'toolCall', id: 'design-read', name: 'read', arguments: { path: '/fixture/session.ts' } },
      { type: 'toolCall', id: 'design-bash', name: 'bash', arguments: { command: 'npm run build' } },
      { type: 'toolCall', id: 'design-failed', name: 'bash', arguments: { command: 'npm run missing' } },
    ] },
    ...[['design-read', 'read', false], ['design-bash', 'bash', false], ['design-failed', 'bash', true]].map(([toolCallId, toolName, isError]) => ({
      role: 'toolResult', toolCallId, toolName, isError, content: [{ type: 'text', text: output }],
    })));
  return { layout, shelves: true, longLabels: true, running: ['stored-a'], runs: { 'stored-a': {
    entries: messages.map((message, i) => ({ id: `design-entry-${i}`, parentId: i ? `design-entry-${i - 1}` : null, type: 'message', message })),
    queue: { revision: 1, items: Array.from({ length: 9 }, (_, i) => ({ id: `design-queue-${i}`, text: `${i}: ${prose}`, hasImage: false, createdAt: i + 1 })),
      engine: { pendingMessageCount: 1, ordered: [{ text: 'Engine follow-up: preserve queue ownership', mode: 'followUp' }] } },
    stats: { cost: .125, contextUsage: { percent: 42, used: 42000, total: 100000 } },
  } } };
}

/** Install observers before navigation/actions. Timeouts are failure bounds, not readiness delays. */
export async function installSignals(page, { theme = 'dark', fontSize = 14 } = {}) {
  await page.addInitScript(({ theme, fontSize }) => {
    localStorage.setItem('th-lang', 'en'); localStorage.setItem('th-theme', theme);
    localStorage.setItem('th-ws-expanded', '["ws"]'); localStorage.setItem('th-font-size', String(fontSize));
    window.qaSignal = predicate => new Promise((done, fail) => {
      const mo = new MutationObserver(check), ro = new ResizeObserver(check);
      const timer = setTimeout(() => { mo.disconnect(); ro.disconnect(); fail(new Error('Design DOM/geometry deadline')); }, 8000);
      function check() { if (predicate()) { clearTimeout(timer); mo.disconnect(); ro.disconnect(); done(true); } }
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      ro.observe(document.documentElement); check();
    });
  }, { theme, fontSize });
}
export const arm = (page, predicate) => page.evaluate(source => {
  window.qaPending = window.qaSignal(new Function(`return (${source})`)());
}, String(predicate));
export const complete = page => page.evaluate(() => window.qaPending);

export async function seedLive(page, fixture) {
  await arm(page, () => !!document.querySelector('[data-tool-call-id="design-running"]') && !!document.querySelector('.th-chat-msg--streaming'));
  fixture.deliver('stored-a', { type: 'tool', toolCallId: 'design-running', toolName: 'bash', phase: 'start', args: { command: 'go test ./...' } });
  fixture.deliver('stored-a', { type: 'tool', toolCallId: 'design-running', toolName: 'bash', phase: 'update', partial: { content: [{ text: 'Running package checks...' }] } });
  fixture.deliver('stored-a', { type: 'messageDelta', delta: { kind: 'text_delta', delta: prose } });
  await complete(page);
}

/** Caller owns browser; close() closes context before the isolated fixture and returns a receipt. */
export async function setupDesign(browser, options = {}) {
  const fixture = startFixture({ ...designSeed(options.layout), port: 0 });
  let context;
  try {
    context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 },
      hasTouch: options.coarse ?? false, isMobile: options.coarse ?? false, colorScheme: options.theme ?? 'dark' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await installSignals(page, options);
    const attached = fixture.wait('frame', frame => frame.type === 'chat.stats');
    await page.goto(fixture.url); await attached;
    await page.evaluate(() => window.qaSignal(() => document.querySelector('.th-queue-header') && document.querySelector('.th-activity-bar')
      && document.querySelector('.th-goal-bar') && document.querySelector('[data-tool-call-id="design-failed"]')
      && document.querySelector('.th-chat-status-num')?.textContent === '42%'));
    await seedLive(page, fixture);
    return { page, context, fixture, errors, async close() {
      await context.close(); return { contextClosed: true, url: fixture.url, ...await fixture.stop(), port: Number(new URL(fixture.url).port) };
    } };
  } catch (error) {
    if (context) await context.close();
    const cleanup = await fixture.stop();
    throw new Error(`Design setup failed; cleanup=${JSON.stringify(cleanup)}`, { cause: error });
  }
}

/** A real wheel event and exact scrollend subscription; no polling or fixed sleeps. */
export async function wheel(page, locator, delta, gutter = false) {
  await locator.evaluate(element => {
    window.qaPending = new Promise((done, fail) => {
      const timer = setTimeout(() => { element.removeEventListener('scrollend', finish); fail(new Error('Design scrollend deadline')); }, 8000);
      function finish(event) { if (event.target !== element) return; clearTimeout(timer); element.removeEventListener('scrollend', finish); done(true); }
      element.addEventListener('scrollend', finish);
    });
  });
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + (gutter ? box.width - 2 : box.width / 2), box.y + box.height / 2);
  await page.mouse.wheel(0, delta); await complete(page);
}
