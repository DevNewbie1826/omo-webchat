class ResizeObserverPolyfill {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    const entry = {
      target,
      contentRect: { width: 1024, height: 768, x: 0, y: 0, top: 0, left: 0, bottom: 768, right: 1024, toJSON: () => "" },
      borderBoxSize: [{ inlineSize: 1024, blockSize: 768 }],
      contentBoxSize: [{ inlineSize: 1024, blockSize: 768 }],
      devicePixelContentBoxSize: [{ inlineSize: 1024, blockSize: 768 }],
    };
    this.cb([entry as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as unknown as { ResizeObserver: new (cb: ResizeObserverCallback) => unknown }).ResizeObserver =
  ResizeObserverPolyfill;

let rafId = 0;
const canceledRafs = new Set<number>();
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  const id = ++rafId;
  queueMicrotask(() => {
    if (canceledRafs.has(id)) canceledRafs.delete(id);
    else cb(Date.now());
  });
  return id;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) => {
  canceledRafs.add(id);
}) as typeof cancelAnimationFrame;

// jsdom lacks matchMedia; default to desktop (no media query matches). Tests
// that need a specific match (e.g. mobile) stub it locally with vi.stubGlobal.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

const proto = HTMLElement.prototype;
for (const prop of ["clientHeight", "offsetHeight", "scrollHeight", "clientWidth", "offsetWidth", "scrollWidth"]) {
  if (!(prop in proto)) {
    Object.defineProperty(proto, prop, { configurable: true, get: () => 768, set: () => {} });
  }
}
