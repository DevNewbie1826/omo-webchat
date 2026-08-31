import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWs } from "./ws";
import type { WsConn } from "./ws";

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

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("connectWs", () => {
  let conn: WsConn | null = null;

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

  it("does not conflate a throwing onMessage handler with a parse failure", () => {
    const onParseError = vi.fn();
    const onMessage = vi.fn(() => {
      throw new Error("handler bug");
    });
    conn = connectWs("/chat", { onMessage, onParseError });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(() => socket!.onmessage?.({ data: '{"type":"x"}' } as MessageEvent)).toThrow();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onParseError).not.toHaveBeenCalled();
  });

  it("surfaces a malformed inbound frame via onParseError instead of swallowing it", () => {
    const onParseError = vi.fn();
    conn = connectWs("/chat", { onMessage: () => undefined, onParseError });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket!.onmessage?.({ data: "{not json" } as MessageEvent);
    expect(onParseError).toHaveBeenCalledExactlyOnceWith("{not json");
  });

  it("does not reopen a connection vetoed after a clean close when the page becomes visible", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    conn = connectWs("/terminal", { onMessage: () => undefined }, { reconnect: (code) => code !== 1000 });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket?.serverClose(1000);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects when a heartbeat timeout gets no close event from the dead socket", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    conn = connectWs("/chat", { onMessage: () => undefined, onClose });
    const stale = FakeWebSocket.instances[0];
    expect(stale).toBeDefined();
    stale?.serverOpen();

    // A dead transport can accept close() without completing a close handshake
    // or dispatching close. Liveness loss must still enter reconnect itself.
    await vi.advanceTimersByTimeAsync(31_000);

    expect(onClose).toHaveBeenCalledExactlyOnceWith(4000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // A late native close from the detached socket cannot double-signal or
    // schedule a second replacement.
    stale?.serverClose(1006);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(4000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("signals onClose exactly once for the stale socket on a visibility reconnect", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const onClose = vi.fn();
    conn = connectWs("/chat", { onMessage: () => undefined, onClose });
    const stale = FakeWebSocket.instances[0];
    expect(stale).toBeDefined();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Returning to the foreground while the socket is not open replaces it and
    // must report the stale close exactly once so an in-flight run is recorded.
    document.dispatchEvent(new Event("visibilitychange"));

    expect(onClose).toHaveBeenCalledExactlyOnceWith(4001);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The detached socket's own late close must not fire onClose or reconnect.
    stale?.serverClose(1006);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(4001);
    expect(FakeWebSocket.instances).toHaveLength(2);
    visibility.mockRestore();
  });
});

describe("connectWs upgrade failure probe", () => {
  let conn: WsConn | null = null;

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

  it("vetoes reconnection and stays vetoed when the probe confirms auth failure", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const onUpgradeFailure = vi.fn(async () => false);
    conn = connectWs("/api/ws", { onMessage: () => undefined }, { onUpgradeFailure });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The upgrade was refused: the socket closes without ever opening.
    FakeWebSocket.instances[0]!.serverClose(1006);

    await vi.advanceTimersByTimeAsync(15_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(onUpgradeFailure).toHaveBeenCalledExactlyOnceWith();
    expect(FakeWebSocket.instances).toHaveLength(1);
    visibility.mockRestore();
  });

  it("keeps the normal reconnect backoff when the probe reports the session valid", async () => {
    const onUpgradeFailure = vi.fn(async () => true);
    conn = connectWs("/api/ws", { onMessage: () => undefined }, { onUpgradeFailure });
    FakeWebSocket.instances[0]!.serverClose(1006);

    await vi.advanceTimersByTimeAsync(500); // verdict in, first backoff pending
    expect(onUpgradeFailure).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600); // first backoff step (1s) elapsed
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("treats a throwing probe like a network drop and retries", async () => {
    const onUpgradeFailure = vi.fn(async () => {
      throw new Error("probe failed");
    });
    conn = connectWs("/api/ws", { onMessage: () => undefined }, { onUpgradeFailure });
    FakeWebSocket.instances[0]!.serverClose(1006);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
