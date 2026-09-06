import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { messageText } from "./chatEntries";
import { useChatSession } from "./useChatSession";
import { ChatComposer } from "./ChatComposer";
import { setTextareaValue, i18n, ControlledResizeObserver } from "./chatPaneTestHarness";
import { I18nContext } from "../../i18n";
import { ChatPane } from "./ChatPane";
import { SessionDraftProvider } from "./sessionDraft";
import type { ChatSessionRef } from "../workspace/workspace";

const session = { id: "canonical", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
type Send = Extract<ChatClientFrame, { type: "chat.send" }>;
describe("canonical transcript and request outcomes", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession>;
  let deliver: (frame: ChatServerFrame) => void;
  let disconnect: () => void;
  let reconnect: () => void;
  let sent: Send[];
  let duringSend: (frame: Send) => boolean;
  const user = (text: string): ChatServerFrame => ({ type: "message", sessionId: session.id, message: { role: "user", blocks: [{ kind: "text", text }] } });
  const ack = (id: string, completed = true): ChatServerFrame => ({ type: "ack", sessionId: session.id, command: "chat.send", requestId: id, ...(completed ? { phase: "completed" as const } : {}) });
  const failure = (id: string): ChatServerFrame => ({ type: "error", sessionId: session.id, command: "chat.send", requestId: id, code: "send_failed", message: "Rejected" });
  const state = (isStreaming = false): ChatServerFrame => ({ type: "state", sessionId: session.id, isStreaming, isCompacting: false });
  const history = (texts: string[]): ChatServerFrame => ({ type: "entries", sessionId: session.id, final: true, entries: texts.map((text, i) => ({ id: `h${i}`, type: "message", message: { role: "user", content: text } })) });
  const rows = () => current.messages.map(messageText);
  const submit = (text = "/wish evidence") => {
    let accepted = false;
    act(() => { accepted = current.submit({ text, image: null }); });
    expect(accepted).toBe(true);
    return sent[sent.length - 1]!.requestId!;
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    duringSend = () => true;
    const connect: ChatConnector = handlers => {
      deliver = handlers.onFrame;
      disconnect = () => handlers.onClose?.(1006);
      reconnect = () => handlers.onOpen?.();
      handlers.onOpen?.();
      return { send: frame => {
        if (frame.type !== "chat.send") return true;
        sent.push(frame);
        return duringSend(frame);
      }, close: () => undefined };
    };
    function Probe() {
      current = useChatSession(session, connect);
      return <ChatComposer commands={[]} running={current.running} isCompacting={false} retryDraft={current.retryDraft}
        onSubmit={current.submit} onSteer={current.steer} onStop={() => undefined} provider="omo" cwd="/work" />;
    }
    act(() => root.render(<Probe />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  it("does not create a user row before the canonical message", () => {
    submit("ordinary-evidence");
    expect(rows()).toEqual([]);
    expect(current.running).toBe(true);
    act(() => deliver(user("ordinary-evidence")));
    expect(rows()).toEqual(["ordinary-evidence"]);
  });
  it("renders only the expanded canonical user message", () => {
    const id = submit();
    act(() => { deliver(user("expanded-evidence")); deliver(ack(id)); });
    expect(rows()).toEqual(["expanded-evidence"]);
    act(() => { disconnect(); reconnect(); deliver(history(["expanded-evidence"])); });
    expect(rows()).toEqual(["expanded-evidence"]);
    expect(current.retryDraft).toBeNull();
  });
  it("settles a command without a user message", () => {
    const id = submit("/local-evidence");
    act(() => deliver(ack(id, false)));
    expect(current.running).toBe(true);
    act(() => deliver(ack(id)));
    expect(current.running).toBe(false);
    expect(rows()).toEqual([]);
    expect(current.failedDrafts).toEqual([]);
  });
  it.each(["original", "expanded"])("preserves canonical rows on a correlated send failure (%s)", text => {
    const id = submit("original");
    act(() => deliver(user(text)));
    act(() => deliver(failure(id)));
    expect(rows()).toEqual([text]);
    expect(current.failedDrafts).toMatchObject([{ requestId: id, text: "original" }]);
  });
  it("recovers the original failed draft", () => {
    const draft = { text: "  /wish evidence  ", image: { name: "image.png", data: "AAAA", mimeType: "image/png" }, command: { name: "wish", description: "Wish" } };
    act(() => { current.submit(draft); });
    const id = sent[0]!.requestId!;
    act(() => deliver(failure(id)));
    act(() => current.recoverFailedDraft(id));
    expect(current.retryDraft).toMatchObject(draft);
    expect(current.failedDrafts).toEqual([]);
    const version = current.retryDraft?.version;
    act(() => { current.recoverFailedDraft(id); deliver(failure(id)); });
    expect(current.retryDraft?.version).toBe(version);
    expect(sent).toHaveLength(1);
  });
  it.each(["UAK", "AUK", "AKU", "KAU", "AK"])("ingests canonical occurrences independently of %s ordering", order => {
    const id = submit("original");
    act(() => { for (const event of order) deliver(event === "U" ? user("expanded") : ack(id, event === "K")); });
    expect(rows()).toEqual(order.includes("U") ? ["expanded"] : []);
    expect(current.running).toBe(false);
    expect(current.retryDraft).toBeNull();
  });
  it.each(["user", "completed", "failure", "run", "done"])("pre-registers ownership before synchronous %s callback", event => {
    duringSend = frame => {
      if (event === "user") deliver(user("expanded"));
      if (event === "completed") deliver(ack(frame.requestId!));
      if (event === "failure") deliver(failure(frame.requestId!));
      if (event === "run" || event === "done") deliver({ type: "run.started", sessionId: session.id });
      if (event === "done") deliver({ type: "run.done", sessionId: session.id, reason: "stop" });
      return true;
    };
    submit("original");
    expect(rows()).toEqual(event === "user" ? ["expanded"] : []);
    expect(current.running).toBe(event === "user" || event === "run");
    expect(current.failedDrafts).toHaveLength(event === "failure" ? 1 : 0);
  });
  it.each([false, "throw"])("preserves independent canonical events when local send returns %s", result => {
    duringSend = () => { deliver(user("unrelated")); if (result === "throw") throw new Error("socket rejected"); return false; };
    let accepted = true;
    act(() => { accepted = current.submit({ text: "original", image: null }); });
    expect(accepted).toBe(false);
    expect(rows()).toEqual(["unrelated"]);
    expect(current.running).toBe(false);
    expect(current.retryDraft).toBeNull();
    if (result === "throw") expect(current.error).toContain("socket rejected");
  });
  it("keeps identical canonical occurrences and reverse request outcomes independent", () => {
    const a = submit("same");
    act(() => deliver({ type: "run.done", sessionId: session.id, reason: "stop" }));
    const b = submit("same");
    expect(a).not.toBe(b);
    act(() => { deliver(user("same")); deliver(user("same")); deliver(ack(b)); deliver(failure(a)); });
    expect(rows()).toEqual(["same", "same"]);
    expect(current.failedDrafts).toMatchObject([{ requestId: a, text: "same" }]);
    expect(current.running).toBe(false);
  });
  it("does not consume unrelated or identical user occurrences as request evidence", () => {
    const id = submit("same");
    act(() => { deliver(user("unrelated")); deliver(user("same")); deliver(ack(id)); deliver(user("same")); });
    expect(rows()).toEqual(["unrelated", "same", "same"]);
  });
  it("keeps a new request active across delayed old identical history", () => {
    const id = submit("same");
    act(() => deliver(history(["same"])));
    expect(rows()).toEqual(["same"]);
    expect(current.running).toBe(true);
    act(() => deliver(ack(id)));
    expect(current.running).toBe(false);
  });
  it.each([[], ["original"], ["expanded"], ["original", "old reply"]].map(texts => ({ texts })))("does not infer failure from reconnect history $texts", ({ texts }) => {
    submit("original");
    act(() => { disconnect(); reconnect(); deliver(history(texts)); deliver(state()); });
    expect(current.failedDrafts).toEqual([]);
    expect(current.retryDraft).toBeNull();
    expect(current.sendRequests).toMatchObject([{ phase: "unknown", draft: { text: "original" } }]);
    expect(current.running).toBe(false);
    expect(rows()).toEqual(texts);
    expect(sent).toHaveLength(1);
  });
  it("preserves server streaming when a request completes after reconnect", () => {
    const id = submit();
    act(() => { disconnect(); reconnect(); deliver(state(true)); deliver(history([])); deliver(ack(id)); });
    expect(current.running).toBe(true);
    expect(current.retryDraft).toBeNull();
    expect(rows()).toEqual([]);
  });
  it("does not let an old failure clear a newer prompt hold", () => {
    const a = submit("A");
    act(() => { disconnect(); reconnect(); deliver(state()); });
    submit("B");
    act(() => { deliver(failure(a)); deliver(history([])); });
    expect(current.running).toBe(true);
    expect(rows()).toEqual([]);
    expect(current.failedDrafts).toMatchObject([{ requestId: a }]);
  });
  it("preserves distinct history IDs and ambiguous identical live receipts", () => {
    act(() => { deliver(user("same")); deliver(history(["same", "same"])); });
    expect(rows()).toEqual(["same", "same", "same"]);
    expect(current.messages.slice(0, 2).map(message => message.id)).toEqual(["h0", "h1"]);
  });
  it("does not resurrect a queue placeholder after synchronous handoff", () => {
    act(() => deliver(state(true)));
    duringSend = frame => { deliver({ type: "queue", sessionId: session.id, revision: 1, items: [{ id: "q1", requestId: frame.requestId!, text: "queued", hasImage: false, createdAt: 1 }], engine: { pendingMessageCount: 0, ordered: [] } }); return true; };
    submit("queued");
    expect(current.queuePlaceholders).toEqual([]);
    expect(current.queueItems).toHaveLength(1);
    expect(rows()).toEqual([]);
  });
  it.each([true, false])("keeps durable queue ownership with failure-first=%s", failureFirst => {
    act(() => deliver(state(true)));
    const id = submit("queued");
    const snapshot: ChatServerFrame = { type: "queue", sessionId: session.id, revision: 1, items: [{ id: "q1", requestId: id, text: "queued", hasImage: false, createdAt: 1 }], engine: { pendingMessageCount: 0, ordered: [] } };
    act(() => { deliver(failureFirst ? failure(id) : snapshot); deliver(failureFirst ? snapshot : failure(id)); });
    expect(current.queueItems).toHaveLength(1);
    expect(current.failedDrafts).toEqual([]);
    expect(current.retryDraft).toBeNull();
    expect(current.running).toBe(true);
  });
  it("retires steer feedback on completed ACK without stopping the run", () => {
    act(() => deliver(state(true)));
    act(() => { current.steer("steer"); });
    const id = sent[0]!.requestId!;
    expect(current.steerPending).toHaveLength(1);
    act(() => deliver(ack(id)));
    expect(current.steerPending).toEqual([]);
    expect(current.running).toBe(true);
    expect(rows()).toEqual([]);
  });
  it("retains late steer failure recovery after run.done", () => {
    act(() => { deliver(state(true)); current.steer("steer"); });
    const id = sent[0]!.requestId!;
    act(() => { deliver({ type: "run.done", sessionId: session.id, reason: "stop" }); deliver(user("canonical")); deliver(failure(id)); });
    expect(current.steerPending).toEqual([]);
    expect(current.failedDrafts).toMatchObject([{ requestId: id, text: "steer" }]);
    expect(rows()).toEqual(["canonical"]);
  });
  it.each(["resume_failed", "external-write-detected", "session_unloaded"] as const)("keeps canonical rows under specialized correlated %s presentation", code => {
    const id = submit("original");
    act(() => { deliver(user("canonical")); deliver({ type: "error", sessionId: session.id, requestId: id, command: "chat.send", code, message: "Special failure", ...(code === "resume_failed" ? { dangling: true, candidates: [] } : {}) }); });
    expect(rows()).toEqual(["canonical"]);
    expect(current.failedDrafts).toMatchObject([{ requestId: id, text: "original" }]);
    if (code === "resume_failed") expect(current.missingOriginal).not.toBeNull();
    if (code === "external-write-detected") expect(current.externalWriteDetected).toBe(true);
    if (code === "session_unloaded") expect(current.error).toBe("");
  });
  it.each([true, false])("settles completed transformed and no-message requests regardless of history-first=%s replay", historyFirst => {
    for (const canonical of [[], ["expanded"]]) {
      const id = submit("/wish evidence");
      act(() => deliver(ack(id)));
      act(() => { disconnect(); reconnect(); });
      act(() => {
        deliver(historyFirst ? history(canonical) : state());
        deliver(ack(id));
        deliver(historyFirst ? state() : history(canonical));
        deliver(ack(id, false));
      });
      expect(rows()).toEqual(canonical);
      expect(current.retryDraft).toBeNull();
      expect(current.sendRequests).toEqual([]);
      expect(current.running).toBe(false);
    }
  });
  it("preserves live tools, thinking and streaming across a synchronous completed callback", () => {
    duringSend = frame => {
      deliver({ type: "run.started", sessionId: session.id });
      deliver({ type: "messageDelta", sessionId: session.id, delta: { kind: "thinking_delta", delta: "thinking" } });
      deliver({ type: "tool", sessionId: session.id, toolCallId: "tool", toolName: "bash", phase: "start" });
      deliver(ack(frame.requestId!));
      return true;
    };
    submit("original");
    expect(current.running).toBe(true);
    expect(current.thinking).toBe("thinking");
    expect(current.toolCalls["tool"]?.phase).toBe("start");
    expect(current.sendRequests).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it("does not undo a synchronous terminal ACK when a contradictory transport returns false", () => {
    duringSend = frame => { deliver(user("canonical")); deliver(ack(frame.requestId!)); return false; };
    submit("original");
    expect(rows()).toEqual(["canonical"]);
    expect(current.sendRequests).toEqual([]);
    expect(current.running).toBe(false);
  });
  it("does not overwrite newer composer input on automatic failure recovery", () => {
    const id = submit("old");
    const input = container.querySelector("textarea")!;
    act(() => setTextareaValue(input, "new draft"));
    act(() => deliver(failure(id)));
    expect(input.value).toBe("new draft");
    expect(current.failedDrafts).toMatchObject([{ requestId: id, text: "old" }]);
  });
});


describe("canonical status and logical-session recovery", () => {
  let root: Root;
  let container: HTMLDivElement;
  let sessions: Map<string, ChatSessionRef>;
  let handlers: Map<string, Parameters<ChatConnector>[0]>;
  let connectors: Map<string, ChatConnector>;
  let sent: Send[];
  let send: (frame: Send, view: string) => boolean;
  const frameFor = (id: string, requestId: string, type: "ack" | "error"): ChatServerFrame => type === "ack"
    ? { type: "ack", sessionId: id, command: "chat.send", requestId, phase: "completed" }
    : { type: "error", sessionId: id, command: "chat.send", requestId, code: "send_failed", message: "Rejected" };
  function render(views: readonly [string, string][]) {
    for (const [view] of views) {
      if (connectors.has(view)) continue;
      connectors.set(view, callbacks => {
        handlers.set(view, callbacks);
        callbacks.onOpen?.();
        return { send: frame => { if (frame.type !== "chat.send") return true; sent.push(frame); return send(frame, view); }, close: () => undefined };
      });
    }
    act(() => root.render(<I18nContext.Provider value={i18n}>
      <SessionDraftProvider sessions={sessions}>{views.map(([view, id]) => <div key={view} data-view={view}>
        <ChatPane chatSession={sessions.get(id)!} focused splitEnabled={false} onFocus={() => undefined}
          onSplit={() => undefined} onClose={() => undefined} onOpenSidebar={() => undefined}
          connect={connectors.get(view)!} notify={() => undefined} />
      </div>)}</SessionDraftProvider>
    </I18nContext.Provider>));
  }
  const pane = (view = "a") => container.querySelector<HTMLElement>(`[data-view="${view}"]`)!;
  const input = (view = "a") => pane(view).querySelector<HTMLTextAreaElement>("textarea")!;
  function submit(text: string, view = "a") {
    act(() => setTextareaValue(input(view), text));
    act(() => pane(view).querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    return sent.at(-1)!.requestId!;
  }
  const emit = (frame: ChatServerFrame, view = "a") => act(() => handlers.get(view)!.onFrame(frame));
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    ControlledResizeObserver.instances = [];
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    sessions = new Map([ [session.id, session], ["other", { ...session, id: "other" }] ]);
    handlers = new Map(); connectors = new Map(); sent = []; send = () => true;
    render([["a", session.id]]);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  it("shows request-keyed sending outside the transcript and settles no-message completion", () => {
    const id = submit("/local-evidence");
    expect(pane().querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
    expect(pane().querySelector(`.th-chat-status [data-request-id="${id}"][data-send-phase=sending]`)).not.toBeNull();
    emit({ type: "ack", sessionId: session.id, command: "chat.send", requestId: id });
    expect(pane().querySelector(`[data-request-id="${id}"][data-send-phase=admitted]`)).not.toBeNull();
    emit(frameFor(session.id, id, "ack"));
    expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
    expect(pane().querySelector(".th-chat-send-btn")?.getAttribute("type")).toBe("submit");
    expect(input().value).toBe("");
  });
  it.each(["completed", "failure", "run.done"])("does not resurrect visible state after synchronous %s", outcome => {
    send = frame => {
      handlers.get("a")!.onFrame(outcome === "run.done"
        ? { type: "run.done", sessionId: session.id, reason: "local_command" }
        : frameFor(session.id, frame.requestId!, outcome === "completed" ? "ack" : "error"));
      return true;
    };
    const id = submit("/sync");
    expect(pane().querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
    expect(pane().querySelector(".th-chat-send-btn")?.getAttribute("type")).toBe("submit");
    expect(pane().querySelector(`[data-request-id="${id}"] .th-chat-status-spinner`)).toBeNull();
    if (outcome !== "completed") expect(pane().querySelector(`[data-request-id="${id}"][data-send-phase=${outcome === "failure" ? "failed" : "unknown"}]`)).not.toBeNull();
    else expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
  });
  it.each(["prompt", "queued", "steer"])("keeps the %s editor on local send refusal and throw", kind => {
    if (kind !== "prompt") emit({ type: "run.started", sessionId: session.id });
    for (const throws of [false, true]) {
      send = () => { if (throws) throw new Error("local failure"); return false; };
      act(() => setTextareaValue(input(), "  original  "));
      act(() => kind === "steer"
        ? input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }))
        : pane().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(input().value).toBe("  original  ");
      expect(pane().querySelectorAll("[data-request-id]")).toHaveLength(0);
      expect(pane().querySelectorAll(".th-chat-msg--user")).toHaveLength(0);
      if (throws) expect(pane().querySelector("[role=alert]")?.textContent).toContain("local failure");
    }
  });
  it("keeps unknown non-spinning across history failure and explicitly restores without resending", () => {
    const id = submit("unconfirmed");
    act(() => { handlers.get("a")!.onClose?.(1006); handlers.get("a")!.onOpen?.(); });
    emit({ type: "state", sessionId: session.id, isStreaming: false, isCompacting: false });
    emit({ type: "error", sessionId: session.id, command: "get_entries", code: "provider_timeout", message: "History unavailable" });
    expect(input().value).toBe("");
    const status = pane().querySelector(`[data-request-id="${id}"][data-send-phase=unknown]`);
    expect(status).not.toBeNull();
    expect(status!.querySelector(".th-chat-status-spinner")).toBeNull();
    const restore = status!.querySelector<HTMLButtonElement>(".th-send-restore")!;
    expect(restore.title).toBe("chat.send.unknownWarning");
    act(() => restore.click());
    expect(input().value).toBe("unconfirmed");
    expect(sent).toHaveLength(1);
    expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
    emit(frameFor(session.id, id, "error"));
    expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
  });
  it.each(["ack", "error"] as const)("lets the same-chat observer receive %s before the originator without stealing ownership", outcome => {
    render([["a", session.id], ["observer", session.id], ["b", "other"]]);
    const id = submit("owned original");
    act(() => setTextareaValue(input(), "newer draft"));
    const terminal = frameFor(session.id, id, outcome);
    emit(terminal, "b");
    expect(pane().querySelector(`[data-request-id="${id}"][data-send-phase=sending]`)).not.toBeNull();
    emit(terminal, "observer");
    emit(terminal);
    expect(input().value).toBe("newer draft");
    expect(pane("b").querySelectorAll("[data-request-id]")).toHaveLength(0);
    if (outcome === "error") {
      expect(pane().querySelector(`[data-request-id="${id}"][data-send-phase=failed]`)).not.toBeNull();
      act(() => pane().querySelector<HTMLButtonElement>(".th-failed-draft")!.click());
      expect(input().value).toBe("owned original");
      expect(pane("observer").querySelectorAll(".th-failed-draft")).toHaveLength(0);
    } else expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
    expect(sent).toHaveLength(1);
  });
  it.each(["failed", "unknown"])("moves %s originals with the logical session without overwriting newer drafts", phase => {
    const id = submit("recover original");
    act(() => setTextareaValue(input(), "new unsent draft"));
    if (phase === "failed") emit(frameFor(session.id, id, "error"));
    else act(() => handlers.get("a")!.onClose?.(1006));
    render([["b", "other"]]);
    expect(input("b").value).toBe("");
    expect(pane("b").querySelectorAll("[data-request-id]")).toHaveLength(0);
    render([["moved", session.id], ["b", "other"]]);
    expect(input("moved").value).toBe("new unsent draft");
    const status = pane("moved").querySelector(`[data-request-id="${id}"][data-send-phase=${phase}]`);
    expect(status).not.toBeNull();
    act(() => (phase === "failed" ? status as HTMLButtonElement : status!.querySelector<HTMLButtonElement>(".th-send-restore")!).click());
    expect(input("moved").value).toBe("recover original");
    expect(sent).toHaveLength(1);
    expect(input("b").value).toBe("");
  });
  it("dismisses a failed original without resending or resurrecting replayed feedback", () => {
    const id = submit("failed original");
    act(() => setTextareaValue(input(), "new draft"));
    emit(frameFor(session.id, id, "error"));
    const dismiss = pane().querySelector<HTMLButtonElement>(`[data-dismiss-request-id="${id}"]`);
    expect(dismiss).not.toBeNull();
    act(() => dismiss!.click());
    emit(frameFor(session.id, id, "error"));
    expect(pane().querySelector(`[data-request-id="${id}"]`)).toBeNull();
    expect(input().value).toBe("new draft");
    expect(sent).toHaveLength(1);
  });
  it("purges retained originals when the logical session is deleted", () => {
    const id = submit("deleted original");
    emit(frameFor(session.id, id, "error"));
    sessions = new Map([["other", { ...session, id: "other" }]]);
    render([["b", "other"]]);
    sessions = new Map([...sessions, [session.id, session]]);
    render([["recreated", session.id]]);
    expect(input("recreated").value).toBe("");
    expect(pane("recreated").querySelectorAll("[data-request-id]")).toHaveLength(0);
    emit(frameFor(session.id, id, "error"), "recreated");
    expect(pane("recreated").querySelectorAll(".th-failed-draft")).toHaveLength(0);
  });
});
