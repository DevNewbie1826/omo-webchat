import { useLayoutEffect, useState } from '../../../frontend/node_modules/react';
import { createRoot } from '../../../frontend/node_modules/react-dom/client';
import { flushSync } from '../../../frontend/node_modules/react-dom';
import { ChatTranscript } from '../../../frontend/src/features/split/ChatTranscript';
import { useChatFrameState, mergeTranscriptItems } from '../../../frontend/src/features/split/useChatFrameState';
import { parseChatServerFrame } from '../../../frontend/src/lib/chatWsParse';
import { I18nContext, translate } from '../../../frontend/src/i18n';
import '../../../frontend/src/styles/tokens.css';
import '../../../frontend/src/styles/global.css';
import '../../../frontend/src/styles/chat-pane.css';
import '../../../frontend/src/styles/chat-transcript.css';
import '../../../frontend/src/styles/tool-card.css';
import '../../../frontend/src/styles/math.css';

export function BrowserQa() {
  const chat = useChatFrameState();
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    window.qaDeliver = (raw: unknown) => {
      const parsed = parseChatServerFrame(raw);
      if (!parsed) throw new Error('Production parser rejected frame: ' + JSON.stringify(raw));
      flushSync(() => { chat.handleFrame(parsed); setRevision(value => value + 1); });
      return parsed;
    };
    window.qaReady = true;
    window.dispatchEvent(new Event('qa-ready'));
  });
  return <div className="th-app" data-revision={revision}><div className="th-chat-pane"><div className="th-chat-main"><div className="th-chat-main-content">
    <ChatTranscript items={mergeTranscriptItems(chat.messages, chat.notices)} streaming={chat.streaming} thinking={chat.thinking} toolCalls={chat.toolCalls} doneReason={chat.doneReason} error={chat.error} restoreVersion={chat.restoreVersion} focused={true} historyLoaded={true}/>
  </div></div></div></div>;
}
declare global { interface Window { qaReady: boolean; qaDeliver: (raw: unknown) => unknown; } }
const style = document.createElement('style');
style.textContent = 'html,body,#root{height:100%;margin:0;overflow:hidden}#root,.th-app,.th-chat-pane,.th-chat-main,.th-chat-main-content{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}.th-app{height:100%}';
document.head.append(style);
createRoot(document.getElementById('root')!).render(<I18nContext.Provider value={{lang:'en',setLang:()=>{},font:'system',setFont:()=>{},fontSize:14,setFontSize:()=>{},t:(key,vars)=>translate('en',key,vars)}}><BrowserQa/></I18nContext.Provider>);
