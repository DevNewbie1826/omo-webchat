import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../src/features/split/ChatTranscript";
import type { TranscriptItem } from "../src/features/split/useChatFrameState";
import { I18nContext, translate, useT } from "../src/i18n";
import "../src/styles/tokens.css";
import "../src/styles/global.css";
import "../src/styles/chat-pane.css";
import "../src/styles/chat-transcript.css";
import "../src/styles/tool-card.css";
import "../src/styles/math.css";

const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#5688aa"/><circle cx="300" cy="200" r="100" fill="#ffd070"/></svg>');
// Deterministic synthetic conversation data, not application UI copy.
const paragraph = "The transcript keeps a complete record of the discussion. Each message has a stable identity, and the browser measures its rendered height as it enters the visible region. This example includes enough detail to wrap naturally on a narrow mobile screen.";
export function makeRow(index: number, loaded: boolean): Extract<TranscriptItem, { kind: "message" }> {
  const assistant = index % 2 === 1;
  const ordinal = Math.floor(index / 2) + 1;
  let text = assistant ? Array.from({ length: 1 + ((ordinal - 1) % 4) }, () => paragraph).join("\n\n") : `Question ${ordinal}: How does scrolling handle this message?`;
  if (assistant && ordinal % 3 === 0) text += "\n\n- Preserve the visible conversation.\n- Measure the next message.\n- Keep the reader in control.";
  if (assistant && ordinal % 5 === 0) text += "\n\n```typescript\nconst row = { index: " + index + ", measured: true };\nconst height = element.getBoundingClientRect().height;\nconsole.log(row, height);\n```";
  const image = assistant && ordinal % 21 === 0;
  return { kind: "message", message: { role: assistant ? "assistant" : "user", ts: index, blocks: [
    { kind: "text", text },
    ...(image ? [loaded ? { kind: "image", data: svg, mimeType: "image/svg+xml" } : { kind: "text", text: "[Image pending]" }] : []),
  ] } };
}
declare global {
  interface Window {
    __append: () => void;
    __loadImages: () => void;
    __qaRows: { index: number; role: string; textLength: number; image: boolean }[];
    __qaReady: boolean;
  }
}
export function ScrollQa() {
  const [count, setCount] = useState(300);
  const [loaded, setLoaded] = useState(false);
  const { t } = useT();
  const items = Array.from({ length: count }, (_, index) => index < 300 ? makeRow(index, loaded) : { kind: "message" as const, message: { role: "assistant", ts: index, blocks: [{ kind: "text", text: paragraph }] } });
  useLayoutEffect(() => {
    window.__append = () => setCount((value) => value + 1);
    window.__loadImages = () => setLoaded(true);
    window.__qaRows = items.map((item, index) => ({ index, role: item.message.role, textLength: (item.message.blocks ?? []).reduce((total, block) => total + (block.text?.length ?? 0), 0), image: index % 2 === 1 && (Math.floor(index / 2) + 1) % 21 === 0 }));
    window.__qaReady = true;
    window.dispatchEvent(new Event("qa-ready"));
  });
  return <div className="th-app" aria-label={t("chat.image")}><div className="th-chat-pane"><div className="th-chat-main"><div className="th-chat-main-content">
    <ChatTranscript items={items} streaming="" thinking="" toolCalls={{}} doneReason={null} error="" restoreVersion={0} focused={true} historyLoaded={true}/>
  </div></div></div></div>;
}
const style = document.createElement("style");
style.textContent = "html, body, #root { height:100%; margin:0; overflow:hidden } #root, .th-app, .th-chat-pane, .th-chat-main, .th-chat-main-content { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; min-width:0 } .th-app { height:100% }";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<I18nContext.Provider value={{ lang: "en", setLang: () => {}, font: "system", setFont: () => {}, fontSize: 14, setFontSize: () => {}, t: (key, vars) => translate("en", key, vars) }}><ScrollQa/></I18nContext.Provider>);
