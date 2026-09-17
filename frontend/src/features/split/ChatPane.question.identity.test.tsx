import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // The answering surface is the modal window, which portals to document.body.
  const button = (label: string) => requireElement([...document.querySelectorAll("button")].find(b => b.textContent === label), label);
  const click = (label: string) => act(() => button(label).click());
  const input = (selector: string, value: string) => act(() => {
    const element = requireElement(document.querySelector<HTMLInputElement>(selector), selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // A blocking arrival auto-opens its window; a non-blocking question waits
  // in the band. With several pending surfaces the question's band is the one
  // carrying the question count, and its window is the modal that hosts the
  // structured panel.
  const ensureWindowOpen = () => {
    if (document.querySelector(".th-modal .th-approval-question") !== null) return;
    const band = [...document.querySelectorAll(".th-question-band")].find((candidate) =>
      candidate.querySelector(".th-question-band-count") !== null);
    const open = band?.querySelector<HTMLButtonElement>(".th-question-band-open");
    expect(open, "question band Open button").not.toBeNull();
    act(() => open!.click());
  };

  it.each([true, false])("keeps each request independent when question arrives first=%s", (questionFirst) => {
    // Given both pending surfaces, in either arrival order: the approval
    // auto-opens its window, the non-blocking question waits in the band.
    const { deliver, sent } = renderChatPane(root);
    act(() => { for (const frame of questionFirst ? [question, approval] : [approval, question]) deliver(frame); });
    expect(document.querySelector(".th-modal")).not.toBeNull();
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    // When the question is answered through its band-opened window.
    ensureWindowOpen();
    click("Go");
    click("approval.submit");
    // Then only its identity is sent and the approval survives answer, ACK and rollback.
    const response = sent.filter(f => f.type === "approval.respond").at(-1);
    expect(response).toMatchObject({ id: "background", answers: { language: { selected: ["Go"] } } });
    expect(document.querySelector(".th-modal")).not.toBeNull();
    if (!response || response.type !== "approval.respond") throw new Error("missing response");
    const requestId = requireElement(response.requestId, "request id");
    act(() => deliver({ type: "ack", command: "extension_ui_response", id: question.id, requestId }));
    expect(document.querySelector(".th-modal")).not.toBeNull();
    act(() => deliver({ type: "error", command: "extension_ui_response", requestId, message: "rejected" }));
    // The rolled-back question returns to its band (no auto-open), the approval window stays.
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    expect(document.querySelector(".th-modal")).not.toBeNull();
  });

  it.each([true, false])("keeps question pending when approval is denied, question first=%s", (questionFirst) => {
    // Given both pending requests.
    const { deliver, sent } = renderChatPane(root);
    act(() => { for (const frame of questionFirst ? [question, approval] : [approval, question]) deliver(frame); });
    // When approval is denied through its auto-opened window.
    click("approval.deny");
    // Then question survives its sibling's answer, ACK and rollback.
    const response = sent.filter(f => f.type === "approval.respond").at(-1);
    expect(response).toMatchObject({ id: "permission", confirmed: false });
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    if (!response || response.type !== "approval.respond") throw new Error("missing response");
    const requestId = requireElement(response.requestId, "request id");
    act(() => deliver({ type: "ack", command: "extension_ui_response", id: approval.id, requestId }));
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    act(() => deliver({ type: "error", command: "extension_ui_response", requestId, message: "rejected" }));
    // The rolled-back approval auto-opens its window again; the question band stays.
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    expect(document.querySelector(".th-modal")).not.toBeNull();
  });

  it("starts selections clean on replacement but keeps them on replay", () => {
    // Given a selected draft and its replay.
    const { deliver, sent } = renderChatPane(root);
    const multi = { ...question, questions: [{ ...question.questions[0], multiSelect: true }] };
    act(() => deliver(multi)); ensureWindowOpen(); click("Go"); act(() => deliver({ ...multi }));
    expect(button("Go").getAttribute("aria-pressed")).toBe("true");
    // When a different request replaces it.
    act(() => deliver({ ...multi, id: "new", questions: [{ id: "new-choice", multiSelect: true, options: [{ label: "Rust" }, { label: "Swift" }] }] }));
    ensureWindowOpen();
    // Then no stale selection can be sent (the panel's Submit is live; only
    // current picks enter the response).
    expect(button("Rust").getAttribute("aria-pressed")).toBe("false");
    click("Rust"); click("approval.submit");
    expect(sent.filter(f => f.type === "approval.respond").at(-1)).toMatchObject({ id: "new", answers: { "new-choice": { selected: ["Rust"] } } });
  });

  it("starts text clean on replacement but keeps it on replay", () => {
    // Given a text draft and replay.
    const { deliver } = renderChatPane(root);
    const textQuestion = { ...question, questions: [{ id: "notes" }] };
    act(() => deliver(textQuestion)); ensureWindowOpen(); input(".th-approval-question-text", "old draft");
    act(() => deliver({ ...textQuestion }));
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("old draft");
    // When the request identity changes.
    act(() => deliver({ ...textQuestion, id: "new-text" })); ensureWindowOpen();
    // Then the new request has an empty draft.
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("");
  });

  it("keeps every non-blocking question answerable before sending the complete request", () => {
    // Given two non-blocking questions, answered in the band-opened window.
    const { deliver, sent } = renderChatPane(root);
    act(() => deliver({ ...question, questions: [...question.questions, { id: "region", question: "Region", options: [{ label: "EU" }] }] }));
    ensureWindowOpen();
    // When the first question is answered, nothing settles yet: the window
    // panel sends one response for the whole request only on its Submit.
    click("Go");
    expect(sent.filter(f => f.type === "approval.respond")).toHaveLength(0);
    // The remainder stays answerable on its own tab.
    click("Region");
    expect(button("EU")).toBeDefined();
    click("EU");
    click("approval.submit");
    expect(sent.filter(f => f.type === "approval.respond").at(-1)).toMatchObject({ id: "background", answers: { language: { selected: ["Go"] }, region: { selected: ["EU"] } } });
  });

  it("keeps panel selections and comment on collapse without sending", () => {
    // Given a panel draft.
    const { deliver, sent } = renderChatPane(root);
    act(() => deliver({ ...question, nonBlocking: false })); click("Go"); input(".th-approval-question-comment", "keep me");
    // When the window collapses (Escape) and reopens from the band.
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector(".th-modal")).toBeNull();
    expect(container.querySelector(".th-question-band")).not.toBeNull();
    click("approval.band.open");
    // Then the same draft survives and nothing was sent.
    expect(button("Go").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("keep me");
    expect(sent.filter(f => f.type === "approval.respond")).toHaveLength(0);
    act(() => deliver({ ...question, id: "new-panel", nonBlocking: false }));
    expect(button("Go").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("");
  });
});
