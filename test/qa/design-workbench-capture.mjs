/** Runs in the page after a pre-action DOM/state subscription has completed.
 * Insertion is not visibility: ancestor motion, fonts and composed styles all
 * contribute to the frame. Infinite status spinners never gate a still image.
 */
export async function settleCapture({ target, settings }) {
  const element = document.querySelector(target);
  if (!element) throw new Error(`Capture target missing: ${target}`);
  element.getBoundingClientRect(); // Flush layout before reading native animations/fonts.
  const animations = new Set(element.getAnimations({ subtree: true }));
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    for (const animation of parent.getAnimations()) animations.add(animation);
  }
  const finite = [...animations].filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime));
  const motion = finite.map(animation => ({ name: animation.animationName ?? animation.transitionProperty,
    before: animation.playState }));
  let timer;
  try {
    await Promise.race([
      Promise.all([...finite.map(animation => animation.finished), document.fonts.ready]),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`Capture motion/font deadline: ${target}`)), 8000); }),
    ]);
  } finally { clearTimeout(timer); }

  function visible(node, label) {
    if (!node?.isConnected) throw new Error(`Capture control missing/detached: ${label}`);
    let opacity = 1;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility !== 'visible') throw new Error(`Capture control hidden: ${label}`);
      opacity *= Number(style.opacity);
    }
    if (opacity !== 1) throw new Error(`Capture composed opacity ${opacity}: ${label}`);
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight)) {
      throw new Error(`Capture control outside viewport: ${label}`);
    }
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit !== node && !node.contains(hit)) throw new Error(`Capture control occluded: ${label}`);
    return { label, opacity, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }
  const receipt = visible(element, target);
  if (document.fonts.status !== 'loaded') throw new Error('Capture fonts not loaded');
  const remaining = [...element.getAnimations({ subtree: true })];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) remaining.push(...parent.getAnimations());
  if (remaining.some(a => Number.isFinite(a.effect.getComputedTiming().endTime) && a.playState !== 'finished')) {
    throw new Error(`Capture motion still active: ${target}`);
  }
  const controls = [];
  if (settings) {
    if (!element.matches('.th-settings-panel')) throw new Error('Settings capture requires the actual Settings panel');
    const groups = element.querySelectorAll('[role="radiogroup"]');
    if (groups.length !== 2 || element.querySelectorAll('[role="radio"]').length !== 5) throw new Error('Settings radio controls missing');
    for (const selector of ['.th-settings-select', '.th-settings-size-value', '.th-settings-item']) {
      controls.push(visible(element.querySelector(selector), selector));
    }
    const buttons = element.querySelectorAll('button');
    for (const button of buttons) controls.push(visible(button, button.getAttribute('aria-label') ?? button.textContent));
    const value = element.querySelector('.th-settings-size-value').textContent;
    const preference = localStorage.getItem('th-font-size');
    const applied = getComputedStyle(document.documentElement).getPropertyValue('--th-font-size').trim();
    if (value !== `${settings.fontSize}px` || applied !== value || preference !== String(settings.fontSize)) throw new Error(`Settings font mismatch: ${value}/${preference}/${applied}`);
    if (settings.lang && element.querySelector('[role="radiogroup"] [aria-checked="true"]')?.textContent !== settings.lang.toUpperCase()) throw new Error('Settings language mismatch');
    receipt.settings = { fontSize: value, preference, applied, font: element.querySelector('.th-settings-select').value };
  }
  return { ...receipt, controls, fontsStatus: document.fonts.status,
    animations: motion.map((row, i) => ({ ...row, after: finite[i].playState, finishedAwaited: true })),
    excludedInfinite: [...animations].length - finite.length };
}

/** Validate the requested surface immediately before each full or crop capture. */
export async function captureSettled(page, readiness, screenshot) {
  const receipt = await page.evaluate(settleCapture, readiness);
  await page.screenshot({ ...screenshot, animations: 'allow' });
  return receipt;
}
