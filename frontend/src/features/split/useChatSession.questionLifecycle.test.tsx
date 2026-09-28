import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector } from "../../lib/chatWs";
import { parseChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = { id: "s", wsId: "w", name: "Chat", cwd: "/work", provider: "omo" } as const;
const question = (id: string, requestId: string, nonBlocking = false) => ({
  type: "approval", sessionId: "s", id, requestId, method: "question", nonBlocking,
  questions: [{ id: "q1", options: [{ label: "A" }] }],
});

let root: Root;
let state: ReturnType<typeof useChatSession>;
let callbacks: Parameters<ChatConnector>[0];
let sent: ChatClientFrame[];
let sendAccepted: boolean;
function deliver(raw: unknown): void {
  const frame = parseChatServerFrame(raw);
  if (!frame) throw new Error("invalid test frame");
  act(() => callbacks.onFrame(frame));
}
function responses(): ChatClientFrame[] {
  return sent.filter(frame => frame.type === "approval.respond");
}
function progress(): ChatClientFrame[] {
  return sent.filter(frame => frame.type === "approval.progress");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  sendAccepted = true;
  const connect: ChatConnector = handlers => {
    callbacks = handlers;
    return { send: frame => { sent.push(frame); return sendAccepted; }, close: () => undefined };
  };
  function Probe() { state = useChatSession(session, connect); return null; }
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains ordered questions, cycles them and replaces a re-issued id in place", () => {
  deliver(question("a", "tool-a"));
  deliver(question("b", "tool-b", true));
  expect(state.pendingQuestions.map(frame => frame.id)).toEqual(["a", "b"]);
  expect(state.shownQuestion?.id).toBe("a");
  expect(state.blockingQuestionPending).toBe(true);
  act(() => state.cycleQuestion());
  expect(state.shownQuestion?.id).toBe("b");
  deliver({ ...question("a2", "tool-a"), delivery: "failed", deliveryError: "unconfirmed" });
  expect(state.pendingQuestions.map(frame => frame.id)).toEqual(["a2", "b"]);
  deliver({ type: "approval.resolved", sessionId: "s", id: "a", outcome: "answered" });
  expect(state.pendingQuestions.map(frame => frame.id)).toEqual(["a2", "b"]);
  deliver({ type: "approval.resolved", sessionId: "s", id: "a2", outcome: "answered" });
  expect(state.pendingQuestions.map(frame => frame.id)).toEqual(["b"]);
  expect(state.blockingQuestionPending).toBe(false);
});

it("keeps a question visible while sending, refuses duplicate sends, and waits for resolution", () => {
  deliver(question("a", "tool-a"));
  let accepted = false;
  act(() => { accepted = state.respondQuestion("a", { answers: { q1: { selected: ["A"] } } }); });
  expect(accepted).toBe(true);
  expect(state.shownQuestion?.delivery).toBe("sending");
  act(() => { accepted = state.respondQuestion("a", { comment: "second" }); });
  expect(accepted).toBe(false);
  expect(responses()).toHaveLength(1);
  const response = responses()[0];
  if (response?.type !== "approval.respond") throw new Error("missing response");
  deliver({ type: "ack", sessionId: "s", command: "extension_ui_response", id: "a", requestId: response.requestId });
  expect(state.shownQuestion?.delivery).toBe("sending");
  deliver({ type: "approval.resolved", sessionId: "s", id: "a", outcome: "answered" });
  expect(state.shownQuestion).toBeNull();
  expect(state.questionEndedSignal).toEqual({ ended: [{ key: "tool-a", id: "a", outcome: "answered" }], seq: 1 });
});

it("restores a rejected write and resends its submitted answer with the current id", () => {
  deliver(question("old", "tool-a"));
  sendAccepted = false;
  act(() => expect(state.respondQuestion("old", { comment: "failed write" })).toBe(false));
  expect(state.shownQuestion?.delivery).toBeUndefined();
  sendAccepted = true;
  deliver({ ...question("new", "tool-a"), delivery: "failed", deliveryError: "unconfirmed",
    submittedAnswer: { answers: { q1: { selected: [] } }, comment: "from composer" } });
  act(() => expect(state.resendQuestion("new")).toBe(true));
  expect(responses().at(-1)).toMatchObject({ id: "new", comment: "from composer", answers: { q1: { selected: [] } } });
  expect(state.pendingQuestions).toHaveLength(1);
});

it("prunes only absent snapshot keys and emits a question-ended signal", () => {
  deliver(question("a", "tool-a"));
  deliver(question("b", "tool-b"));
  deliver({ type: "questions.snapshot", sessionId: "s", ids: ["tool-b"] });
  expect(state.pendingQuestions.map(frame => frame.id)).toEqual(["b"]);
  expect(state.shownQuestion?.id).toBe("b");
  expect(state.questionEndedSignal).toEqual({ ended: [{ key: "tool-a", id: "a" }], seq: 1 });
});

it("sends the latest draft at fixed one-second throttle cadence, then cancels on send", () => {
  vi.useFakeTimers();
  deliver(question("a", "tool-a"));
  const edit = (index: number): void => {
    act(() => state.reportQuestionProgress("a", { answers: { q1: { selected: [], text: `draft-${index}` } } }));
  };
  for (let index = 0; index < 5; index++) {
    edit(index);
    act(() => vi.advanceTimersByTime(300));
  }
  expect(progress()).toEqual([{ type: "approval.progress", sessionId: "s", id: "a",
    answers: { q1: { selected: [], text: "draft-3" } } }]);
  act(() => vi.advanceTimersByTime(700));
  expect(progress()).toEqual([
    { type: "approval.progress", sessionId: "s", id: "a", answers: { q1: { selected: [], text: "draft-3" } } },
    { type: "approval.progress", sessionId: "s", id: "a", answers: { q1: { selected: [], text: "draft-4" } } },
  ]);
  edit(5);
  act(() => expect(state.respondQuestion("a", { comment: "send" })).toBe(true));
  act(() => vi.advanceTimersByTime(1_000));
  expect(progress()).toHaveLength(2);
});
