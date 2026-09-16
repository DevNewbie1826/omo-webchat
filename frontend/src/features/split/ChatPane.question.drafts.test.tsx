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
  const button = (label: string) => requireElement([...container.querySelectorAll("button")].find(b => b.textContent === label), label);
  const click = (label: string) => act(() => button(label).click());
  const input = (selector: string, value: string) => act(() => {
    const element = requireElement(container.querySelector<HTMLInputElement>(selector), selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it.each([{ surfaces: [true, false] }, { surfaces: [false, true] }, { surfaces: [true, false, true] }, { surfaces: [false, true, false, true, false] }] as const)(
    "preserves the complete response when surfaces hop through $surfaces", async ({ surfaces }) => {
      // Given a completed first answer, a partial selection, and a panel comment.
      const { deliver, sent } = renderChatPane(root);
      await act(async () => deliver({ ...request, nonBlocking: surfaces[0] }));
      click("A");
      if (!surfaces[0]) { click("Second"); input(".th-approval-question-comment", "keep comment"); }
      click("B");
      // When the same request hops repeatedly and the remaining answers are completed.
      for (const nonBlocking of surfaces.slice(1)) act(() => deliver({ ...request, nonBlocking }));
      expect([...container.querySelectorAll('button[aria-pressed="true"]')].map(element => element.textContent)).toContain("B");
      click("C");
      const inline = surfaces.at(-1);
      if (inline) { click("question.submit"); click("question.answer"); input(".th-question-bar-input", "draft notes"); click("question.submit"); }
      else { click("Notes"); input(".th-approval-question-text", "draft notes"); click("approval.submit"); }
      // Then all answers, including those entered before the hop, use their own keys.
      expect(sent.filter(frame => frame.type === "approval.respond")).toEqual([{
        type: "approval.respond", sessionId: "chat-1", requestId: expect.any(String), id: "moving-draft",
        answers: { first: { selected: ["A"] }, second: { selected: ["B", "C"] }, notes: { text: "draft notes" } },
        ...(!surfaces[0] ? { comment: "keep comment" } : {}),
      }]);
    },
  );

  it("preserves unsubmitted free text and the active question when both surfaces replay", async () => {
    // Given an expanded inline text draft.
    const { deliver } = renderChatPane(root);
    await act(async () => deliver({ ...request, nonBlocking: true }));
    click("A"); click("B"); click("question.submit"); click("question.answer"); input(".th-question-bar-input", "unfinished");
    // When the panel receives it, adds a comment, and hops back and forth.
    act(() => deliver({ ...request, nonBlocking: false }));
    expect(container.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("Notes");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("unfinished");
    input(".th-approval-question-comment", "in progress");
    act(() => deliver({ ...request, nonBlocking: true }));
    act(() => deliver({ ...request, nonBlocking: true }));
    expect(container.querySelector<HTMLInputElement>(".th-question-bar-input")?.value).toBe("unfinished");
    act(() => deliver({ ...request, nonBlocking: false }));
    // Then no draft field or active question was reset.
    expect(container.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("Notes");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("unfinished");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("in progress");
  });

  it.each(["", "   "])("retains explicitly answered blank text %j across a surface hop", async (text) => {
    // Given a blank text answer explicitly completed in the inline bar.
    const { deliver, sent } = renderChatPane(root);
    const blankRequest = { ...request, questions: [{ id: "blank" }, { id: "last", options: [{ label: "Done" }] }] };
    await act(async () => deliver({ ...blankRequest, nonBlocking: true }));
    click("question.answer"); input(".th-question-bar-input", text); click("question.submit");
    // When the panel receives the same request and submits the last answer.
    act(() => deliver({ ...blankRequest, nonBlocking: false }));
    click("Done"); click("approval.submit");
    // Then an explicitly empty answer remains distinguishable from an unanswered question.
    expect(sent.filter(frame => frame.type === "approval.respond").at(-1)).toMatchObject({
      answers: { blank: { text }, last: { selected: ["Done"] } },
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
    }
    act(() => deliver({ ...request, id: action === "replace" ? "new-draft" : request.id, nonBlocking: false }));
    // Then the new lifetime has no answers, comment, active-tab offset, or text.
    expect(button("A").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('.th-approval-question [role="tab"][aria-selected="true"]')?.textContent).toBe("First");
    expect(container.querySelector<HTMLInputElement>(".th-approval-question-comment")?.value).toBe("");
    click("Notes"); expect(container.querySelector<HTMLInputElement>(".th-approval-question-text")?.value).toBe("");
  });
});
