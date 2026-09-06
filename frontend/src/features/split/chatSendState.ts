import type { ChatDraft } from "./chatSessionTypes";

export interface ChatSendRequest {
  readonly requestId: string;
  readonly kind: "prompt" | "queued" | "steer";
  readonly draft: ChatDraft;
  readonly text: string;
  readonly sequence: number;
  readonly socket: number;
  readonly phase: "sending" | "admitted" | "unknown" | "failed";
  readonly queueOwned: boolean;
  readonly hold: boolean;
  readonly showSteer: boolean;
}

// Queue receipts retain only ownership, not a terminal send outcome or payload.
type Terminal = "completed" | "failed" | "dismissed" | "queued" | "queueFailed";
const EMPTY: readonly ChatSendRequest[] = [];

/** In-memory, logical-chat-owned request state. It has no transcript access. */
export class ChatSendStore {
  private requests: readonly ChatSendRequest[] = EMPTY;
  private readonly terminals = new Map<string, Terminal>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private socket = 0;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = (): readonly ChatSendRequest[] => this.requests;
  nextSocket(): number { return ++this.socket; }
  get(id: string): ChatSendRequest | undefined { return this.requests.find(request => request.requestId === id); }
  terminal(id: string): Terminal | undefined { return this.terminals.get(id); }
  private publish(requests: readonly ChatSendRequest[]): void {
    this.requests = requests;
    for (const listener of this.listeners) listener();
  }
  private remember(id: string, terminal: Terminal): void {
    this.terminals.set(id, terminal);
    if (this.terminals.size > 512) this.terminals.delete(this.terminals.keys().next().value!);
  }
  private update(id: string, patch: Partial<ChatSendRequest>): void {
    this.publish(this.requests.map(request => request.requestId === id ? { ...request, ...patch } : request));
  }
  private boundRecovery(): void {
    const recovery = this.requests.filter(request => !request.queueOwned && (request.phase === "failed" || request.phase === "unknown"));
    const expired = recovery.slice(0, Math.max(0, recovery.length - 20));
    if (expired.length === 0) return;
    const ids = new Set(expired.map(request => request.requestId));
    for (const id of ids) this.remember(id, "dismissed");
    this.publish(this.requests.filter(request => !ids.has(request.requestId)));
  }
  register(requestId: string, kind: ChatSendRequest["kind"], draft: ChatDraft, socket: number): void {
    this.publish([...this.requests, { requestId, kind, draft, text: draft.text.trim(), sequence: ++this.sequence,
      socket, phase: "sending", queueOwned: false, hold: kind === "prompt", showSteer: kind === "steer" }]);
  }
  admit(id: string): void {
    if (this.get(id)?.phase === "sending") this.update(id, { phase: "admitted" });
  }
  complete(id: string): boolean {
    const receipt = this.terminals.get(id);
    const queueOwned = receipt === "queued" || receipt === "queueFailed";
    if (!queueOwned && (!this.get(id) || receipt !== undefined)) return false;
    this.remember(id, "completed");
    this.publish(this.requests.filter(request => request.requestId !== id));
    return true;
  }
  fail(id: string): ChatSendRequest | undefined {
    if (this.terminals.get(id) === "queued") {
      this.remember(id, "queueFailed");
      return undefined;
    }
    const request = this.get(id);
    if (!request || this.terminals.has(id)) return undefined;
    this.remember(id, "failed");
    this.update(id, { phase: "failed", hold: false, showSteer: false });
    this.boundRecovery();
    return request;
  }
  rollback(id: string): void {
    if (this.terminals.has(id)) return;
    this.publish(this.requests.filter(request => request.requestId !== id));
  }
  handoff(ids: ReadonlySet<string>): void {
    // The durable queue owns the original now. Remove/clear need not emit a
    // chat.send outcome, and disappearance may also mean dispatch in flight.
    // Release the payload at handoff; bounded IDs still correlate late outcomes.
    for (const request of this.requests) {
      if (ids.has(request.requestId)) this.remember(request.requestId, request.phase === "failed" ? "queueFailed" : "queued");
    }
    this.publish(this.requests.filter(request => !ids.has(request.requestId)));
  }
  disconnect(socket: number): void {
    this.publish(this.requests.map(request => request.socket === socket && request.phase !== "failed"
      ? { ...request, phase: "unknown", hold: false, showSteer: false } : request));
    this.boundRecovery();
  }
  endRun(): void {
    this.publish(this.requests.map(request => request.phase === "failed" ? request
      : { ...request, hold: false, showSteer: false, phase: request.queueOwned || request.kind === "queued" ? request.phase : "unknown" }));
    this.boundRecovery();
  }
  retire(id: string): ChatDraft | undefined {
    const request = this.get(id);
    if (!request) return undefined;
    this.remember(id, "dismissed");
    this.publish(this.requests.filter(candidate => candidate.requestId !== id));
    return request.draft;
  }
}
