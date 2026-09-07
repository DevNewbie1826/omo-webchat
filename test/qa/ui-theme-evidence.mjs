/** Theme-only evidence contracts. Capture bytes and cleanup are fail-closed. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export const near = (a, b, tolerance = 1) =>
  a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) <= tolerance);
export const parseComputedColor = value => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value ?? '');
  return match ? { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) } : null;
};
export function judgeFill(sample, referenceRgb) {
  const computed = parseComputedColor(sample.computed);
  const computedMatches = computed !== null && computed.alpha === 1 && near(computed.rgb, referenceRgb, 0);
  const pixelMatches = (sample.samples ?? []).some(point => near(point.rgb, referenceRgb));
  return { ...sample, computedMatches, pixelMatches, needsPixel: true, referenceRgb,
    pixelEvidence: (sample.samples ?? []).map(point => point.rgb),
    matches: sample.present === true && sample.visible === true && sample.onScreen === true && computedMatches && pixelMatches };
}
export const REQUIRED_SURFACES = ['canvas', 'sidebar', 'composer', 'send', 'toolShell', 'menu', 'highlightedRow',
  'collapsedTool', 'text', 'menuShadow', 'toolBorder', 'sendHover', 'sendFocus', 'sendDisabled', 'stop',
  'success', 'error', 'running', 'queue', 'status', 'goal', 'activity'];
export const missingSurfaces = results => results.flatMap(result =>
  [...new Set([...REQUIRED_SURFACES, ...Object.keys(result.surfaces)])]
    .filter(name => !result.surfaces[name]?.present || !result.surfaces[name]?.matches)
    .map(name => `${result.scenario}/${result.theme}/${name}`));

/** settle and measure run on the same real page; decode receives the exact
 * screenshot return value written to disk, never another browser frame. */
export async function captureFrame({ page, path, settle, decode, measure, actions, save = writeFile }) {
  const readiness = await settle();
  const bytes = await page.screenshot({ animations: 'allow' });
  await save(path, bytes);
  await decode(page, bytes);
  const geometry = await measure();
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
    readiness, actions: structuredClone(actions), geometry };
}

/** Attempt every owned closure and retain every error. A success receipt can
 * only be written after all closure promises resolve. Receipt I/O also rejects. */
export async function closeResources(resources, save) {
  const closed = [], errors = [];
  for (const { name, close } of resources) {
    try { closed.push({ name, closed: true, receipt: await close() }); }
    catch (error) { errors.push(error); closed.push({ name, closed: false, error: String(error) }); }
  }
  try { await save({ success: errors.length === 0, resources: closed }); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Theme resource cleanup failed');
  return closed;
}

/** Native finite-animation and font promises, not elapsed-time readiness. */
export async function settleFrame() {
  document.documentElement.getBoundingClientRect();
  const motion = [];
  let timer;
  const finishMotion = async () => {
    await document.fonts.ready;
    // Each continuation is driven by native animation completion/cancellation,
    // never a timer or geometry poll. Replacement hover transitions are new
    // animations and must finish too; canceled animations are recorded.
    let active = document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime) && animation.playState !== 'finished');
    while (active.length) {
      await Promise.all(active.map(async animation => {
        const row = { name: animation.animationName ?? animation.transitionProperty };
        try { await animation.finished; row.state = 'finished'; }
        catch (error) {
          if (error.name !== 'AbortError' || animation.playState !== 'idle') throw error;
          row.state = 'canceled'; row.reason = String(error);
        }
        motion.push(row);
      }));
      active = document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime) && animation.playState !== 'finished');
    }
  };
  try {
    await Promise.race([finishMotion(), new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error('Theme frame motion/font deadline')), 8000);
    })]);
  } finally { clearTimeout(timer); }
  return { fonts: document.fonts.status, motion, viewport: { width: innerWidth, height: innerHeight } };
}

/** Align the real tool header inside its real transcript scrollport. A tall
 * expanded body may exceed the port; its header must expose the shell paint.
 * Subscribe before native scrollTo; scrollend is scoped to that exact owner. */
export async function exposeTranscript(selector) {
  const target = document.querySelector(selector);
  if (!target) throw new Error(`Required transcript target missing: ${selector}`);
  const port = target.closest('.th-chat-body');
  if (!port) throw new Error(`Required transcript scrollport missing: ${selector}`);
  const before = port.scrollTop;
  const portRect = port.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
  const top = Math.max(0, Math.min(port.scrollHeight - port.clientHeight, before + targetRect.top - portRect.top - 8));
  if (Math.abs(top - before) > 1) {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => { cleanup(); fail(new Error(`Theme transcript scrollend deadline: ${selector}`)); }, 8000);
      function cleanup() { clearTimeout(timer); port.removeEventListener('scrollend', ended); }
      function ended(event) { if (event.target === port) { cleanup(); done(); } }
      port.addEventListener('scrollend', ended);
      port.scrollTo({ top, behavior: 'instant' });
    });
  }
  const rect = target.getBoundingClientRect(), bounds = port.getBoundingClientRect();
  if (rect.top < Math.max(0, bounds.top) || rect.bottom > Math.min(innerHeight, bounds.bottom)) {
    throw new Error(`Theme transcript header not exposed: ${selector}; ${JSON.stringify(rect.toJSON())}`);
  }
  return { selector, before, after: port.scrollTop, requestedTop: top,
    target: rect.toJSON(), scrollport: bounds.toJSON() };
}
