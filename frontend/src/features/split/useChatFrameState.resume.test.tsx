import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHistoryResumeCoverage, useChatFrameState } from "./useChatFrameState";
import type { ChatServerFrame } from "../../lib/chatWs";
import { parseChatServerFrame } from "../../lib/chatWs";

function entry(id: string) {
 return { type: "message", id, parentId: null, message: { role: "user", content: [{ type: "text", text: id }] } };
}
afterEach(() => vi.unstubAllGlobals());
it("keeps the committed transcript on reconnect resume and merges new entries", () => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 let state!: ReturnType<typeof useChatFrameState>;
 const root = createRoot(document.createElement("div"));
 function Probe() { state = useChatFrameState(); return null; }
 act(() => root.render(<Probe />));
 const deliver = (raw: unknown) => {
  const frame = parseChatServerFrame(raw);
  if (!frame) throw new Error("invalid frame");
  act(() => state.handleFrame(frame));
 };
 try {
  act(() => { state.markOpen(); });
  deliver({type:"entries",sessionId:"s",entries:[entry("a"),entry("b")],final:true,historyComplete:true,historySessionId:"durable"});
  const before = state.messages;
  const restoreVersion = state.restoreVersion;
  expect(before).toHaveLength(2);
  act(() => { state.markClose(); state.markOpen(); });
  deliver({type:"entries",sessionId:"s",entries:[entry("c")],final:true,historyComplete:true,historySessionId:"durable",resume:{sessionId:"durable",firstEntryId:"a",lastEntryId:"b",historyComplete:true}});
  expect(state.messages).toHaveLength(3);
  expect(state.messages.slice(0,2)).toEqual(before);
  expect(state.restoreVersion).toBe(restoreVersion);
  expect(state.getHistoryResume()?.lastEntryId).toBe("c");
  act(() => { state.markClose(); state.markOpen(); });
  deliver({type:"entries",sessionId:"s",entries:[entry("replacement")],final:true,historyComplete:true,historySessionId:"different"});
  expect(state.messages).toHaveLength(1);
  expect(state.getHistoryResume()?.sessionId).toBe("different");
 } finally { act(() => root.unmount()); }
});

it("tracks only committed contiguous coverage through interrupted warm and suffix pages", () => {
 const coverage = createHistoryResumeCoverage();
 const page = (entries: unknown, extra: Partial<Extract<ChatServerFrame, {type:"entries"}>> = {}) => coverage.accept({type:"entries",sessionId:"s",historySessionId:"durable",entries,final:true,historyComplete:false,...extra});
 page([entry("c"),entry("d")], {final:false});
 expect(coverage.cursor()).toBeUndefined();
 coverage.reconnect();
 page([entry("d"),entry("e")]);
 expect(coverage.cursor()).toEqual({sessionId:"durable",firstEntryId:"d",lastEntryId:"e",historyComplete:false});
 page([entry("b"),entry("c")], {segment:"head",final:false});
 const resume = coverage.cursor()!;
 expect(resume.firstEntryId).toBe("b");
 page([entry("f")], {resume,final:false});
 expect(coverage.cursor()).toEqual(resume);
 coverage.reconnect();
 const merged = page([entry("f")], {resume});
 expect(merged.resumed).toBe(true);
 expect(merged.frame.entries).toEqual([entry("b"),entry("c"),entry("d"),entry("e"),entry("f")]);
 page([entry("a")], {segment:"head",final:false,historyComplete:true});
 expect(coverage.cursor()).toEqual({sessionId:"durable",firstEntryId:"a",lastEntryId:"f",historyComplete:true});
 coverage.reset();
 expect(coverage.cursor()).toBeUndefined();
});

it("rejects continuity from another leading range", () => {
 const coverage = createHistoryResumeCoverage();
 coverage.accept({type:"entries",sessionId:"s",historySessionId:"durable",entries:[entry("a")],final:true,historyComplete:true});
 const result = coverage.accept({type:"entries",sessionId:"s",historySessionId:"durable",entries:[entry("x")],final:true,historyComplete:true,resume:{sessionId:"durable",firstEntryId:"wrong",lastEntryId:"a",historyComplete:true}});
 expect(result.resumed).toBe(false);
 expect(coverage.cursor()?.firstEntryId).toBe("x");
});
