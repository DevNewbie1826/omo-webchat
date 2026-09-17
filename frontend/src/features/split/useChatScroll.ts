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

type ProgrammaticWriteOrigin = "pin-intent" | "measurement";

export interface ChatScrollState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly contentRef: RefObject<HTMLDivElement>;
  readonly showScrollToBottom: boolean;
  readonly onScroll: UIEventHandler<HTMLDivElement>;
  readonly scrollToBottom: (options?: { automatic?: boolean }) => void;
  readonly isFollowing: () => boolean;
  readonly isReaderInputActive: () => boolean;
  readonly noteProgrammaticWrite: (origin: ProgrammaticWriteOrigin) => void;
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
  const readerEngagedRef = useRef(false);
  const lastReaderSignalRef = useRef(-Infinity);
  // Physical contacts survive an explicit handoff; only their ownership is
  // relinquished until genuine movement reclaims it.
  const contactsRef = useRef(new Map<number, { x: number; y: number; owns: boolean }>());
  // Motion inherits reader provenance, never ownership from unowned echoes.
  // Neutral app echoes leave the streak's position/time unchanged.
  const lastScrollEventRef = useRef<{ pos: number; at: number; reader: boolean } | null>(null);
  // Mutable accumulator: writes and their delayed echoes span multiple renders.
  const programmaticWritesRef = useRef<Array<{ value: number; at: number; origin: ProgrammaticWriteOrigin }>>([]);
  const pendingEchoRef = useRef<{ value: number; at: number; origin: ProgrammaticWriteOrigin } | null>(null);
  const restoredVersionRef = useRef<number | undefined>(undefined);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isFollowing = useCallback(() => followRef.current, []);
  const isReaderInputActive = useCallback(() =>
    [...contactsRef.current.values()].some((contact) => contact.owns)
      || performance.now() - lastReaderSignalRef.current <= READER_INPUT_GRACE_MS, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const noteSignal = (): void => {
      readerEngagedRef.current = true;
      lastReaderSignalRef.current = performance.now();
    };
    const pointerDown = (event: PointerEvent): void => {
      contactsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY, owns: true });
      noteSignal();
    };
    const pointerEnd = (event: PointerEvent): void => {
      const contact = contactsRef.current.get(event.pointerId);
      contactsRef.current.delete(event.pointerId);
      if (contact?.owns) noteSignal();
    };
    const pointerMove = (event: PointerEvent): void => {
      if (event.pointerType === "mouse" && event.buttons === 0) {
        // Conclusive lost-release evidence, not new reader input.
        contactsRef.current.delete(event.pointerId);
        return;
      }
      const contact = contactsRef.current.get(event.pointerId);
      if (!contact || (contact.x === event.clientX && contact.y === event.clientY)) return;
      contact.x = event.clientX;
      contact.y = event.clientY;
      contact.owns = true;
      noteSignal();
    };
    const scrollEnd = (): void => {
      lastReaderSignalRef.current = -Infinity;
      lastScrollEventRef.current = null;
    };
    const blur = (): void => {
      // Window deactivation invalidates contacts whose releases may be lost.
      contactsRef.current.clear();
      scrollEnd();
    };
    element.addEventListener("pointerdown", pointerDown, { passive: true });
    element.addEventListener("pointermove", pointerMove, { passive: true });
    const listeners = [
      ["touchstart", noteSignal],
      ["touchmove", noteSignal],
      ["wheel", noteSignal],
      ["keydown", noteSignal],
      ["scrollend", scrollEnd],
    ] as const;
    for (const [event, listener] of listeners) element.addEventListener(event, listener, { passive: true });
    window.addEventListener("pointerup", pointerEnd, { capture: true, passive: true });
    window.addEventListener("pointercancel", pointerEnd, { capture: true, passive: true });
    window.addEventListener("blur", blur);
    return () => {
      element.removeEventListener("pointerdown", pointerDown);
      element.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("blur", blur);
      for (const [event, listener] of listeners) element.removeEventListener(event, listener);
      window.removeEventListener("pointerup", pointerEnd, true);
      window.removeEventListener("pointercancel", pointerEnd, true);
    };
  }, []);

  const noteProgrammaticWrite = useCallback((origin: ProgrammaticWriteOrigin) => {
    const element = scrollRef.current;
    if (!element) return;
    const at = performance.now();
    const writes = programmaticWritesRef.current.filter((write) => at - write.at <= PROGRAMMATIC_WRITE_WINDOW_MS);
    const write = { value: element.scrollTop, at, origin };
    pendingEchoRef.current = write;
    writes.push(write);
    programmaticWritesRef.current = writes.slice(-PROGRAMMATIC_WRITE_LIMIT);
  }, []);

  const recentProgrammaticWrite = useCallback((value: number) => {
    const now = performance.now();
    return [...programmaticWritesRef.current].reverse().find((write) =>
      now - write.at <= PROGRAMMATIC_WRITE_WINDOW_MS && Math.abs(write.value - value) <= PROGRAMMATIC_WRITE_EPSILON,
    );
  }, []);
  const isRecentProgrammaticWrite = useCallback((value: number) =>
    recentProgrammaticWrite(value) !== undefined, [recentProgrammaticWrite]);

  const scrollToBottom = useCallback((options?: { automatic?: boolean }) => {
    if (!options?.automatic) {
      lastReaderSignalRef.current = -Infinity;
      for (const contact of contactsRef.current.values()) contact.owns = false;
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
      if (element.scrollTop !== previous) noteProgrammaticWrite("pin-intent");
    }
    setShowScrollToBottom(false);
  }, [onScrollToBottomIntent, noteProgrammaticWrite]);

  const updateIntent = useCallback((echoOrigin?: ProgrammaticWriteOrigin, readerMotion = false) => {
    const element = scrollRef.current;
    if (!element) return;
    // Attach stays pinned until physical engagement, regardless of attribution.
    if (!readerEngagedRef.current) {
      followRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_EPSILON;
    const readerActive = isReaderInputActive();
    const origin = echoOrigin ?? (readerMotion ? undefined : recentProgrammaticWrite(element.scrollTop)?.origin);
    // Compensation may temporarily reach the DOM end while its sizer lags.
    // Its echo cannot grant follow intent (or revoke it), even mid-gesture.
    if (origin === "measurement") return;
    const appOwned = origin === "pin-intent";
    if (readerActive || readerMotion) {
      followRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
      return;
    }
    if (!atBottom && appOwned) return;
    // Unowned echoes (including deferred WebKit adjustments) cannot revoke follow.
    if (!atBottom) return;
    followRef.current = true;
    setShowScrollToBottom(false);
  }, [isReaderInputActive, recentProgrammaticWrite]);

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pos = element.scrollTop;
    const at = performance.now();
    const pending = pendingEchoRef.current;
    // The next notification either consumes this write's echo or supersedes
    // it. Historical coordinates remain available to genuine reader motion.
    pendingEchoRef.current = null;
    if (pending !== null && at - pending.at <= PROGRAMMATIC_WRITE_WINDOW_MS
      && Math.abs(pos - pending.value) <= PROGRAMMATIC_WRITE_EPSILON) {
      updateIntent(pending.origin);
      return;
    }
    const previous = lastScrollEventRef.current;
    const distance = previous === null ? 0 : Math.abs(pos - previous.pos);
    // Cached coordinates may continue motion, but only a reader-attributed
    // predecessor can carry ownership beyond physical-input grace.
    const continuingMotion = previous !== null && at - previous.at <= MOTION_STREAK_GAP_MS
      && distance > 0 && distance <= MOTION_STREAK_DISTANCE;
    const unwritten = !isRecentProgrammaticWrite(pos);
    const readerOwned = isReaderInputActive();
    const readerMotion = readerOwned || (continuingMotion && previous.reader);
    if (continuingMotion || unwritten) {
      lastScrollEventRef.current = { pos, at, reader: readerMotion };
      if (readerMotion) lastReaderSignalRef.current = at;
    } else if (readerOwned && (previous === null
      || (distance > 0 && at - previous.at > MOTION_STREAK_GAP_MS))) {
      lastScrollEventRef.current = { pos, at, reader: readerOwned };
    }
    updateIntent(undefined, readerMotion);
  }, [isReaderInputActive, isRecentProgrammaticWrite, updateIntent]);

  useLayoutEffect(() => {
    if (restoredVersionRef.current === restoreVersion) return;
    restoredVersionRef.current = restoreVersion;
    readerEngagedRef.current = false;
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
      if (followRef.current) scrollToBottom({ automatic: true });
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
