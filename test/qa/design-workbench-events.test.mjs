import { test, expect } from 'bun:test';
import { wheel } from './design-workbench-fixture.mjs';

test('wheel completion rejects stale auto-follow and unrelated scrollend events', async () => {
  // Given the same native EventTarget subscription mechanism used in the browser.
  const element = new EventTarget();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  let completed = false;
  const locator = {
    async evaluate(install) {
      install(element);
      window.qaPending.then(() => { completed = true; });
    },
    async boundingBox() { return { x: 0, y: 0, width: 100, height: 100 }; },
  };
  const page = {
    mouse: {
      async move() {
        // An already-queued auto-follow scroll finishes while positioning the pointer.
        element.dispatchEvent(new Event('scroll'));
        element.dispatchEvent(new Event('scrollend'));
      },
      async wheel() {
        try {
          // Then the old scroll must not complete the new wheel transaction.
          expect(completed).toBe(false);
          element.dispatchEvent(new Event('wheel'));
          element.dispatchEvent(new Event('scrollend'));
          // Drain the promise callback for that exact emitted event, not elapsed time.
          await Promise.resolve();
          expect(completed).toBe(false);
        } finally {
          // The exact owner must actually scroll after this wheel, then finish.
          element.dispatchEvent(new Event('scroll'));
          element.dispatchEvent(new Event('scrollend'));
        }
      },
    },
    async evaluate(read) { return read(); },
  };
  try {
    // When a new wheel is delivered after the stale auto-follow completion.
    await wheel(page, locator, 200, true);
    expect(completed).toBe(true);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});
