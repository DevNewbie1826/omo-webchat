import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject, UIEventHandler } from "react";

// Tolerant on purpose: streaming grows content between a scroll-to-bottom and
// its scroll event, so a tight epsilon drops follow every tick and forces manual
// scrolling. ~2 lines of slack keeps follow pinned without hiding the button.
const BOTTOM_EPSILON = 40;

export interface ChatScrollState {
  readonly scrollRef: RefObject<HTMLDivElement>;
  readonly contentRef: RefObject<HTMLDivElement>;
  readonly showScrollToBottom: boolean;
  readonly onScroll: UIEventHandler<HTMLDivElement>;
  readonly scrollToBottom: () => void;
  readonly isFollowing: () => boolean;
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
  const programmaticRef = useRef(false);
  const restoredVersionRef = useRef<number | undefined>(undefined);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isFollowing = useCallback(() => followRef.current, []);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    onScrollToBottomIntent?.();
    const target = element.scrollHeight - element.clientHeight;
    if (element.scrollTop !== target) programmaticRef.current = true;
    followRef.current = true;
    element.scrollTop = element.scrollHeight;
    setShowScrollToBottom(false);
  }, [onScrollToBottomIntent]);

  const updateIntent = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (programmaticRef.current) {
      programmaticRef.current = false;
      followRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_EPSILON;
    followRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

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
  };
}
