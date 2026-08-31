import { useRef } from "react";
import { concatEntries } from "./chatEntries";

// Accumulates non-final entries pages and yields the full concatenated history
// when the final page arrives, so the client reconciles once instead of per
// frame. Reset on reconnect so a partial load never mixes into a fresh one.
export function useEntriesPageBuffer() {
  const bufferRef = useRef<unknown[]>([]);

  const push = (page: unknown): void => {
    bufferRef.current.push(page);
  };

  const consume = (finalPage: unknown): unknown => {
    const buffered = bufferRef.current;
    bufferRef.current = [];
    return buffered.length > 0 ? concatEntries([...buffered, finalPage]) : finalPage;
  };

  const reset = (): void => {
    bufferRef.current = [];
  };

  return { push, consume, reset };
}
