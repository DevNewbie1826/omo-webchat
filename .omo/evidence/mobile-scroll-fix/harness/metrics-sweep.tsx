import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../../../../frontend/src/features/split/ChatTranscript";
import { useAppConfig } from "../../../../frontend/src/app-config";
import { I18nContext } from "../../../../frontend/src/i18n";
import "../../../../frontend/src/styles/tokens.css";
import "../../../../frontend/src/styles/global.css";
import "../../../../frontend/src/styles/chat-pane.css";
import "../../../../frontend/src/styles/chat-transcript.css";
import "../../../../frontend/src/styles/tool-card.css";
import "../../../../frontend/src/styles/math.css";

declare global { interface Window { __sweepConfig: ReturnType<typeof useAppConfig>; } }

const text = "The transcript keeps a complete record of the discussion. Each message has a stable identity, and the browser measures its rendered height as it enters the visible region. This example includes enough detail to wrap naturally on a narrow mobile screen.";
export const items = Array.from({ length: 300 }, (_, index) => ({ kind: "message" as const, message: { role: "assistant", ts: index, blocks: [{ kind: "text", text }] } }));
export function MetricsSweep() {
  const config = useAppConfig();
  useEffect(() => {
    window.__sweepConfig = config;
    // Observe the completed settings commit, then the browser's layout frames.
    queueMicrotask(() => requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("sweep-applied")))));
  }, [config]);
  return <I18nContext.Provider value={config}><div className="th-app"><div className="th-chat-pane"><div className="th-chat-main"><div className="th-chat-main-content"><ChatTranscript items={items} streaming="" thinking="" toolCalls={{}} doneReason={null} error="" restoreVersion={0} focused={true} historyLoaded={true}/></div></div></div></div></I18nContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<MetricsSweep/>);
