import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import { parseChatServerFrame } from "../../lib/chatWsParse";
import { parseClientFrame } from "../../lib/contract/types_gen";
import { QuestionWindow } from "./QuestionWindow";
import { approvalRequestOf } from "./chatSessionState";
import { useChatFrameState } from "./useChatFrameState";

const request = {
  type: "approval", sessionId: "s", id: "ask", method: "question",
  questions: [
    { id: "stack", header: "Stack", multiSelect: true, options: [
      { label: "Go", description: "Backend services" },
      { label: "TS", description: "Frontend app" },
    ] },
    { id: "region", header: "Region", multiSelect: false, options: [
      { label: "east", description: "East coast" },
      { label: "west", description: "West coast" },
    ] },
  ],
};
const i18n: I18nValue = {
  lang: "en", setLang: () => undefined, font: "system", setFont: () => undefined,
  fontSize: 13, setFontSize: () => undefined,
  t: (key, vars) => key === "approval.remaining" ? String(vars?.["seconds"]) : key,
};

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function mountPaneState() {
  let state: ReturnType<typeof useChatFrameState>;
  const respond = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    state = useChatFrameState();
    const pending = state.pendingQuestion;
    return pending && <QuestionWindow
      request={approvalRequestOf({ ...pending, method: "question" })}
      open
      onCollapse={() => undefined}
      onRespond={(answer) => respond(parseClientFrame({ type: "approval.respond", sessionId: pending.sessionId, id: pending.id, ...answer }))}
    />;
  }
  act(() => root.render(<I18nContext.Provider value={i18n}><Probe /></I18nContext.Provider>));
  function click(selector: string, index = 0) {
    const button = document.querySelectorAll<HTMLButtonElement>(selector)[index];
    if (!button) throw new Error(`Missing button: ${selector}[${index}]`);
    act(() => button.click());
  }
  return {
    get state() { return state!; }, container, respond,
    deliver(raw: unknown) {
      const frame = parseChatServerFrame(raw);
      expect(frame).not.toBeNull();
      if (frame === null) throw new Error("Rejected lifecycle frame");
      act(() => state.handleFrame(frame));
    },
    answer() {
      click(".th-approval-question-option", 0);
      click(".th-approval-question-option", 1);
      click('[role="tab"]', 1);
      click(".th-approval-question-option", 1);
      const submit = Array.from(document.querySelectorAll<HTMLButtonElement>(".th-approval-question-actions button"))
        .find(button => button.textContent === "approval.submit");
      if (!submit) throw new Error("Missing submit button");
      act(() => submit.click());
      expect(respond).toHaveBeenCalledExactlyOnceWith({
        type: "approval.respond", sessionId: "s", id: "ask",
        answers: { stack: { selected: ["Go", "TS"] }, region: { selected: ["west"] } },
      });
    },
    dispose() { act(() => root.unmount()); container.remove(); },
  };
}

it("replays an intact structured request after reconnect and remains answerable", () => {
  const pane = mountPaneState();
  try {
    act(() => { pane.state.markOpen(); });
    pane.deliver(request);
    expect(pane.state.pendingQuestion).toEqual(request);
    expect(pane.respond).not.toHaveBeenCalled();
    act(() => pane.state.markClose());
    act(() => { pane.state.markOpen(); });
    pane.deliver(JSON.parse(JSON.stringify(request)));
    expect(pane.state.pendingQuestion).toEqual(request);
    expect(pane.state.pendingApproval).toBeNull();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    pane.answer();
  } finally { pane.dispose(); }
});

it("ignores a mismatched acknowledgement and clears a structured request answered by another client", () => {
  const pane = mountPaneState();
  try {
    pane.deliver(request);
    pane.deliver({ type: "ack", sessionId: "s", command: "extension_ui_response", id: "different", requestId: "other-client-1" });
    expect(pane.state.pendingQuestion).toEqual(request);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    pane.deliver({ type: "ack", sessionId: "s", command: "extension_ui_response", id: "ask", requestId: "other-client-2" });
    expect(pane.state.pendingQuestion).toBeNull();
    expect(document.querySelector(".th-modal")).toBeNull();
    expect(pane.respond).not.toHaveBeenCalled();
  } finally { pane.dispose(); }
});

it("replaces a structured deadline refresh in pane state and the rendered countdown", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const pane = mountPaneState();
  try {
    pane.deliver({ ...request, deadlineAtMs: 1_005_000, remainingMs: 5_000 });
    expect(document.querySelector(".th-question-window-countdown")?.textContent).toBe("5");
    pane.deliver({ ...request, deadlineAtMs: 1_020_000, remainingMs: 20_000 });
    expect(pane.state.pendingQuestion).toEqual({ ...request, deadlineAtMs: 1_020_000, remainingMs: 20_000 });
    expect(document.querySelector(".th-question-window-countdown")?.textContent).toBe("20");
    expect(pane.respond).not.toHaveBeenCalled();
  } finally { pane.dispose(); }
});

it("renders and answers a structured request without deadline fields", () => {
  const pane = mountPaneState();
  try {
    pane.deliver(request);
    expect(pane.state.pendingQuestion).not.toHaveProperty("deadlineAtMs");
    expect(pane.state.pendingQuestion).not.toHaveProperty("remainingMs");
    expect(document.querySelector(".th-question-window-countdown")).toBeNull();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    pane.answer();
  } finally { pane.dispose(); }
});
