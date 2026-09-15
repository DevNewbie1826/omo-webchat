import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector } from "../../lib/chatWs";
import { parseChatServerFrame } from "../../lib/chatWsParse";
import { useChatSession } from "./useChatSession";

const session = { id: "ownership-approval", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const question = (id: string, nonBlocking = false) => ({ type: "approval", sessionId: session.id, id, method: "question", nonBlocking,
  questions: [{ id: "choice", options: [{ label: "Go" }] }] });
const fallback = (id: string, nonBlocking = false) => ({ ...question(id, nonBlocking), questions: [] });
let root: Root;
let state: ReturnType<typeof useChatSession>;
let handlers: Parameters<ChatConnector>[0];
let sent: ChatClientFrame[];
const deliver = (raw: unknown) => {
  const frame = parseChatServerFrame(raw);
  if (!frame) throw new Error("Invalid test frame");
  act(() => handlers.onFrame(frame));
};
const answer = (structured: boolean) => {
  act(() => expect(structured ? state.respondQuestion({ answers: { choice: { selected: ["Go"] } } }) : state.respondApproval({ cancelled: true })).toBe(true));
  const response = sent.at(-1);
  if (response?.type !== "approval.respond") throw new Error("Missing response");
  return response;
};
const reject = (requestId: string | undefined) => deliver({ type: "error", sessionId: session.id, command: "extension_ui_response", requestId, message: "Rejected" });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  const connect: ChatConnector = callbacks => {
    handlers = callbacks;
    return { send: frame => { sent.push(frame); return true; }, close: () => undefined };
  };
  function Probe() { state = useChatSession(session, connect); return null; }
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it.each([false, true])("restores only the latest request when both sends fail, structured=%s", structured => {
  // Given two successive answered requests on the same surface.
  deliver(structured ? question("old") : fallback("old"));
  const old = answer(structured);
  deliver(structured ? question("new") : fallback("new"));
  const latest = answer(structured);
  // When the obsolete response fails before the latest response.
  reject(old.requestId); reject(latest.requestId);
  // Then only the latest request is restored and remains answerable.
  expect((structured ? state.pendingQuestion : state.pendingApproval)?.id).toBe("new");
  expect(answer(structured).id).toBe("new");
});

it.each([false, true].flatMap(nonBlocking => [false, true].map(structuredFirst => ({ nonBlocking, structuredFirst }))))(
  "replaces the same id atomically, nonBlocking=$nonBlocking structuredFirst=$structuredFirst", ({ nonBlocking, structuredFirst }) => {
    // Given an existing representation.
    deliver(structuredFirst ? question("same", nonBlocking) : fallback("same", nonBlocking));
    // When the same id arrives with a different shape.
    deliver(structuredFirst ? fallback("same", nonBlocking) : question("same", nonBlocking));
    // Then precisely the replacement remains answerable.
    expect(structuredFirst ? state.pendingQuestion : state.pendingApproval).toBeNull();
    expect((structuredFirst ? state.pendingApproval : state.pendingQuestion)?.id).toBe("same");
    expect(answer(!structuredFirst).id).toBe("same");
  },
);

it.each([false, true])("does not restore an obsolete shape after a replacement, structuredFirst=%s", structuredFirst => {
  // Given an answered request and a newer shape with the same id.
  deliver(structuredFirst ? question("same") : fallback("same"));
  const old = answer(structuredFirst);
  deliver(structuredFirst ? fallback("same") : question("same"));
  // When the obsolete send fails.
  reject(old.requestId);
  // Then the obsolete surface stays retired and the new representation can send.
  expect(structuredFirst ? state.pendingQuestion : state.pendingApproval).toBeNull();
  expect(answer(!structuredFirst).id).toBe("same");
});

it.each([false, true])("keeps a replacement answerable while its obsolete shape is in flight, structuredFirst=%s", structuredFirst => {
  // Given an answered request replaced by a different shape of the same id.
  deliver(structuredFirst ? question("same") : fallback("same"));
  const old = answer(structuredFirst);
  deliver(structuredFirst ? fallback("same") : question("same"));
  // When the replacement is answered before either response settles.
  const latest = answer(!structuredFirst);
  reject(old.requestId); reject(latest.requestId);
  // Then only the latest shape returns and can be answered again.
  expect(structuredFirst ? state.pendingQuestion : state.pendingApproval).toBeNull();
  expect(answer(!structuredFirst).id).toBe("same");
});

it.each([false, true])("rolls back distinct surfaces independently, structuredFails=%s", structuredFails => {
  // Given independently answered requests on each surface.
  deliver(question("question")); deliver(fallback("fallback"));
  const structured = answer(true), plain = answer(false);
  // When only one send fails.
  reject((structuredFails ? structured : plain).requestId);
  // Then only that request returns.
  expect(state.pendingQuestion?.id ?? null).toBe(structuredFails ? "question" : null);
  expect(state.pendingApproval?.id ?? null).toBe(structuredFails ? null : "fallback");
});
