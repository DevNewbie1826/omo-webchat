import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";

const request = {
  type: "approval", sessionId: "chat-1", id: "moving-draft", method: "question",
  questions: [
    { id: "first", header: "First", question: "First", options: [{ label: "A" }] },
    { id: "second", header: "Second", question: "Second", multiSelect: true, options: [{ label: "B" }, { label: "C" }] },
    { id: "notes", header: "Notes", question: "Notes" },
  ],
} as const;

describe("request-owned question drafts", () => {
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
  // A blocking arrival auto-opens the window; a non-blocking one leaves it
  // to the band. Same-id presentation hops keep the window's open state, so
  // the helper only opens when it is actually closed.
  const ensureWindowOpen = () => {
    if (document.querySelector(".th-modal") === null) click("approval.band.open");
    expect(document.querySelector(".th-modal")).not.toBeNull();
  };

  it("keeps each pending request's selection, text, and comment through A-B-A cycling", async () => {
    const { deliver, sent } = renderChatPane(root);
    const alpha = { ...request, id: "alpha", requestId: "tool-alpha", nonBlocking: true,
      questions: [{ id: "choice", question: "Alpha", options: [{ label: "A" }, { label: "B" }] }] };
    const beta = { ...request, id: "beta", requestId: "tool-beta", nonBlocking: true,
      questions: [{ id: "other", question: "Beta", options: [{ label: "C" }] }] };
    act(() => { deliver(alpha); deliver(beta); });
    ensureWindowOpen();
    click("A");
    input(".th-approval-question-text", "retained own answer");
    input(".th-approval-question-comment", "retained comment");

    act(() => requireElement(document.querySelector<HTMLButtonElement>(".th-modal .th-question-pending-next"), "next question").click());
    ensureWindowOpen();
    expect(document.querySelector(".th-approval-question-text-prompt")?.textContent).toBe("Beta");
    act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-question-band .th-question-pending-next"), "cycle back").click());
    ensureWindowOpen();

    expect(button("A").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("retained own answer");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("retained comment");
    click("approval.submit");
    expect(sent.filter(frame => frame.type === "approval.respond").at(-1)).toMatchObject({
      id: "alpha",
      answers: { choice: { selected: ["A"], text: "retained own answer" } },
      comment: "retained comment",
    });
  });

  it("clears only the ended request while retaining another pending question's draft", () => {
    const { deliver } = renderChatPane(root);
    const alpha = { ...request, id: "alpha", requestId: "tool-alpha", nonBlocking: true,
      questions: [{ id: "choice", options: [{ label: "A" }] }] };
    const beta = { ...request, id: "beta", requestId: "tool-beta", nonBlocking: true,
      questions: [{ id: "choice", options: [{ label: "B" }] }] };
    act(() => { deliver(alpha); deliver(beta); });
    ensureWindowOpen();
    click("A");
    act(() => requireElement(document.querySelector<HTMLButtonElement>(".th-modal .th-question-pending-next"), "next question").click());
    ensureWindowOpen();
    click("B");

    act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: alpha.id, outcome: "answered" }));
    expect(button("B").getAttribute("aria-pressed")).toBe("true");
    act(() => deliver(alpha));
    expect(button("B").getAttribute("aria-pressed")).toBe("true");
    act(() => requireElement(document.querySelector<HTMLButtonElement>(".th-modal .th-question-pending-next"), "reissued question").click());
    ensureWindowOpen();
    expect(button("A").getAttribute("aria-pressed")).toBe("false");
  });

  it.each([{ surfaces: [true, false] }, { surfaces: [false, true] }, { surfaces: [true, false, true] }, { surfaces: [false, true, false, true, false] }] as const)(
    "preserves the complete response when surfaces hop through $surfaces", async ({ surfaces }) => {
      // Given a completed first answer, a partial selection, and a panel comment.
      const { deliver, sent } = renderChatPane(root);
      await act(async () => deliver({ ...request, nonBlocking: surfaces[0] }));
      ensureWindowOpen();
      click("A");
      // The window keeps one tab per question: walk to the question being
      // answered (the retired bar auto-advanced; the panel keeps the user's tab).
      click("Second");
      if (!surfaces[0]) { input(".th-approval-question-comment", "keep comment"); }
      click("B");
      // When the same request hops repeatedly and the remaining answers are completed.
      for (const nonBlocking of surfaces.slice(1)) act(() => deliver({ ...request, nonBlocking }));
      ensureWindowOpen();
      expect([...document.querySelectorAll('button[aria-pressed="true"]')].map(element => element.textContent)).toContain("B");
      click("C");
      click("Notes"); input(".th-approval-question-text", "draft notes");
      click("approval.submit");
      // Then all answers, including those entered before the hop, use their own keys.
      expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([{
        type: "approval.respond", sessionId: "chat-1", requestId: expect.any(String), id: "moving-draft",
        answers: { first: { selected: ["A"] }, second: { selected: ["B", "C"] }, notes: { selected: [], text: "draft notes" } },
        ...(!surfaces[0] ? { comment: "keep comment" } : {}),
      }]);
    },
  );

  it("preserves unsubmitted free text and the active question when both surfaces replay", async () => {
    // Given panel answers on a non-blocking request, entered through the
    // band-opened window.
    const { deliver } = renderChatPane(root);
    await act(async () => deliver({ ...request, nonBlocking: true }));
    ensureWindowOpen();
    click("A"); click("Second"); click("B"); click("Notes"); input(".th-approval-question-text", "unfinished");
    // When the same request replays across blocking/non-blocking presentations.
    act(() => deliver({ ...request, nonBlocking: false }));
    expect(document.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("Notes");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("unfinished");
    input(".th-approval-question-comment", "in progress");
    act(() => deliver({ ...request, nonBlocking: true }));
    act(() => deliver({ ...request, nonBlocking: true }));
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("unfinished");
    act(() => deliver({ ...request, nonBlocking: false }));
    // Then no draft field or active question was reset by any hop.
    expect(document.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("Notes");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("unfinished");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("in progress");
  });

  it("preserves a local draft across a new dialog id for the same requestId", async () => {
    const { deliver, sent } = renderChatPane(root);
    const first = { ...request, id: "dialog-old", requestId: "tool-stable" };
    await act(async () => deliver(first));
    click("A"); click("Notes"); input(".th-approval-question-text", "my draft");
    // When omo reissues the dialog for the same tool request.
    act(() => deliver({ ...first, id: "dialog-new", delivery: "failed", deliveryError: "unconfirmed",
      submittedAnswer: { answers: { first: { selected: [] } }, comment: "older submission" } }));
    // Then the local draft wins and the response targets the current dialog id.
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("my draft");
    click("approval.submit");
    expect(sent.filter(frame => frame.type === "approval.respond").at(-1)).toMatchObject({
      id: "dialog-new", answers: { first: { selected: ["A"] }, notes: { selected: [], text: "my draft" } },
    });
  });

  it("restores a composer-submitted comment into an empty draft on failed replay", async () => {
    const { deliver } = renderChatPane(root);
    await act(async () => deliver({ ...request, id: "replay", requestId: "tool-replay",
      delivery: "failed", deliveryError: "unconfirmed",
      submittedAnswer: { answers: {}, comment: "from composer" } }));
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("from composer");
  });

  const clickTab = (index: number) => act(() => {
    requireElement(document.querySelectorAll<HTMLButtonElement>('.th-modal .th-approval-question-tabs [role="tab"]')[index], `tab ${index}`).click();
  });

  it.each(["", "   "])("omits erased blank text %j from the payload (the window panel's blank contract)", async (text) => {
    // Given a blank answer typed and erased again before submission.
    const { deliver, sent } = renderChatPane(root);
    const blankRequest = { ...request, id: "blank-draft", questions: [{ id: "blank" }, { id: "last", options: [{ label: "Done" }] }] };
    await act(async () => deliver({ ...blankRequest, nonBlocking: true }));
    ensureWindowOpen();
    input(".th-approval-question-text", "temporary"); input(".th-approval-question-text", text);
    // When the same request settles and the remaining answer is submitted.
    act(() => deliver({ ...blankRequest, nonBlocking: false }));
    clickTab(1);
    click("Done"); click("approval.submit");
    // Then the erased answer is indistinguishable from an unanswered question:
    // the explicit-blank-answer affordance belonged to the retired one-line
    // bar's per-question Send; the window panel submits live draft text, and
    // blank text is omitted from the response (questionDraftResponse).
    expect(sent.filter(frame => frame.type === "approval.respond").at(-1)).toMatchObject({
      answers: { last: { selected: ["Done"] } },
    });
  });

  it.each(["replace", "settle"] as const)("starts clean when a request is %s", async (action) => {
    // Given a panel draft that has crossed surfaces.
    const { deliver } = renderChatPane(root);
    await act(async () => deliver({ ...request, nonBlocking: false }));
    click("A"); input(".th-approval-question-comment", "old comment"); click("Notes"); input(".th-approval-question-text", "old text");
    act(() => deliver({ ...request, nonBlocking: true }));
    // When identity changes, or the old request settles and is delivered anew.
    if (action === "settle") {
      act(() => deliver({ ...request, nonBlocking: false })); click("approval.cancel");
      // IS-6: only engine resolution ends this draft's lifetime, not Send.
      act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: request.id, outcome: "cancelled" }));
    } else {
      // IS-7: a new id queues behind the old question until that one resolves.
      act(() => deliver({ type: "approval.resolved", sessionId: "chat-1", id: request.id, outcome: "answered" }));
    }
    act(() => deliver({ ...request, id: action === "replace" ? "new-draft" : request.id, nonBlocking: false }));
    // Then the new lifetime has no answers, comment, active-tab offset, or text.
    expect(button("A").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("First");
    expect(document.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("");
    click("Notes"); expect(document.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("");
  });
});
