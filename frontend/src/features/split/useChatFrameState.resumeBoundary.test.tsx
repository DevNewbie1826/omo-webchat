import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createHistoryResumeCoverage, useChatFrameState } from "./useChatFrameState";
import { parseChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";

const entry = (id: string, parentId: string | null = null) => ({type:"message", id, parentId, message:{role:"user",content:[{type:"text",text:id}]}});
afterEach(() => vi.unstubAllGlobals());
function harness(run: (api: { state: () => ReturnType<typeof useChatFrameState>; deliver: (raw: unknown) => void; reconnect: () => void; }) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let state!: ReturnType<typeof useChatFrameState>;
  let generation = 0;
  const root = createRoot(document.createElement("div"));
  function Probe() { state = useChatFrameState(); return null; }
  act(() => root.render(<Probe />));
  const deliver = (raw: unknown) => {
    const frame = parseChatServerFrame(raw);
    if (!frame) throw new Error("invalid frame");
    act(() => state.handleFrame(frame, generation));
  };
  const reconnect = () => { act(() => { state.markClose(); generation = state.markOpen(); }); };
  try {
    act(() => { generation = state.markOpen(); });
    run({state: () => state, deliver, reconnect});
  } finally { act(() => root.unmount()); }
}
const page = (ids: string[], extra = {}) => ({type:"entries" as const,sessionId:"s",historySessionId:"durable",entries:ids.map(id => entry(id)),final:true,historyComplete:true,...extra});

it("review: coalesces a pre-disconnect live receipt with its persisted resumed suffix", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b"]));
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"c"}});
  expect(state().messages.map(messageText)).toEqual(["a","b","c"]);
  const resume = state().getHistoryResume();
  reconnect();
  deliver(page(["c"],{resume}));
  expect(state().messages.map(messageText)).toEqual(["a","b","c"]);
}));

it("review: discards a pre-disconnect live receipt from a switched-away branch", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b"]));
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"old-branch-c"}});
  const resume = state().getHistoryResume();
  reconnect();
  deliver(page(["new-branch-c"],{resume}));
  expect(state().messages.map(messageText)).toEqual(["a","b","new-branch-c"]);
}));

it.each([false,true])("review: coalesces overlap at the raw resume seam (paged=%s)", (paged) => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b"]));
  const resume = state().getHistoryResume();
  reconnect();
  if (paged) {
    deliver(page(["b"],{resume,final:false,historyComplete:false}));
    deliver(page(["c"],{resume}));
  } else deliver(page(["b","c"],{resume}));
  expect(state().messages.map(message => message.id)).toEqual(["a","b","c"]);
}));

it("review: rejects a matching echo paired with a different durable frame identity", () => {
  const coverage = createHistoryResumeCoverage();
  coverage.accept(page(["a","b"]));
  const accepted = coverage.accept(page(["x"],{resume:coverage.cursor(),historySessionId:"different"}));
  expect(accepted.resumed).toBe(false);
  expect(accepted.frame.entries).toEqual([entry("x")]);
});

it("review: multi-page growth plus head warming stays ordered and advances coverage", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["c","d"],{historyComplete:false}));
  const restore = state().restoreVersion;
  const resume = state().getHistoryResume();
  reconnect();
  deliver(page(["e"],{resume,final:false,historyComplete:false}));
  deliver(page(["f"],{resume,historyComplete:false}));
  deliver(page(["b"],{resume,segment:"head",final:false,historyComplete:false}));
  deliver(page(["a"],{resume,segment:"head",final:false}));
  expect(state().messages.map(messageText)).toEqual(["a","b","c","d","e","f"]);
  expect(state().restoreVersion).toBe(restore);
  expect(state().getHistoryResume()).toEqual({sessionId:"durable",firstEntryId:"a",lastEntryId:"f",historyComplete:true});
}));

it("review: a missing echo replaces instead of preserving pre-disconnect live receipts", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b"]));
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"old-c"}});
  reconnect();
  deliver(page(["x"],{historySessionId:"different"}));
  expect(state().messages.map(messageText)).toEqual(["x"]);
}));


it("preserves post-open repeated prompts without text deduplication", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b"]));
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"c"}});
  const resume = state().getHistoryResume();
  reconnect();
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"c"}});
  deliver(page(["c"],{resume}));
  expect(state().messages.map(messageText)).toEqual(["a","b","c","c"]);
}));

it("coalesces IDs across suffix pages and overlapping head coverage", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["c","d"],{historyComplete:false}));
  const resume = state().getHistoryResume();
  reconnect();
  deliver(page(["d","e"],{resume,final:false,historyComplete:false}));
  deliver(page(["e","f"],{resume,historyComplete:false}));
  deliver(page(["a","b","c"],{segment:"head",final:false}));
  expect(state().messages.map(message => message.id)).toEqual(["a","b","c","d","e","f"]);
  expect(state().getHistoryResume()).toEqual({sessionId:"durable",firstEntryId:"a",lastEntryId:"f",historyComplete:true});
}));

it("replaces coverage when overlapping anchors reverse branch order", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["a","b","c"]));
  const resume = state().getHistoryResume();
  const restore = state().restoreVersion;
  reconnect();
  deliver(page(["c","b","d"],{resume}));
  expect(state().messages.map(message => message.id)).toEqual(["c","b","d"]);
  expect(state().restoreVersion).toBe(restore + 1);
}));

it("retains entries between shared anchors in authoritative order", () => {
  const coverage = createHistoryResumeCoverage();
  coverage.accept(page(["a","c"]));
  const accepted = coverage.accept(page(["a","b","c","d"],{resume:coverage.cursor()}));
  expect(accepted.resumed).toBe(true);
  expect(accepted.frame.entries).toEqual(["a","b","c","d"].map(id => entry(id)));
});
