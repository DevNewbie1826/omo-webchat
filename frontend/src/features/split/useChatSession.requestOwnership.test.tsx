import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { ChatComposer } from "./ChatComposer";
import { setTextareaValue } from "./chatPaneTestHarness";
import { messageText } from "./chatEntries";
import { SessionDraftProvider, useSessionDraft } from "./sessionDraft";
import { useChatSession } from "./useChatSession";

const session = { id: "ownership", wsId: "workspace", name: "Chat", cwd: "/work", provider: "omo" } as const;
const sessions = new Map([[session.id, session]]);
const command = { name: "owned-command", description: "Provider command" };
type Send = Extract<ChatClientFrame, { type: "chat.send" }>;
const state = (isStreaming = false): ChatServerFrame => ({ type: "state", sessionId: session.id, isStreaming, isCompacting: false });
const failure = (requestId: string, code = "send_failed"): ChatServerFrame => ({ type: "error", sessionId: session.id, command: "chat.send", requestId, code, message: "Rejected" });
const snapshot = (requestId?: string): ChatServerFrame => ({ type: "queue", sessionId: session.id, revision: 1,
  items: requestId ? [{ id: "q-item", requestId, text: "original", hasImage: false, createdAt: 1 }] : [],
  engine: { pendingMessageCount: 0, ordered: [] } });
const completed = (requestId: string): ChatServerFrame => ({ type: "ack", sessionId: session.id, command: "chat.send", requestId, phase: "completed" });

describe("request/recovery ownership through the real hook and composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession>;
  let draft: ReturnType<typeof useSessionDraft>;
  let handlers: Parameters<ChatConnector>[0];
  let sent: ChatClientFrame[];
  let composerKey: number;
  let connect: ChatConnector;
  let observing: boolean;
  let observerHandlers: Parameters<ChatConnector>[0];
  let observerConnect: ChatConnector;
  function Observer() { useChatSession(session, observerConnect); return null; }
  function Probe() {
    current = useChatSession(session, connect);
    draft = useSessionDraft(session);
    return <ChatComposer key={composerKey} session={session} commands={[command]} running={current.running}
      isCompacting={current.isCompacting} retryDraft={current.retryDraft} onSubmit={current.submit}
      onSteer={current.steer} onStop={current.stop} provider="omo" cwd="/work" />;
  }
  const render = () => act(() => root.render(<SessionDraftProvider sessions={sessions}><Probe />{observing && <Observer />}</SessionDraftProvider>));
  const input = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
  const emit = (frame: ChatServerFrame) => act(() => handlers.onFrame(frame));
  const sends = () => sent.filter((frame): frame is Send => frame.type === "chat.send");
  const type = (text: string) => act(() => setTextareaValue(input(), text));
  function submit(text: string) {
    type(text);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(input().value).toBe("");
    return sends().at(-1)!.requestId!;
  }
  async function pickImage() {
    const read = FileReader.prototype.readAsDataURL;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const loaded = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const timeout = setTimeout(() => reject(new Error("FileReader loadend deadline")), 1000);
    const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, file) {
      this.addEventListener("loadend", () => { clearTimeout(timeout); resolve(); }, { once: true });
      read.call(this, file);
    });
    try {
      const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["new image"], "new.png", { type: "image/png" })] });
      await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); await loaded; });
      expect(draft.pendingImage?.name).toBe("new.png");
    } finally { clearTimeout(timeout); spy.mockRestore(); }
  }
  async function edit(kind: string) {
    if (kind === "text") type("newer text");
    if (kind === "same-text") { type("user revision"); type("original"); }
    if (kind === "image") await pickImage();
    if (kind === "command") {
      type("/owned");
      await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      expect(draft.draftCommand).toEqual(command);
    }
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    sent = []; composerKey = 0; observing = false;
    observerConnect = callbacks => { observerHandlers = callbacks; callbacks.onOpen?.(); return { send: () => true, close: () => undefined }; };
    connect = callbacks => {
      handlers = callbacks; callbacks.onOpen?.();
      return { send: frame => { sent.push(frame); return true; }, close: () => undefined };
    };
    render(); emit(state());
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it.each([false, true])("late correlated unload settles A only, provider-active=%s", async active => {
    const a = submit("A");
    act(() => { handlers.onClose?.(1006); handlers.onOpen?.(); });
    emit(state());
    const b = submit("B");
    emit({ type: "message", sessionId: session.id, message: { role: "user", blocks: [{ kind: "text", text: "canonical B" }] } });
    if (active) {
      await act(async () => {
        handlers.onFrame({ type: "run.started", sessionId: session.id });
        handlers.onFrame({ type: "messageDelta", sessionId: session.id, delta: { kind: "thinking_delta", delta: "B thinking" } });
        handlers.onFrame({ type: "messageDelta", sessionId: session.id, delta: { kind: "text_delta", delta: "B streaming" } });
        handlers.onFrame({ type: "tool", sessionId: session.id, toolCallId: "B-tool", toolName: "bash", phase: "start" });
        handlers.onFrame({ type: "compaction.started", sessionId: session.id });
      });
    }
    type("newer draft");
    const surfaces = { thinking: current.thinking, streaming: current.streaming, tools: current.toolCalls,
      flight: current.activities.runInFlight, compacting: current.isCompacting };
    expect(current.sendRequests).toMatchObject([{ requestId: a, phase: "unknown", hold: false }, { requestId: b, phase: "sending", hold: true }]);
    emit(failure(a, "session_unloaded"));
    expect.soft(current.sendRequests).toMatchObject([{ requestId: a, phase: "failed", hold: false }, { requestId: b, phase: "sending", hold: true }]);
    expect.soft(current.running).toBe(true);
    expect.soft(current.serverRunning).toBe(active);
    expect.soft({ thinking: current.thinking, streaming: current.streaming, tools: current.toolCalls,
      flight: current.activities.runInFlight, compacting: current.isCompacting }).toEqual(surfaces);
    expect(current.messages.map(messageText)).toEqual(["canonical B"]);
    expect(input().value).toBe("newer draft");
    expect(current.failedDrafts).toMatchObject([{ requestId: a, text: "A" }]);
    expect(current.error).toBe("");
    act(() => current.recoverFailedDraft(a));
    expect(input().value).toBe("A");
    const version = current.retryDraft?.version;
    act(() => current.recoverFailedDraft(a)); emit(failure(a, "session_unloaded"));
    expect(current.retryDraft?.version).toBe(version);
    emit(completed(b));
    expect(current.running).toBe(active);
    emit({ type: "run.done", sessionId: session.id, reason: "end_turn" });
    expect(current.running).toBe(false);
    expect(current.sendRequests).toEqual([]);
    expect(sends()).toHaveLength(2);
  });

  const cases = (["prompt", "queued"] as const).flatMap(kind => [true, false].flatMap(errorFirst =>
    ["before-error", "between-frames"].flatMap(when => ["none", "text", "same-text", "image", "command"].map(intervening => ({ kind, errorFirst, when, intervening })))));
  it.each(cases)("queue handoff $kind errorFirst=$errorFirst $when edit=$intervening", async ({ kind, errorFirst, when, intervening }) => {
    if (kind === "queued") emit(state(true));
    const id = submit("original");
    expect(current.sendRequests).toMatchObject([{ requestId: id, kind }]);
    if (when === "before-error") await edit(intervening);
    // Separate act boundaries are essential: the actual automatic restoration
    // must commit before the next transport frame, rather than being batched away.
    emit(errorFirst ? failure(id) : snapshot(id));
    if (errorFirst && intervening === "none") expect(input().value).toBe(kind === "prompt" ? "original" : "");
    if (when === "between-frames") await edit(intervening);
    const newer = { text: draft.input, image: draft.pendingImage, command: draft.draftCommand };
    emit(errorFirst ? snapshot(id) : failure(id));
    expect(current.queueItems).toMatchObject([{ id: "q-item", requestId: id }]);
    expect(current.sendRequests).toEqual([]);
    expect(current.failedDrafts).toEqual([]);
    expect.soft(current.retryDraft).toBeNull();
    expect.soft({ text: draft.input, image: draft.pendingImage, command: draft.draftCommand }).toEqual(intervening === "none"
      ? { text: "", image: null, command: null } : newer);
    expect(current.messages).toEqual([]);
    act(() => { current.queueRemove("q-item"); current.queueClear("webchat"); });
    emit(snapshot());
    emit(failure(id)); emit(completed(id)); emit(failure(id));
    expect(current.queueItems).toEqual([]);
    expect(current.sendRequests).toEqual([]);
    expect.soft(current.retryDraft).toBeNull();
    expect.soft({ text: draft.input, image: draft.pendingImage, command: draft.draftCommand }).toEqual(intervening === "none"
      ? { text: "", image: null, command: null } : newer);
    expect(sends()).toHaveLength(1);
  });

  it("cancels a system-restored copy after composer remount", () => {
    const id = submit("original"); emit(failure(id));
    expect(input().value).toBe("original");
    composerKey++; render();
    emit(snapshot(id));
    expect(input().value).toBe("");
    expect(sends()).toHaveLength(1);
  });
  it.each([false, true])("cancels the originator offer when another receiver owns handoff, completed=%s", complete => {
    const id = submit("original"); emit(failure(id));
    observing = true; render();
    act(() => { observerHandlers.onFrame(snapshot(id)); if (complete) observerHandlers.onFrame(completed(id)); });
    expect.soft(current.retryDraft).toBeNull();
    expect(input().value).toBe("");
    composerKey++; render();
    expect(input().value).toBe("");
    expect(sends()).toHaveLength(1);
  });
  it("a different request's handoff cannot cancel the restored copy", () => {
    const id = submit("original"); emit(failure(id));
    emit(snapshot("other-request"));
    expect(input().value).toBe("original");
    expect(current.failedDrafts).toMatchObject([{ requestId: id }]);
  });
  it.each(["prompt", "queued"])("preserves explicit original recovery for pre-handoff %s rejection", kind => {
    if (kind === "queued") emit(state(true));
    const original = { text: "  /owned-command original  ", image: { data: "YQ==", name: "original.png", mimeType: "image/png" }, command };
    act(() => { current.submit(original); });
    const id = sends()[0]!.requestId!;
    type("new draft"); emit(failure(id));
    expect(input().value).toBe("new draft");
    act(() => current.recoverFailedDraft(id));
    expect(input().value).toBe(original.text);
    expect(draft.pendingImage).toEqual(original.image);
    expect(draft.draftCommand).toEqual(command);
    const version = current.retryDraft?.version;
    emit(failure(id)); act(() => current.recoverFailedDraft(id));
    expect(current.retryDraft?.version).toBe(version);
    expect(sends()).toHaveLength(1);
  });
});
