/**
 * WebSocket connection with JSON text frames, auto-reconnect, and liveness
 * detection tuned for mobile Safari — the v1 transport engine, rewritten on
 * the generated WS contract: the heartbeat ping/pong are now contract frames
 * (`PingFrame`/`PongFrame`) instead of ad-hoc literals.
 *
 * iOS suspends the tab (and its sockets) when the app is backgrounded or the
 * screen locks. On resume the socket is often dead but `onclose` never fires,
 * so a client-side ping heartbeat detects the dead connection and forces a
 * reconnect. Returning to the foreground also triggers an immediate check.
 *
 * Carried v1 transport patterns (behavioral invariants):
 * - capped exponential backoff: 1s, 2s, 4s, ... capped at 10s; reset on open
 * - application ping/pong heartbeat: ping every 20s, pong timeout 10s
 * - visibilitychange probe replacing a stale socket on return to foreground
 * - upgrade-failure auth probe: a socket that closes without ever opening is
 *   likely an expired session, confirmed via a REST probe before retrying
 * - double-close guards: a stale socket reports close exactly once
 * - close-code veto: `reconnect(code) === false` ends reconnection for good
 */

import { frameTypeOf } from "./contract/types_gen";
import type { PingFrame } from "./contract/types_gen";

export interface WsHandlers {
  readonly onOpen?: () => void;
  /** Invoked for every parsed JSON message. */
  readonly onMessage: (msg: unknown) => void;
  /** Invoked when an inbound text frame fails to parse as JSON. */
  readonly onParseError?: (raw: string) => void;
  /** Invoked on every close, with the WebSocket close code. */
  readonly onClose?: (code: number) => void;
  readonly onError?: (err: Event) => void;
}

export interface WsOptions {
  /** Return false to stop reconnecting for a given close code. Default: always retry. */
  readonly reconnect?: (code: number) => boolean;
  /**
   * Invoked once when a socket closes without ever opening (the HTTP upgrade
   * was rejected — often an expired session, which the websocket cannot see
   * as a status code). Resolve false to stop reconnecting; resolve true (or
   * throw) to keep the normal network-drop backoff. While the probe runs, no
   * reconnect timer is scheduled.
   */
  readonly onUpgradeFailure?: () => Promise<boolean>;
}

export interface WsConn {
  readonly send: (msg: unknown) => boolean;
  readonly close: () => void;
}

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
/** Application close code when the heartbeat detects a dead connection. */
const CLOSE_PING_TIMEOUT = 4000;
/** Application close code when a visibility reconnect replaces a stale socket. */
const CLOSE_VISIBILITY = 4001;
/** Backoff floor and cap (invariants: capped exponential backoff 1s -> 10s). */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 10_000;

const heartbeatPing = (): PingFrame => ({ type: "ping" });

export function connectWs(path: string, handlers: WsHandlers, options: WsOptions = {}): WsConn {
  let socket: WebSocket | null = null;
  let closed = false;
  // A reconnect veto is terminal for this connection (for example, when a
  // server has cleanly ended a terminal session).
  let reconnectVetoed = false;
  // True once the current socket's close has been signaled to handlers, either
  // by its onclose or by a visibility reconnect. Guards onClose so a stale
  // socket reports close exactly once and never double-fires on replacement.
  let closeSignaled = false;
  let attempt = 0;
  let retryTimer = 0;
  let pingTimer = 0;
  let pongTimer = 0;
  let awaitingPong = false;

  const clearTimers = (): void => {
    window.clearTimeout(pingTimer);
    window.clearTimeout(pongTimer);
    awaitingPong = false;
  };

  const backoffDelay = (): number => Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = backoffDelay();
    attempt += 1;
    retryTimer = window.setTimeout(open, delay);
  };

  const vetoReconnect = (): void => {
    reconnectVetoed = true;
    window.clearTimeout(retryTimer);
  };

  const open = (): void => {
    if (closed) return;
    // Detach any in-flight socket so a reconnect (e.g. from visibilitychange
    // while CONNECTING) cannot orphan it and leave two live connections.
    const prev = socket;
    if (prev) {
      prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
      prev.close();
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}${path}`);
    socket = ws;
    closeSignaled = false;
    // False until this socket's onopen fires: a close before that means the
    // HTTP upgrade itself was refused, not a dropped live connection.
    let opened = false;

    ws.onopen = () => {
      opened = true;
      attempt = 0;
      startHeartbeat(ws);
      handlers.onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        handlers.onParseError?.(ev.data);
        return;
      }
      // The heartbeat consumes pong frames itself (contract frame, R1-adjacent:
      // anything else flows to the layer above untouched).
      if (frameTypeOf(parsed) === "pong") {
        awaitingPong = false;
        window.clearTimeout(pongTimer);
        return;
      }
      handlers.onMessage(parsed);
    };
    ws.onerror = (ev: Event) => {
      handlers.onError?.(ev);
    };
    ws.onclose = (ev: CloseEvent) => {
      clearTimers();
      closeSignaled = true;
      handlers.onClose?.(ev.code);
      if (closed) return;
      if (!(options.reconnect?.(ev.code) ?? true)) {
        vetoReconnect();
        return;
      }
      if (!opened && options.onUpgradeFailure) {
        // Likely auth failure. Probe before retrying; confirmUpgradeFailure
        // schedules the reconnect (or vetoes it) once the verdict is in.
        void confirmUpgradeFailure(ws);
        return;
      }
      scheduleReconnect();
    };
  };

  /**
   * A socket that closed without opening was refused at the HTTP upgrade.
   * The async verdict decides reconnection; a false answer vetoes it for this
   * connection the same way a `reconnect` veto does. If the socket was
   * replaced meanwhile (e.g. a visibility reconnect during the probe), the
   * stale verdict is discarded — the replacement produces its own close.
   */
  const confirmUpgradeFailure = async (failed: WebSocket): Promise<void> => {
    let retry = true;
    try {
      retry = (await options.onUpgradeFailure?.()) ?? true;
    } catch {
      retry = true; // probe blew up — treat like a network drop and retry
    }
    if (closed || reconnectVetoed || socket !== failed) return;
    if (!retry) {
      vetoReconnect();
      return;
    }
    scheduleReconnect();
  };

  /**
   * A heartbeat timeout is itself the close signal: WebSocket.close() only
   * starts a close handshake, so a dead transport may never dispatch onclose.
   */
  const handleLivenessLoss = (ws: WebSocket): void => {
    if (closed || reconnectVetoed || socket !== ws || closeSignaled) return;
    clearTimers();
    closeSignaled = true;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    ws.close(CLOSE_PING_TIMEOUT, "ping timeout");
    handlers.onClose?.(CLOSE_PING_TIMEOUT);
    if (closed) return;
    if (!(options.reconnect?.(CLOSE_PING_TIMEOUT) ?? true)) {
      vetoReconnect();
      return;
    }
    scheduleReconnect();
  };

  /** Periodic application-level ping; a missing pong means the socket died. */
  const startHeartbeat = (ws: WebSocket): void => {
    clearTimers();
    const tick = (): void => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        // Previous ping unanswered — the connection is dead. Force a reconnect.
        handleLivenessLoss(ws);
        return;
      }
      awaitingPong = true;
      ws.send(JSON.stringify(heartbeatPing()));
      pongTimer = window.setTimeout(() => {
        if (awaitingPong) handleLivenessLoss(ws);
      }, PONG_TIMEOUT_MS);
      pingTimer = window.setTimeout(tick, PING_INTERVAL_MS);
    };
    pingTimer = window.setTimeout(tick, PING_INTERVAL_MS);
  };

  /** On returning to the foreground, probe the socket instead of waiting. */
  const onVisibility = (): void => {
    if (closed || reconnectVetoed || document.visibilityState !== "visible") return;
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      window.clearTimeout(retryTimer);
      attempt = 0;
      if (ws && !closeSignaled) {
        // The stale socket is detached below without its onclose firing, so
        // signal the close exactly once here. Listeners record any in-flight
        // run as uncertain before the replacement connects. Nulling the
        // handlers first also prevents the stale socket's later close/error
        // callbacks from triggering a second reconnect or onClose.
        closeSignaled = true;
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        handlers.onClose?.(CLOSE_VISIBILITY);
      }
      open();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  open();

  return {
    send(msg: unknown): boolean {
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close(): void {
      // Double-close guard: the handle is a stable object features may drop
      // from several lifecycles; closing twice must be a no-op.
      if (closed) return;
      closed = true;
      clearTimers();
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      const ws = socket;
      if (ws) {
        ws.onclose = null;
        ws.close();
        socket = null;
      }
    },
  };
}
