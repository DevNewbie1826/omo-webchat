import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject, UIEventHandler } from "react";

// Tolerant on purpose: streaming grows content between a scroll-to-bottom and
// its scroll event, so a tight epsilon drops follow every tick and forces manual
// scrolling. ~2 lines of slack keeps follow pinned without hiding the button.
const BOTTOM_EPSILON = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 600;
const PROGRAMMATIC_WRITE_EPSILON = 1;
const PROGRAMMATIC_WRITE_LIMIT = 16;
const READER_INPUT_WINDOW_MS = 400;

export interface ChatScrollState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly contentRef: RefObject<HTMLDivElement>;
  readonly showScrollToBottom: boolean;
  readonly onScroll: UIEventHandler<HTMLDivElement>;
  readonly scrollToBottom: () => void;
  readonly isFollowing: () => boolean;
  readonly isReaderInputActive: () => boolean;
  readonly noteProgrammaticWrite: () => void;
  readonly isRecentProgrammaticWrite: (value: number) => boolean;
}

export function useChatScroll(
  restoreVersion: number,
  focused: boolean,
  // Explicit "jump to bottom" intent (button, focus gain, restore): any
  // measurement compensation queued for replay is moot once the viewport is
  // deliberately sent to the end, so the owner discards it here.
  onScrollToBottomIntent?: (() => void) | undefined,
): ChatScrollState {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastReaderInputRef = useRef(-Infinity);
  // Mutable accumulator: writes and their delayed echoes span multiple renders.
  const programmaticWritesRef = useRef<Array<{ value: number; at: number }>>([]);
  const restoredVersionRef = useRef<number | undefined>(undefined);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isFollowing = useCallback(() => followRef.current, []);
  const isReaderInputActive = useCallback(() =>
    performance.now() - lastReaderInputRef.current <= READER_INPUT_WINDOW_MS, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const noteReaderInput = (): void => { lastReaderInputRef.current = performance.now(); };
    const events = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
    for (const event of events) element.addEventListener(event, noteReaderInput, { passive: true });
    return () => {
      for (const event of events) element.removeEventListener(event, noteReaderInput);
    };
  }, []);

  const noteProgrammaticWrite = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const at = performance.now();
    const writes = programmaticWritesRef.current.filter((write) => at - write.at <= PROGRAMMATIC_WRITE_WINDOW_MS);
    writes.push({ value: element.scrollTop, at });
    programmaticWritesRef.current = writes.slice(-PROGRAMMATIC_WRITE_LIMIT);
  }, []);

  const isRecentProgrammaticWrite = useCallback((value: number) => {
    const now = performance.now();
    return programmaticWritesRef.current.some((write) =>
      now - write.at <= PROGRAMMATIC_WRITE_WINDOW_MS && Math.abs(write.value - value) <= PROGRAMMATIC_WRITE_EPSILON,
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    onScrollToBottomIntent?.();
    followRef.current = true;
    const target = Math.max(0, element.scrollHeight - element.clientHeight);
    const previous = element.scrollTop;
    if (previous !== target) {
      element.scrollTop = element.scrollHeight;
      if (element.scrollTop !== previous) noteProgrammaticWrite();
    }
    setShowScrollToBottom(false);
  }, [onScrollToBottomIntent, noteProgrammaticWrite]);

  const updateIntent = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_EPSILON;
    // Quiet echoes can arrive after content grows. A reader gesture takes
    // precedence, even when it returns to a position we recently wrote.
    if (!isReaderInputActive() && !atBottom && isRecentProgrammaticWrite(element.scrollTop)) return;
    followRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, [isReaderInputActive, isRecentProgrammaticWrite]);

  useLayoutEffect(() => {
    if (restoredVersionRef.current === restoreVersion) return;
    restoredVersionRef.current = restoreVersion;
    scrollToBottom();
  }, [restoreVersion, scrollToBottom]);

  useEffect(() => {
    if (focused) scrollToBottom();
  }, [focused, scrollToBottom]);

  useEffect(() => {
    const scrollport = scrollRef.current;
    const content = contentRef.current;
    if (!scrollport || !content) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
      else updateIntent();
    });
    observer.observe(scrollport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom, updateIntent]);

  return {
    scrollRef,
    contentRef,
    showScrollToBottom,
    onScroll: updateIntent,
    scrollToBottom,
    isFollowing,
    isReaderInputActive,
    noteProgrammaticWrite,
    isRecentProgrammaticWrite,
  };
}
