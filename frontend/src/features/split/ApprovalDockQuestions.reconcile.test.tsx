import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderChatPane, requireElement } from "./chatPaneTestHarness";
import { QuestionDraftProvider, useApprovalQuestionDraft } from "./ApprovalDockQuestions";
import type { Question } from "../../lib/contract/types_gen";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => requireElement([...container.querySelectorAll("button")].find(b => b.textContent === label), label);
const click = (label: string) => act(() => button(label).click());
const question = { id: "target", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] };
const request = { type: "approval", sessionId: "chat-1", id: "refresh", method: "question", nonBlocking: false } as const;

it.each(["options", "single", "text", "removed"])("reconciles preserved drafts when refreshed: %s", async scenario => {
 // Given a live panel containing a draft.
 const { deliver, sent } = renderChatPane(root);
 await act(async () => deliver({ ...request, questions: [scenario === "text" ? { id: "target" } : question] }));
 if (scenario === "text") act(() => {
  const input = requireElement(container.querySelector("input"), "text input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "obsolete");
  input.dispatchEvent(new Event("input", { bubbles: true }));
 });
 else { click("Red"); if (scenario === "single") click("Blue"); }
 // When the same request changes its questions or their shape.
 if (scenario === "removed") act(() => deliver({ ...request, questions: [{ ...question, id: "replacement" }] }));
 const refreshed = scenario === "options" ? { ...question, options: [{ label: "Blue" }, { label: "Green" }] } : { ...question, multiSelect: scenario !== "single" };
 act(() => deliver({ ...request, nonBlocking: scenario === "options", questions: [refreshed] }));
 if (scenario !== "single") click("Blue");
 click(scenario === "options" ? "question.submit" : "approval.submit");
 // Then only valid selections are sent; single-select keeps the first valid
 // choice. A typed draft survives a refresh that turns the question into a
 // choice question as that question's own free-text answer (the dedicated
 // input under the options), so selected and text may coexist.
 expect(sent.filter(frame => frame.type === "approval.respond").at(-1)?.answers).toEqual({ target: {
  selected: [scenario === "single" ? "Red" : "Blue"],
  ...(scenario === "text" ? { text: "obsolete" } : {}),
 } });
});

it("bounds retained entries when a live request replaces its question thirty times", () => {
 // Given a consumer that writes into the real request-owned store.
 let retained = 0;
 function Consumer({ request: current }: { readonly request: { readonly questions: readonly Question[] } }) {
  const [draft, setDraft] = useApprovalQuestionDraft("refresh");
  retained = draft.answers.size;
  return <button onClick={() => setDraft({ ...draft, answers: new Map(draft.answers).set(current.questions[0]?.id ?? "", { selected: ["Red"], text: "", completed: false }) })}>pick</button>;
 }
 // When only one question remains current through thirty replacements.
 for (let index = 0; index < 30; index++) {
  act(() => root.render(<QuestionDraftProvider requestId="refresh"><Consumer request={{ questions: [{ ...question, id: `q-${index}` }] }} /></QuestionDraftProvider>));
  click("pick");
 }
 // Then retained storage is bounded by the current question count.
 expect(retained).toBe(1);
});
