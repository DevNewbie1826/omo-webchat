import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_WIRE_VERSION, connectChat } from "./chatWs";

/**
 * Connector-level tests for the v2 hello handshake, the R1 unknown-frame
 * drop, the reconnect chat.create re-bind, and server-side backpressure
 * handling. The auth-expiry upgrade probe lives in chatWs.auth.test.ts; the
 * raw transport patterns (backoff/heartbeat/visibility) in ws.test.ts.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** Server push: obj is serialized exactly like a real text frame. */
  serverSend(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("connectChat v2 hello handshake", () => {
  let conn: ReturnType<typeof connectChat> | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    conn?.close();
    conn = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("announces the client wire version and consumes the server hello without delivering it", () => {
    const onFrame = vi.fn();
    conn = connectChat({ onFrame });
    const socket = FakeWebSocket.instances[0];
    socket?.serverOpen();

    // Client hello is the first frame on the wire, before any session frame.
    expect(socket?.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: "hello", version: CHAT_WIRE_VERSION }]);

    socket?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "omo-webchat v2.0.0" });
    expect(onFrame).not.toHaveBeenCalled();

    // The session stream flows normally after the handshake.
    socket?.serverSend({ type: "ready", sessionId: "c1", piSessionId: null, resumed: false });
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "ready", sessionId: "c1" }),
    );
  });

  it("warns on a wire version mismatch but proceeds with the session stream", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onFrame = vi.fn();
    conn = connectChat({ onFrame });
    const socket = FakeWebSocket.instances[0];
    socket?.serverOpen();

    socket?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION + 1, serverVersion: "future" });
    socket?.serverSend({ type: "run.started", sessionId: "c1" });

    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("version mismatch"));
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "run.started" }));
  });

  it("tolerates a server that never sends hello with a single warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onFrame = vi.fn();
    conn = connectChat({ onFrame });
    const socket = FakeWebSocket.instances[0];
    socket?.serverOpen();

    // First frame is a session frame: warn once, deliver it.
    socket?.serverSend({ type: "state", sessionId: "c1", isStreaming: false, isCompacting: false });
    socket?.serverSend({ type: "state", sessionId: "c1", isStreaming: true, isCompacting: false });

    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("without a hello frame"));
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("drops late and replayed hello frames instead of delivering them", () => {
    const onFrame = vi.fn();
    conn = connectChat({ onFrame });
    const socket = FakeWebSocket.instances[0];
    socket?.serverOpen();
    socket?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });
    socket?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe("connectChat R1 unknown-frame drop", () => {
  let conn: ReturnType<typeof connectChat> | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    conn?.close();
    conn = null;
    vi.unstubAllGlobals();
  });

  it("drops unknown and malformed server frames silently without touching handlers", () => {
    const onFrame = vi.fn();
    const onParseError = vi.fn();
    conn = connectChat({ onFrame, onParseError });
    const socket = FakeWebSocket.instances[0];
    socket?.serverOpen();
    socket?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    // Forward-compatible unknown type, a non-object payload, and a known type
    // with malformed fields: all dropped, none surface as parse errors (a
    // parse error is a JSON-level failure only).
    socket?.serverSend({ type: "future.capability", sessionId: "c1", someNewField: { deep: [true, null] } });
    socket?.serverSend([1, 2, 3]);
    socket?.serverSend({ type: "messageDelta", sessionId: "c1", delta: {} });

    expect(onFrame).not.toHaveBeenCalled();
    expect(onParseError).not.toHaveBeenCalled();
  });
});

describe("connectChat reconnect re-bind", () => {
  let conn: ReturnType<typeof connectChat> | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    conn?.close();
    conn = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const clientFrames = (socket: FakeWebSocket | undefined): unknown[] =>
    (socket?.sent ?? []).map((raw) => JSON.parse(raw) as unknown);

  it("replays the last chat.create after the reconnect handshake", async () => {
    const create = { type: "chat.create", wsId: "ws-1", chatId: "chat-1" } as const;
    const onOpen = vi.fn(() => {
      // Consumer rebinds itself on every open (features behavior) except on
      // the reconnect below, proving the connector covers the gap.
      if (FakeWebSocket.instances.length === 1) conn?.send(create);
    });
    conn = connectChat({ onOpen, onFrame: () => undefined });

    const first = FakeWebSocket.instances[0];
    first?.serverOpen();
    expect(clientFrames(first)).toEqual([
      { type: "hello", version: CHAT_WIRE_VERSION },
      create,
    ]);

    // Clean server drop -> capped backoff (1s) -> replacement socket.
    first?.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebSocket.instances[1];
    second?.serverOpen();
    // Consumer sends nothing this time; the connector replays after hello.
    second?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    expect(clientFrames(second)).toEqual([
      { type: "hello", version: CHAT_WIRE_VERSION },
      create,
    ]);
  });

  it("does not double-send chat.create when the consumer already rebinds on open", async () => {
    const create = { type: "chat.create", wsId: "ws-1", chatId: "chat-1" } as const;
    conn = connectChat({
      onOpen: () => conn?.send(create),
      onFrame: () => undefined,
    });

    const first = FakeWebSocket.instances[0];
    first?.serverOpen();
    first?.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebSocket.instances[1];
    second?.serverOpen();
    second?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    // Exactly one create per connection: the consumer's own onOpen send
    // satisfies the re-bind, so the connector stays out of the way.
    const creates = clientFrames(second).filter((frame) => (frame as { type: string }).type === "chat.create");
    expect(creates).toEqual([create]);
  });

  it("relies on snapshot-then-live ordering: no synthetic frames after rebind", async () => {
    const onFrame = vi.fn();
    conn = connectChat({ onOpen: () => conn?.send({ type: "chat.create", wsId: "ws-1", chatId: "chat-1" }), onFrame });
    const first = FakeWebSocket.instances[0];
    first?.serverOpen();
    first?.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.instances[1]?.serverOpen();

    // The connector adds nothing to the inbound path: the server's snapshot
    // (entries/extensionEvent replay) then live frames arrive as-is.
    FakeWebSocket.instances[1]?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });
    FakeWebSocket.instances[1]?.serverSend({ type: "entries", sessionId: "chat-1", entries: [], final: true });
    FakeWebSocket.instances[1]?.serverSend({ type: "run.started", sessionId: "chat-1" });

    expect(onFrame.mock.calls.map(([frame]) => (frame as { type: string }).type)).toEqual([
      "entries",
      "run.started",
    ]);
  });
});

describe("connectChat server-side backpressure", () => {
  let conn: ReturnType<typeof connectChat> | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    conn?.close();
    conn = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("handles a slow-consumer detach as a plain close: report, drop sends, reconnect", async () => {
    const onClose = vi.fn();
    conn = connectChat({ onOpen: () => undefined, onFrame: () => undefined, onClose });
    const first = FakeWebSocket.instances[0];
    first?.serverOpen();

    // The server detaches this subscriber because ITS outbound queue overflowed
    // (invariant 12). From the client this is indistinguishable from any close:
    // no client-side queue draining, just report and re-enter backoff.
    first?.serverClose(1011);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(1011);
    expect(conn.send({ type: "ping" })).toBe(false);
    const firstSentCount = first?.sent.length ?? 0;

    // The reconnect produces a fresh socket; nothing was queued onto the dead
    // one between close and reopen.
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebSocket.instances[1];
    second?.serverOpen();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first?.sent).toHaveLength(firstSentCount); // dead socket untouched
    expect(JSON.parse(second?.sent[0] ?? "{}")).toEqual({ type: "hello", version: CHAT_WIRE_VERSION });
  });

  it("keeps the create rebind across a slow-consumer close too", async () => {
    const create = { type: "chat.create", wsId: "ws-1", chatId: "chat-1" } as const;
    conn = connectChat({ onOpen: () => conn?.send(create), onFrame: () => undefined });
    const first = FakeWebSocket.instances[0];
    first?.serverOpen();
    first?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    first?.serverClose(1008);
    await vi.advanceTimersByTimeAsync(2000);
    const second = FakeWebSocket.instances[1];
    second?.serverOpen();
    second?.serverSend({ type: "hello", version: CHAT_WIRE_VERSION, serverVersion: "v2" });

    const creates = (second?.sent ?? [])
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((frame) => frame.type === "chat.create");
    expect(creates).toEqual([create]);
  });
});
