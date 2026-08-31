import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../lib/api";
import type { ProviderDiscoveryState, ProviderStatus } from "./workspace";

export function useProviderDiscovery(enabled: boolean): {
  readonly discovery: ProviderDiscoveryState;
  readonly retry: () => void;
} {
  const [discovery, setDiscovery] = useState<ProviderDiscoveryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const activeAttemptRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setDiscovery({ status: "loading" });
      return;
    }
    let cancelled = false;
    activeAttemptRef.current = attempt;
    setDiscovery({ status: "loading" });
    void apiJson<readonly ProviderStatus[]>("/api/providers").then(
      (providers) => {
        if (!cancelled && activeAttemptRef.current === attempt) setDiscovery({ status: "loaded", providers });
      },
      () => {
        if (!cancelled && activeAttemptRef.current === attempt) setDiscovery({ status: "error" });
      },
    );
    return () => { cancelled = true; };
  }, [attempt, enabled]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { discovery, retry };
}
