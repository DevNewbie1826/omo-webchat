import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";
import { parseChatServerFrame } from "../../lib/chatWsParse";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const click = (label: string) => act(() => requireElement([...container.querySelectorAll("button")].find(b => b.textContent === label), label).click());
const first = { id: "first", header: "First", options: [{ label: "A" }, { label: "B" }] };
const last = { id: "last", header: "Last", multiSelect: true, options: [{ label: "Z" }] };
const request = { type: "approval", sessionId: "chat-1", id: "refresh", method: "question", nonBlocking: false } as const;

it.each([false, true])("retains an invalidation status through refresh and presentation changes (inline=%s)", async inline => {
 // Given answers on two questions with the second currently visible.
 const { deliver, sent } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [first, last] }));
 click("B"); click("Last"); click("Z");
 // An unused option change must leave the selected answer and status alone.
 await act(async () => deliver({ ...request, questions: [{ ...first, options: [{ label: "B" }, { label: "D" }] }, last] }));
 expect(container.querySelector('[role="status"] [data-question-key]')).toBeNull();
 const refreshed = { ...first, options: [{ label: "A" }, { label: "C" }] };
 // When a refresh discards only the first choice and another refresh retains everything.
 await act(async () => deliver({ ...request, nonBlocking: inline, questions: [refreshed, last] }));
 await act(async () => deliver({ ...request, nonBlocking: inline, questions: [refreshed, last] }));
 // Then the affected question alone stays flagged before submission; replacing it clears the status.
 expect([...container.querySelectorAll('[role="status"] [data-question-key]')].map(el => el.getAttribute("data-question-key"))).toEqual([first.id]);
 if (!inline) click("First");
 click("C");
 expect(container.querySelector('[role="status"] [data-question-key]')).toBeNull();
 // Submit lives on the last question: return there before sending.
 if (!inline) click("Last");
 click(inline ? "question.submit" : "approval.submit");
 expect(sent.filter(frame => frame.type === "approval.respond").at(-1)?.answers).toEqual({ first: { selected: ["C"] }, last: { selected: ["Z"] } });
});

const environment = { id: "environment", header: "Environment", multiSelect: true, options: [{ label: "Production" }, { label: "Staging" }] };
const reason = { id: "reason", header: "Reason" };
const inputText = (value: string) => act(() => {
 const input = requireElement(container.querySelector("input"), "answer input");
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
 input.dispatchEvent(new Event("input", { bubbles: true }));
});

it.each([false, true])("names a removed question persistently when a chosen answer is retired (inline=%s)", async inline => {
 // Given an unsent chosen answer.
 const { deliver, sent } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [environment, reason] }));
 click("Production");
 // When the question is removed, including a later no-op/presentation refresh.
 await act(async () => deliver({ ...request, questions: [reason] }));
 await act(async () => deliver({ ...request, nonBlocking: inline, questions: [reason] }));
 // Then its status remains identifiable without sending a response.
 expect([...container.querySelectorAll('[role="status"] [data-question-key]')].map(el => el.getAttribute("data-question-key"))).toEqual([environment.id]);
 expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
});

it("excludes a retired selection when a removed question returns before submission", async () => {
 // Given a selected question removed from the request.
 const { deliver, sent } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [environment, reason] }));
 click("Production");
 await act(async () => deliver({ ...request, questions: [reason] }));
 await act(async () => deliver({ ...request, questions: [environment, reason] }));
 // When submitting without choosing it again (Submit lives on the last question).
 click("Reason");
 click("approval.submit");
 // Then the retired value is absent.
 expect(sent.filter(frame => frame.type === "approval.respond").at(-1)?.answers).toEqual({});
});

it.each(["", "   "])("shows no loss notice when erased text %j becomes options", async empty => {
 // Given text typed and cleared without answering.
 const { deliver } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [reason] }));
 inputText("temporary"); inputText(empty);
 // When the same question becomes a choice.
 await act(async () => deliver({ ...request, questions: [{ ...reason, options: [{ label: "Deploy" }] }] }));
 // Then nothing the user chose was lost.
 expect(container.querySelector('[role="status"] [data-question-key]')).toBeNull();
});

it("names lost text when its question is removed from the request", async () => {
 // Given meaningful text on Environment.
 const { deliver } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [{ id: environment.id, header: environment.header }, reason] }));
 inputText("chosen reason");
 // When the question is removed and its text can no longer be represented.
 await act(async () => deliver({ ...request, questions: [reason] }));
 // Then the affected question has a status.
 expect([...container.querySelectorAll('[role="status"] [data-question-key]')].map(el => el.getAttribute("data-question-key"))).toEqual([environment.id]);
});

it("keeps typed text without a loss notice when its question gains options", async () => {
 // Given meaningful text on Environment.
 const { deliver } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [{ id: environment.id, header: environment.header }, reason] }));
 inputText("chosen reason");
 // When the same question becomes a choice question, its typed text stays
 // representable through the dedicated input under the options.
 await act(async () => deliver({ ...request, questions: [environment, reason] }));
 // Then nothing the user typed was lost and no status is raised.
 expect(container.querySelector('[role="status"] [data-question-key]')).toBeNull();
 expect(container.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("chosen reason");
});

it("keeps one request cancellable when invalidation, an unsent draft, and colliding labels interact", async () => {
 // Given a committed first choice and an unsent multi-selection.
 const { deliver, sent } = renderChatPane(root);
 await act(async () => deliver({ ...request, nonBlocking: true, questions: [first, last] }));
 click("B"); click("Z");
 const refreshed = { ...first, options: [{ label: "C" }] };
 // When the same request refreshes through invalidation and then ambiguity.
 await act(async () => deliver({ ...request, nonBlocking: true, questions: [refreshed, last] }));
 expect([...container.querySelectorAll('[role="status"] [data-question-key]')].map(el => el.getAttribute("data-question-key"))).toEqual([first.id]);
 click("C");
 expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([]);
 await act(async () => deliver(requireElement(parseChatServerFrame({ ...request, nonBlocking: true, questions: [refreshed, {
  ...last, options: [{ label: "Z", description: "first target" }, { label: "Z", description: "second target" }],
 }] }), "parsed ambiguous refresh")));
 expect(container.querySelector(".th-approval-fallback-note")).not.toBeNull();
 click("approval.cancel");
 // Then cancellation is the only transmitted outcome and retains the original identity.
 expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([{
  type: "approval.respond", sessionId: request.sessionId, requestId: expect.any(String), id: request.id, cancelled: true,
 }]);
});
