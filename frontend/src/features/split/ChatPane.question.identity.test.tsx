import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatServerFrame } from "../../lib/chatWs";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";

const approval = { type: "approval", sessionId: "chat-1", id: "permission", method: "confirm" } as const;
const question = { type: "approval", sessionId: "chat-1", id: "background", method: "question", nonBlocking: true,
  questions: [{ id: "language", question: "Language", options: [{ label: "Go" }, { label: "Python" }] }] } as const;

describe("question request ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const button = (label: string) => requireElement([...container.querySelectorAll("button")].find(b => b.textContent === label), label);
  const click = (label: string) => act(() => button(label).click());
  const input = (selector: string, value: string) => act(() => {
    const element = requireElement(container.querySelector<HTMLInputElement>(selector), selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it.each([true, false])("keeps each request independent when question arrives first=%s", (questionFirst) => {
    // Given both pending surfaces, in either arrival order.
    const { deliver, sent } = renderChatPane(root);
    act(() => { for (const frame of questionFirst ? [question, approval] : [approval, question]) deliver(frame); });
    // When the question is answered.
    click("Go");
    // Then only its identity is sent and the approval survives answer, ACK and rollback.
    const response = sent.filter(f => f.type === "approval.respond").at(-1);
    expect(response).toMatchObject({ id: "background", answers: { language: { selected: ["Go"] } } });
    expect(container.querySelector(".th-approval-dock")).not.toBeNull();
    if (!response || response.type !== "approval.respond") throw new Error("missing response");
    const requestId = requireElement(response.requestId, "request id");
    act(() => deliver({ type: "ack", command: "extension_ui_response", id: question.id, requestId }));
    expect(container.querySelector(".th-approval-dock")).not.toBeNull();
    act(() => deliver({ type: "error", command: "extension_ui_response", requestId, message: "rejected" }));
    expect(container.querySelector(".th-question-bar")).not.toBeNull();
    expect(container.querySelector(".th-approval-dock")).not.toBeNull();
  });

  it.each([true, false])("keeps question pending when approval is denied, question first=%s", (questionFirst) => {
    // Given both pending requests.
    const { deliver, sent } = renderChatPane(root);
    act(() => { for (const frame of questionFirst ? [question, approval] : [approval, question]) deliver(frame); });
    // When approval is denied.
    click("approval.deny");
    // Then question survives its sibling's answer, ACK and rollback.
    const response = sent.filter(f => f.type === "approval.respond").at(-1);
    expect(response).toMatchObject({ id: "permission", confirmed: false });
    expect(container.querySelector(".th-question-bar")).not.toBeNull();
    if (!response || response.type !== "approval.respond") throw new Error("missing response");
    const requestId = requireElement(response.requestId, "request id");
    act(() => deliver({ type: "ack", command: "extension_ui_response", id: approval.id, requestId }));
    expect(container.querySelector(".th-question-bar")).not.toBeNull();
    act(() => deliver({ type: "error", command: "extension_ui_response", requestId, message: "rejected" }));
    expect(container.querySelector(".th-question-bar")).not.toBeNull();
    expect(container.querySelector(".th-approval-dock")).not.toBeNull();
  });

  it("starts selections clean on replacement but keeps them on replay", () => {
    // Given a selected draft and its replay.
    const { deliver, sent } = renderChatPane(root);
    const multi = { ...question, questions: [{ ...question.questions[0], multiSelect: true }] };
    act(() => deliver(multi)); click("Go"); act(() => deliver({ ...multi }));
    expect(button("Go").getAttribute("aria-pressed")).toBe("true");
    // When a different request replaces it.
    act(() => deliver({ ...multi, id: "new", questions: [{ id: "new-choice", multiSelect: true, options: [{ label: "Rust" }, { label: "Swift" }] }] }));
    // Then no stale selection can be sent.
    expect(button("question.submit").disabled).toBe(true);
    click("Rust"); click("question.submit");
    expect(sent.filter(f => f.type === "approval.respond").at(-1)).toMatchObject({ id: "new", answers: { "new-choice": { selected: ["Rust"] } } });
  });

  it("starts text clean on replacement but keeps it on replay", () => {
    // Given a text draft and replay.
    const { deliver } = renderChatPane(root);
    const textQuestion: ChatServerFrame = { ...question, questions: [{ id: "notes" }] };
    act(() => deliver(textQuestion)); click("question.answer"); input(".th-question-bar-input", "old draft");
    act(() => deliver({ ...textQuestion }));
    expect(container.querySelector<HTMLInputElement>(".th-question-bar-input")?.value).toBe("old draft");
    // When the request identity changes.
    act(() => deliver({ ...textQuestion, id: "new-text" })); click("question.answer");
    // Then the new request has an empty draft.
    expect(container.querySelector<HTMLInputElement>(".th-question-bar-input")?.value).toBe("");
  });

  it("keeps every non-blocking question answerable before sending the complete request", () => {
    // Given two non-blocking questions.
    const { deliver, sent } = renderChatPane(root);
    act(() => deliver({ ...question, questions: [...question.questions, { id: "region", question: "Region", options: [{ label: "EU" }] }] }));
    // When the first question is answered.
    click("Go");
    // Then the remainder stays pending, with no partial settlement.
    expect(sent.filter(f => f.type === "approval.respond")).toHaveLength(0);
    expect(button("EU")).toBeDefined();
    click("EU");
    expect(sent.filter(f => f.type === "approval.respond").at(-1)).toMatchObject({ id: "background", answers: { language: { selected: ["Go"] }, region: { selected: ["EU"] } } });
  });

  it("keeps panel selections and comment on collapse without sending", () => {
    // Given a panel draft.
    const { deliver, sent } = renderChatPane(root);
    act(() => deliver({ ...question, nonBlocking: false })); click("Go"); input(".th-approval-question-comment", "keep me");
    // When the panel collapses and re-expands.
    act(() => button("Go").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    click("approval.expand");
    // Then the same draft survives and nothing was sent.
    expect(button("Go").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("keep me");
    expect(sent.filter(f => f.type === "approval.respond")).toHaveLength(0);
    act(() => deliver({ ...question, id: "new-panel", nonBlocking: false }));
    expect(button("Go").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("");
  });
});
