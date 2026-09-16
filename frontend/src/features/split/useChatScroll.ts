import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject, UIEventHandler } from "react";

// Tolerant on purpose: streaming grows content between a scroll-to-bottom and
// its scroll event, so a tight epsilon drops follow every tick and forces manual
// scrolling. ~2 lines of slack keeps follow pinned without hiding the button.
const BOTTOM_EPSILON = 40;
const PROGRAMMATIC_WRITE_WINDOW_MS = 600;
const PROGRAMMATIC_WRITE_EPSILON = 1;
const PROGRAMMATIC_WRITE_LIMIT = 16;
const READER_INPUT_GRACE_MS = 300;
const MOTION_STREAK_GAP_MS = 250;
const MOTION_STREAK_DISTANCE = 400;

export interface ChatScrollState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly contentRef: RefObject<HTMLDivElement>;
  readonly showScrollToBottom: boolean;
  readonly onScroll: UIEventHandler<HTMLDivElement>;
  readonly scrollToBottom: (options?: { readerCommand?: boolean }) => void;
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
  const lastReaderSignalRef = useRef(-Infinity);
  const pointerDownRef = useRef(false);
  const lastScrollEventRef = useRef<{ pos: number; at: number } | null>(null);
  // Mutable accumulator: writes and their delayed echoes span multiple renders.
  const programmaticWritesRef = useRef<Array<{ value: number; at: number }>>([]);
  const restoredVersionRef = useRef<number | undefined>(undefined);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isFollowing = useCallback(() => followRef.current, []);
  const isReaderInputActive = useCallback(() =>
    pointerDownRef.current || performance.now() - lastReaderSignalRef.current <= READER_INPUT_GRACE_MS, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const noteSignal = (): void => { lastReaderSignalRef.current = performance.now(); };
    const pointerDown = (): void => { pointerDownRef.current = true; noteSignal(); };
    const pointerEnd = (): void => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      noteSignal();
    };
    const pointerMove = (): void => { if (pointerDownRef.current) noteSignal(); };
    const scrollEnd = (): void => {
      lastReaderSignalRef.current = -Infinity;
      lastScrollEventRef.current = null;
    };
    const listeners = [
      ["pointerdown", pointerDown],
      ["pointermove", pointerMove],
      ["touchstart", noteSignal],
      ["touchmove", noteSignal],
      ["wheel", noteSignal],
      ["keydown", noteSignal],
      ["scrollend", scrollEnd],
    ] as const;
    for (const [event, listener] of listeners) element.addEventListener(event, listener, { passive: true });
    window.addEventListener("pointerup", pointerEnd, { capture: true, passive: true });
    window.addEventListener("pointercancel", pointerEnd, { capture: true, passive: true });
    return () => {
      for (const [event, listener] of listeners) element.removeEventListener(event, listener);
      window.removeEventListener("pointerup", pointerEnd, true);
      window.removeEventListener("pointercancel", pointerEnd, true);
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

  const scrollToBottom = useCallback((options?: { readerCommand?: boolean }) => {
    if (options?.readerCommand) {
      lastReaderSignalRef.current = -Infinity;
      pointerDownRef.current = false;
      lastScrollEventRef.current = null;
    }
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
    const appOwned = isRecentProgrammaticWrite(element.scrollTop);
    if (isReaderInputActive()) {
      followRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
      return;
    }
    if (!atBottom && appOwned) return;
    followRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, [isReaderInputActive, isRecentProgrammaticWrite]);

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pos = element.scrollTop;
    const at = performance.now();
    const previous = lastScrollEventRef.current;
    const distance = previous === null ? 0 : Math.abs(pos - previous.pos);
    // Stationary echoes are neutral; moving notifications in a native streak
    // retain reader ownership even through historical app-write coordinates.
    const continuingMotion = previous !== null && at - previous.at <= MOTION_STREAK_GAP_MS
      && distance > 0 && distance <= MOTION_STREAK_DISTANCE;
    lastScrollEventRef.current = { pos, at };
    if (continuingMotion || !isRecentProgrammaticWrite(pos)) lastReaderSignalRef.current = at;
    updateIntent();
  }, [isRecentProgrammaticWrite, updateIntent]);

  useLayoutEffect(() => {
    if (restoredVersionRef.current === restoreVersion) return;
    restoredVersionRef.current = restoreVersion;
    scrollToBottom({ readerCommand: true });
  }, [restoreVersion, scrollToBottom]);

  useEffect(() => {
    if (focused) scrollToBottom({ readerCommand: true });
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
    onScroll,
    scrollToBottom,
    isFollowing,
    isReaderInputActive,
    noteProgrammaticWrite,
    isRecentProgrammaticWrite,
  };
}
