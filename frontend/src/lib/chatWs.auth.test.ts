import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { connectChat } from "./chatWs";
import { setUnauthorizedHandler } from "./api";

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

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Refuse the HTTP upgrade: the socket closes without ever opening. */
  serverRefuseUpgrade(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

function statusResponse(status: number): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    json: async () => {
      throw new SyntaxError("empty body");
    },
  } as unknown as Response;
}

describe("connectChat rejected upgrade -> login redirect", () => {
  let conn: ReturnType<typeof connectChat> | null = null;
  let onUnauthorized: Mock<() => void>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    conn?.close();
    conn = null;
    setUnauthorizedHandler(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the SPA to the login page and stops reconnecting when the session is expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/auth/check")) return statusResponse(401);
      throw new Error(`unexpected fetch: ${String(input)}`);
    }));

    conn = connectChat({ onFrame: () => undefined });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // The server refuses the upgrade: the socket closes without ever opening.
    FakeWebSocket.instances[0]!.serverRefuseUpgrade(1006);

    await vi.advanceTimersByTimeAsync(60_000);

    // App's registered handler fired (login page, no reload) and the socket
    // never came back: not even the capped 10s backoff produced a retry.
    expect(onUnauthorized).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("keeps the normal reconnect backoff when the auth probe passes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statusResponse(200)));

    conn = connectChat({ onFrame: () => undefined });
    FakeWebSocket.instances[0]!.serverRefuseUpgrade(1006);

    await vi.advanceTimersByTimeAsync(500); // probe verdict in, backoff pending
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600); // first backoff step (1s) elapsed
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not mistake a network outage for an expired session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    conn = connectChat({ onFrame: () => undefined });
    FakeWebSocket.instances[0]!.serverRefuseUpgrade(1006);

    await vi.advanceTimersByTimeAsync(1100);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
