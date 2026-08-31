import { useEffect, useRef, useState } from "react";

// Coalesces streaming text deltas into at most one state commit per animation
// frame so ReactMarkdown re-parses the growing streaming string <= once per
// frame, not once per token. Production uses the browser's real rAF; the test
// polyfill defers to a microtask so jsdom does not recurse the virtualizer's
// rAF-based scroll reconciliation.
export function useStreamingBuffer() {
  const [streaming, setStreaming] = useState("");
  const bufferRef = useRef("");
  const pendingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const flush = (): void => {
    pendingRef.current = false;
    rafRef.current = null;
    setStreaming(bufferRef.current);
  };

  const push = (delta: string): void => {
    bufferRef.current += delta;
    if (pendingRef.current) return;
    pendingRef.current = true;
    const handle = requestAnimationFrame(flush);
    // A synchronous rAF polyfill fires flush() before this assignment; then
    // pending is already false and the handle must not be recorded, or a later
    // clear()/cancel would target a stale id.
    if (pendingRef.current) rafRef.current = handle;
  };

  const clear = (): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = false;
    bufferRef.current = "";
    setStreaming("");
  };

  return { streaming, push, clear };
}
