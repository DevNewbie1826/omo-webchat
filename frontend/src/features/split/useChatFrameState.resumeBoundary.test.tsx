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

it("replaces the rendered transcript when a head contradicts durable identity", () => harness(({state,deliver,reconnect}) => {
  deliver(page(["c","d"],{historyComplete:false}));
  const resume = state().getHistoryResume();
  expect(resume).toEqual({sessionId:"durable",firstEntryId:"c",lastEntryId:"d",historyComplete:false});
  reconnect();
  deliver(page(["e"],{resume,historyComplete:false}));
  expect(state().getHistoryResume()).toEqual({...resume,lastEntryId:"e"});
  deliver(page(["replacement-root"],{resume,segment:"head",final:false,historySessionId:"different"}));
  expect(state().messages.map(message => message.id)).toEqual(["replacement-root"]);
  expect(state().getHistoryResume()).toEqual({sessionId:"different",firstEntryId:"replacement-root",lastEntryId:"replacement-root",historyComplete:true});
}));

it("replaces coverage when a head contradicts durable identity", () => {
  const coverage = createHistoryResumeCoverage();
  coverage.accept(page(["c","d"],{historyComplete:false}));
  const resume = coverage.cursor();
  expect(resume).toEqual({sessionId:"durable",firstEntryId:"c",lastEntryId:"d",historyComplete:false});
  const accepted = coverage.accept(page(["replacement-root"],{resume,segment:"head",final:false,historySessionId:"different"}));
  expect(accepted.resumed).toBe(false);
  expect(accepted.frame.entries).toEqual([entry("replacement-root")]);
  expect(coverage.entries()).toEqual([entry("replacement-root")]);
  expect(coverage.cursor()).toEqual({sessionId:"different",firstEntryId:"replacement-root",lastEntryId:"replacement-root",historyComplete:true});
});

it("retains entries between shared anchors in authoritative order", () => {
  const coverage = createHistoryResumeCoverage();
  coverage.accept(page(["a","c"]));
  const accepted = coverage.accept(page(["a","b","c","d"],{resume:coverage.cursor()}));
  expect(accepted.resumed).toBe(true);
  expect(accepted.frame.entries).toEqual(["a","b","c","d"].map(id => entry(id)));
});

it("resumes a same-socket subrange echo after REST expanded the committed head", () => harness(({state,deliver}) => {
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  deliver(page(["c","d"],{historyComplete:false}));
  const resume = state().getHistoryResume();
  deliver(page(["a","b"],{segment:"head"}));
  const before = state().messages;
  const restore = state().restoreVersion;
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  deliver(page(["e"],{resume,historyComplete:false}));
  expect(state().messages.map(message => message.id)).toEqual(["a","b","c","d","e"]);
  expect(state().messages.slice(0,4)).toEqual(before);
  expect(state().restoreVersion).toBe(restore);
  expect(state().historyRootKnown).toBe(true);
}));

it("binds transferred live frames before a same-socket resumed page filters duplicate ids", () => harness(({state,deliver}) => {
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  deliver(page(["a","b"]));
  const resume = state().getHistoryResume();
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"c"}});
  deliver({type:"entry.appended",sessionId:"s",id:"c",parentId:"b",role:"user",textPrefix:"c"});
  expect(state().messages.at(-1)?.id).toBe("c");
  deliver(page(["c"],{resume}));
  expect(state().messages.map(message => message.id)).toEqual(["a","b","c"]);
}));

it.each(["before", "after"])("merges a live entry id arriving %s its terminal page", order => harness(({state,deliver}) => {
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  deliver(page(["a","b"]));
  const resume = state().getHistoryResume();
  deliver({type:"ready",sessionId:"s",resumed:true,piSessionId:"durable"});
  if (order === "after") deliver(page(["c"], {resume}));
  deliver({type:"message",sessionId:"s",message:{role:"user",content:"c"}});
  deliver({type:"entry.appended",sessionId:"s",id:"c",parentId:"b",role:"user",textPrefix:"c"});
  if (order === "before") deliver(page(["c"], {resume}));
  expect(state().messages.map(message => message.id)).toEqual(["a","b","c"]);
  // A merged baseline row must not become a live suffix on the next replacement.
  deliver(page(["new-tail"], {historyComplete:false}));
  expect(state().messages.map(message => message.id)).toEqual(["new-tail"]);
}));

it("binds equal-text live messages FIFO, respecting role and Unicode code-point prefixes", () => harness(({state,deliver}) => {
  const text = "\u{1f600}".repeat(127) + "xy";
  deliver(page(["a"]));
  for (const role of ["assistant","user","user"]) {
    deliver({type:"message",sessionId:"s",message:{role,blocks:[
      {kind:"thinking",thinking:"excluded"},
      {kind:"text",text:text.slice(0,100)},
      {kind:"text",text:text.slice(100)},
    ]}});
  }
  const prefix = Array.from(text).slice(0,128).join("");
  deliver({type:"entry.appended",sessionId:"s",id:"first",parentId:"a",role:"user",textPrefix:prefix});
  expect(state().messages.map(message => message.id)).toEqual(["a",undefined,"first",undefined]);
  deliver({type:"entry.appended",sessionId:"s",id:"second",parentId:"first",role:"user",textPrefix:prefix});
  expect(state().messages.map(message => message.id)).toEqual(["a",undefined,"first","second"]);
}));
