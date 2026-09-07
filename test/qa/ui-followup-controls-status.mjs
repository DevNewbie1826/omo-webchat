import assert from 'node:assert/strict';
import { transition } from './ui-composer-fixture.mjs';

export function pressureGeometry() {
  const status = document.querySelector('.th-chat-status');
  const rect = el => el.getBoundingClientRect().toJSON();
  const style = getComputedStyle(status), token = style.getPropertyValue('--th-type-micro-size');
  const factors = token.match(/calc\(\s*([\d.]+)px\s*\*\s*([\d.]+)\s*\)/);
  const elements = [...status.querySelectorAll('.th-chat-status-item,.th-chat-status-label,.th-chat-status-num,button,[data-chat-run-state],.th-chat-status-spinner')];
  return { status: rect(status), row: rect(status.closest('.th-chat-controls')),
    model: rect(document.querySelector('.th-model-picker-btn')), capsule: rect(document.querySelector('.th-chat-input-inner')),
    token, expectedMicro: factors ? Number(factors[1]) * Number(factors[2]) : Number.parseFloat(token),
    width: innerWidth, pageWidth: document.documentElement.scrollWidth,
    items: elements.map(el => ({ selector: el.className, rect: rect(el), text: el.textContent,
      font: Number.parseFloat(getComputedStyle(el).fontSize), visible: el.checkVisibility(),
      metric: el.matches('.th-chat-status-num'), action: el.matches('button'),
      glyphs: el.matches('.th-chat-send-preview') ? [] : [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).flatMap(n => {
        const range = document.createRange(); range.selectNodeContents(n); return [...range.getClientRects()].map(r => r.toJSON());
      }),
      hit: !el.matches('button') || (() => { const r = rect(el), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === hit || el.contains(hit); })() })) };
}
export function assertPressure(g) {
  assert(g.items.filter(i => i.metric).length === 2);
  assert(g.items.every(i => i.visible && i.rect.left >= g.status.left - .5 && i.rect.right <= g.status.right + .5
    && i.rect.top >= g.row.top - .5 && i.rect.bottom <= g.row.bottom + .5 && i.hit), JSON.stringify(g));
  assert(g.items.every(i => i.glyphs.every(r => r.left >= i.rect.left - .5 && r.right <= i.rect.right + .5
    && r.top >= i.rect.top - .5 && r.bottom <= i.rect.bottom + .5)), 'State, action and metric glyphs stay inside their own boxes');
  assert(g.items.filter(i => i.metric).every(i => Math.abs(i.font - g.expectedMicro) < .01), 'Metrics retain Micro');
  assert(Math.abs(g.model.right - g.capsule.right) <= 2 && (g.status.right <= g.model.left + .5 || g.status.bottom <= g.model.top + .5) && g.pageWidth <= g.width);
}
export async function pressureScenario(page, fixture, shot) {
  await transition(page, () => document.querySelector('.th-chat-send-btn')?.type === 'submit', async () => fixture.deliver('stored-a', { type: 'run.done', reason: 'stop' }));
  const draft = page.locator('.th-chat-input textarea'), original = '원문 inspection original '.repeat(20);
  await draft.fill(original);
  const sent = fixture.wait('frame', f => f.type === 'chat.send');
  await transition(page, () => !!document.querySelector('[data-send-phase="sending"]'), () => page.locator('.th-chat-send-btn').click());
  const request = await sent;
  await transition(page, () => !!document.querySelector('.th-chat-status-item--warn') && !!document.querySelector('[data-chat-run-state="responding"]'), async () => {
    fixture.deliver('stored-a', { type: 'run.started' }); fixture.deliver('stored-a', { type: 'compaction.started' });
  });
  const sending = await page.evaluate(pressureGeometry); assertPressure(sending); await shot('pressure-sending-compacting');
  await transition(page, () => !!document.querySelector('[data-send-phase="unknown"] .th-send-restore'), async () => fixture.deliver('stored-a', { type: 'run.done', reason: 'local_command' }));
  await draft.fill('newer draft preserved');
  const unknown = await page.evaluate(pressureGeometry); await shot('pressure-unknown-actions');
  assertPressure(unknown);
  assert(unknown.items.filter(i => i.action).length >= 3);
  const before = fixture.frames.filter(f => f.type === 'chat.send').length;
  await transition(page, () => !!document.querySelector('.th-chat-original-text'), () => page.locator('.th-chat-send-preview').click());
  assert.equal(await page.locator('.th-chat-original-text').textContent(), original);
  await transition(page, () => !document.querySelector('.th-chat-original-text'), () => page.keyboard.press('Escape'));
  assert.equal(await draft.inputValue(), 'newer draft preserved');
  assert(await page.locator('.th-chat-send-preview').evaluate(el => el === document.activeElement));
  await transition(page, `() => !document.querySelector('.th-send-restore') && document.querySelector('textarea').value === ${JSON.stringify(original)} && document.activeElement === document.querySelector('textarea')`, () => page.locator('.th-send-restore').click());
  assert.equal(await draft.inputValue(), original); assert(await draft.evaluate(el => el === document.activeElement));
  assert.equal(fixture.frames.filter(f => f.type === 'chat.send').length, before);
  return { request, sending, unknown, recovered: { original, focus: true, sends: before } };
}
export async function motionSample(page) {
  return page.locator('.th-chat-status-spinner').evaluate(async el => {
    const animations = el.getAnimations(); await Promise.all(animations.map(a => a.ready));
    const sample = () => ({ transform: getComputedStyle(el).transform,
      timeline: document.timeline.currentTime, times: animations.map(a => a.currentTime),
      duration: getComputedStyle(el).animationDuration, name: getComputedStyle(el).animationName,
      rect: el.getBoundingClientRect().toJSON(), border: getComputedStyle(el).borderTopWidth,
      color: getComputedStyle(el).color, state: el.parentElement.dataset.chatRunState });
    const before = sample();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, after: sample() };
  });
}
export function assertMotion(sample, reduced) {
  const { before, after } = sample;
  assert(after.rect.width > 0 && after.rect.height > 0 && parseFloat(after.border) > 0);
  assert.equal(after.state, 'responding');
  if (reduced) assert.equal(after.transform, before.transform, 'Reduced motion stays static');
  else { assert(after.timeline > before.timeline); assert.notEqual(after.transform, before.transform, 'Running spinner rotates'); }
}
export async function motionEvidence(page, shot) {
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normal = await motionSample(page); assertMotion(normal, false);
    await shot('motion-normal-before');
    const next = await motionSample(page); assertMotion(next, false); await shot('motion-normal-after');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await motionSample(page); assertMotion(reduced, true); await shot('motion-reduced-before');
    const reducedNext = await motionSample(page); assertMotion(reducedNext, true); await shot('motion-reduced-after');
    return { normal, next, reduced, reducedNext };
  } finally { await page.emulateMedia({ reducedMotion: 'no-preference' }); }
}
