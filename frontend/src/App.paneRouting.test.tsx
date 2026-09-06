import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { deferred } from "./App.testHarness";
import type { ChatClientFrame, ChatHandlers, ChatServerFrame } from "./lib/chatWs";
import type { Terminal } from "./features/workspace/workspace";
import { requireElement, setTextareaValue } from "./features/split/chatPaneTestHarness";
import { notifyUnauthorized } from "./lib/api";

const transport = vi.hoisted(() => {
  const frames: ChatClientFrame[] = [];
  const running = new Set<string>();
  const subscribers = new Map<ChatHandlers, string>();
  const deliver = (frame: ChatServerFrame) => {
    if (frame.sessionId && frame.type === "run.started") running.add(frame.sessionId);
    if (frame.sessionId && frame.type === "run.done") running.delete(frame.sessionId);
    for (const [handlers, sessionId] of subscribers) {
      if (sessionId === frame.sessionId) handlers.onFrame(frame);
    }
  };
  return { frames, running, subscribers, deliver };
});
vi.mock("./lib/chatWs", () => ({ connectChat: vi.fn((handlers: ChatHandlers) => {
  handlers.onOpen?.();
  return {
    send: vi.fn((frame: ChatClientFrame) => {
      transport.frames.push(frame);
      if (frame.type === "chat.create") {
        transport.subscribers.set(handlers, frame.chatId);
        queueMicrotask(() => {
          if (!transport.subscribers.has(handlers)) return;
          handlers.onFrame({ type: "ready", sessionId: frame.chatId, piSessionId: frame.chatId, resumed: true });
          handlers.onFrame({ type: "state", sessionId: frame.chatId, isStreaming: transport.running.has(frame.chatId), isCompacting: false });
          handlers.onFrame({ type: "entries", sessionId: frame.chatId, entries: [], final: true });
        });
      }
      return true;
    }),
    // Closing a subscriber does not stop the provider run.
    close: vi.fn(() => transport.subscribers.delete(handlers)),
  };
}) }));

const stored = { id: "stored-a", name: "Stored A", provider: "omo" };
const newer = { id: "stored-new", name: "Newer", provider: "omo" };
const discovered = { id: "discovered-b", name: "Discovered B", source: "discovered", recencyMs: 30 };
const paged = { id: "discovered-c", name: "Discovered C", source: "discovered", recencyMs: 10 };
const unresolved = { id: "union-row", name: "Union row", source: "stored", recencyMs: 20 };

describe("App pane routing with real layout, sidebar, picker and chat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let narrow: boolean;
  let empty: boolean;
  let opening: ReturnType<typeof deferred<Terminal>>;
  let failPage: boolean;
  let failMore: boolean;
  let activeConflict: boolean;
  let requests: { path: string; method: string; body: string }[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    narrow = false; empty = false; failPage = false; failMore = false; activeConflict = false;
    requests = []; transport.frames.length = 0; transport.running.clear(); transport.subscribers.clear();
    opening = deferred<Terminal>();
    localStorage.setItem("th-lang", "en");
    localStorage.setItem("th-ws-expanded", '["ws"]');
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1024px)" ? !narrow : query === "(max-width: 768px)" && narrow,
      addEventListener() {}, removeEventListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class {
      observe() {} unobserve() {} disconnect() {}
    });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname;
      requests.push({ path: path + url.search, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (path === "/api/auth/check") return new Response(null, { status: 204 });
      if (path === "/api/login" || (path === "/api/workspaces/ws/chats/stored-a" && init?.method === "DELETE")) return new Response(null, { status: 204 });
      if (path === "/api/providers") return Response.json([{ id: "omo", available: true }]);
      if (path === "/api/workspaces") return Response.json([{ id: "ws", name: "Workspace", path: "/fixture", chats: [stored, newer] }]);
      if (path === "/api/layout") return Response.json({ layout: narrow
        ? { kind: "leaf", id: "left", sessionId: null }
        : { kind: "split", id: "split", dir: "h", ratio: 0.5,
            first: { kind: "leaf", id: "left", sessionId: empty ? null : stored.id },
            second: { kind: "leaf", id: "right", sessionId: null } } });
      if (path.endsWith("/sessions/open")) {
        if (activeConflict && !String(init?.body).includes('"force":true')) return Response.json({ state: "session-active" }, { status: 409 });
        return Response.json(await opening.promise);
      }
      if (path === "/api/workspaces/ws/chats" && init?.method === "POST") return Response.json(await opening.promise);
      if (path === "/api/workspaces/ws/sessions") {
        if (failPage || (failMore && url.searchParams.has("cursor"))) return new Response("failed", { status: 500 });
        return Response.json(url.searchParams.has("cursor") ? { items: [paged], nextCursor: "" } : {
          items: [discovered, unresolved, { ...stored, source: "stored", recencyMs: 15 }, { ...newer, source: "stored", recencyMs: 5 }], nextCursor: "page-2",
        });
      }
      if (path.endsWith("/goal")) return Response.json({ goal: null });
      if (path.endsWith("/activity")) return Response.json({ history: {} });
      if (path.startsWith("/api/sessions/")) return Response.json({ sessions: [] });
      throw new Error(`Unexpected fixture endpoint ${path}`);
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function mount() { await act(async () => root.render(<App />)); }
  function pane(index: number) {
    const result = container.querySelectorAll<HTMLElement>(".th-pane-wrap")[index];
    if (!result) throw new Error(`Missing pane ${index}`);
    return result;
  }
  function button(scope: ParentNode, selector: string) {
    const result = scope.querySelector<HTMLButtonElement>(selector);
    if (!result) throw new Error(`Missing button ${selector}`);
    return result;
  }
  async function click(target: HTMLElement) { await act(async () => target.click()); }
  async function focusPane(index: number) { await act(async () => button(pane(index), "button").focus()); }
  function row(scope: ParentNode, name: string) { return button(scope, `[aria-label="Workspace / ${name}"]`); }
  function sidebar(name: string) {
    const result = [...container.querySelectorAll<HTMLButtonElement>(".th-tree-children .th-tree-activation")].find(e => e.textContent === name);
    if (!result) throw new Error(`Missing sidebar row ${name}`);
    return result;
  }
  function title(index: number) { return pane(index).querySelector(".th-termhead-name")?.textContent ?? null; }
  function editor(index: number) {
    return requireElement(pane(index).querySelector<HTMLTextAreaElement>("textarea"), "Missing composer");
  }
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  async function draftWithImage(index: number, text: string) {
    act(() => setTextareaValue(editor(index), text));
    const loaded = deferred<void>();
    const read = FileReader.prototype.readAsDataURL;
    const reader = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader, file) {
      this.addEventListener("loadend", () => loaded.resolve(), { once: true });
      read.call(this, file);
    });
    const input = requireElement(pane(index).querySelector<HTMLInputElement>('input[type="file"]'), "Missing image picker");
    const file = new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "draft.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await loaded.promise;
    });
    reader.mockRestore();
  }
  function draft(index: number) {
    return { text: editor(index).value, image: pane(index).querySelector(".th-chat-attach-thumb")?.getAttribute("src") ?? null };
  }
  function assertNoDestructiveCalls() {
    expect(requests.filter(r => r.method === "DELETE" || /stop|disconnect/.test(r.path))).toEqual([]);
    expect(transport.frames.filter(frame => ["chat.abort", "chat.disconnect", "chat.close"].includes(frame.type))).toEqual([]);
  }

  it("moves a hosted session to the pointer-selected empty destination without import, stop or delete", async () => {
    await mount();
    act(() => pane(1).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await click(sidebar("Stored A"));
    expect([title(0), title(1)]).toEqual([null, "Stored A"]);
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
    expect(pane(1).querySelector(".th-pane--focused") ?? pane(1).matches(".th-pane--focused")).toBeTruthy();
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(0);
    expect(sidebar("Stored A").getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".th-tree-children .th-tree-activation")?.textContent).toBe("Stored A");
    assertNoDestructiveCalls();
  });
  it("replaces an occupied pane without aborting or disconnecting its session", async () => {
    await mount(); await click(sidebar("Newer"));
    expect([title(0), title(1)]).toEqual(["Newer", null]);
    expect(transport.frames.filter(frame => frame.type === "chat.create").map(frame => frame.chatId)).toEqual([stored.id, newer.id]);
    assertNoDestructiveCalls();
  });
  it("moves the mounted session's unsent text and PNG to the selected empty pane, then submits and resets once", async () => {
    await mount();
    await draftWithImage(0, "Unsent draft must follow Stored A");
    const expected = { text: "Unsent draft must follow Stored A", image: `data:image/png;base64,${png}` };
    expect(draft(0)).toEqual(expected);
    await act(async () => requireElement(pane(1).querySelector("select"), "Missing workspace selector").focus());
    await click(sidebar("Stored A"));
    expect([title(0), title(1)]).toEqual([null, "Stored A"]);
    expect(draft(1)).toEqual(expected);
    expect(container.querySelectorAll(".th-chat-input")).toHaveLength(1);
    expect(transport.frames.filter(frame => frame.type === "chat.send")).toEqual([]);
    assertNoDestructiveCalls();
    await click(button(pane(1), ".th-chat-send-btn"));
    expect(transport.frames.filter(frame => frame.type === "chat.send")).toEqual([
      expect.objectContaining({ sessionId: stored.id, run: { kind: "prompt", message: expected.text, images: [{ data: png, mimeType: "image/png" }] } }),
    ]);
    expect(draft(1)).toEqual({ text: "", image: null });
    await focusPane(0); await click(sidebar("Stored A"));
    expect(draft(0)).toEqual({ text: "", image: null });
  });
  it("keeps independent drafts with replaced sessions rather than the hosting pane", async () => {
    await mount(); await draftWithImage(0, "Stored A draft");
    await click(sidebar("Newer"));
    expect(draft(0)).toEqual({ text: "", image: null });
    act(() => setTextareaValue(editor(0), "Newer draft"));
    await focusPane(1); await click(sidebar("Stored A"));
    expect(draft(1)).toEqual({ text: "Stored A draft", image: `data:image/png;base64,${png}` });
    expect(draft(0)).toEqual({ text: "Newer draft", image: null });
    assertNoDestructiveCalls();
  });
  it("reattaches a running session after move and replacement, retaining Stop and later provider events", async () => {
    transport.running.add(stored.id);
    await mount();
    expect(button(pane(0), ".th-chat-send-btn").type).toBe("button");
    expect(pane(0).querySelector(".th-chat-status-item--live")).not.toBeNull();
    await focusPane(1); await click(sidebar("Stored A"));
    expect(button(pane(1), ".th-chat-send-btn").textContent).toBe("Stop");
    await click(sidebar("Newer"));
    expect(button(pane(1), ".th-chat-send-btn").type).toBe("submit");
    expect(transport.running.has(stored.id)).toBe(true);
    await focusPane(0); await click(sidebar("Stored A"));
    expect(button(pane(0), ".th-chat-send-btn").textContent).toBe("Stop");
    expect([...transport.subscribers.values()].filter(id => id === stored.id)).toHaveLength(1);
    await act(async () => transport.deliver({ type: "messageDelta", sessionId: stored.id, delta: { kind: "text_delta", delta: "The original run continues after reattachment" } }));
    expect(pane(0).textContent).toContain("The original run continues after reattachment");
    await act(async () => transport.deliver({ type: "run.done", sessionId: stored.id, reason: "stop" }));
    expect(button(pane(0), ".th-chat-send-btn").type).toBe("submit");
    expect(pane(0).querySelector(".th-chat-status-item--live")).toBeNull();
    assertNoDestructiveCalls();
  });
  it("does not share drafts with a second App instance", async () => {
    await mount(); await draftWithImage(0, "Private to the first App");
    const other = document.createElement("div"); document.body.append(other);
    const otherRoot = createRoot(other);
    try {
      await act(async () => otherRoot.render(<App />));
      expect(requireElement(other.querySelector("textarea"), "Missing second App composer").value).toBe("");
      expect(other.querySelector(".th-chat-attach-chip")).toBeNull();
      expect(draft(0).text).toBe("Private to the first App");
    } finally {
      await act(async () => otherRoot.unmount()); other.remove();
    }
  });
  it("clears session drafts at the authentication boundary", async () => {
    await mount(); await draftWithImage(0, "Private to this login");
    await act(async () => notifyUnauthorized());
    const password = requireElement(container.querySelector<HTMLInputElement>('input[type="password"]'), "Missing login");
    const set = requireElement(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set, "Missing input setter");
    act(() => { set.call(password, "fixture"); password.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(button(container, '.th-login button[type="submit"]'));
    expect(draft(0)).toEqual({ text: "", image: null });
  });
  it("forgets a deleted session's draft before the same identity is opened again", async () => {
    await mount(); await draftWithImage(0, "Deleted draft");
    const storedRow = requireElement(sidebar("Stored A").parentElement, "Missing session row");
    await click(button(storedRow, '.th-tree-actions .th-btn-icon--danger'));
    await click(button(document, '.th-confirm-actions .th-btn--danger'));
    expect(title(0)).toBeNull();
    await click(row(pane(0), "Discovered B"));
    await act(async () => opening.resolve({ ...stored, provider: "omo" }));
    expect(title(0)).toBe("Stored A");
    expect(draft(0)).toEqual({ text: "", image: null });
    expect(requests.filter(r => r.method === "DELETE")).toHaveLength(1);
  });
  it.each(["older-first", "newer-first"])("keeps the newest same-source pane intent when responses arrive %s", async order => {
    empty = true; await mount();
    const oldRequest = opening;
    await click(row(pane(1), "Discovered B"));
    opening = deferred<Terminal>();
    await click(row(pane(0), "Discovered B"));
    const shared: Terminal = { id: "shared", name: "Shared", provider: "omo" };
    const first = order === "older-first" ? oldRequest : opening;
    const last = order === "older-first" ? opening : oldRequest;
    await act(async () => first.resolve(shared));
    const intermediate = [title(0), title(1)];
    await act(async () => last.resolve(shared));
    expect(intermediate).toEqual(order === "older-first" ? [null, null] : ["Shared", null]);
    expect([title(0), title(1)]).toEqual(["Shared", null]);
    assertNoDestructiveCalls();
  });
  it("does not steal a canonical chat selected elsewhere while its discovered alias was opening", async () => {
    await mount(); await click(row(pane(1), "Discovered B"));
    await focusPane(0); await click(sidebar("Stored A"));
    await act(async () => opening.resolve({ ...stored, provider: "omo" }));
    expect([title(0), title(1)]).toEqual(["Stored A", null]);
    expect(sidebar("Stored A").getAttribute("aria-current")).toBe("true");
    assertNoDestructiveCalls();
  });
  it("compares canonical placement intents even when two discovered aliases differ", async () => {
    empty = true; await mount();
    const oldRequest = opening;
    await click(row(pane(1), "Discovered B"));
    await click(button(pane(0), ".th-picker-load-more"));
    opening = deferred<Terminal>(); await click(row(pane(0), "Discovered C"));
    const shared: Terminal = { id: "shared", name: "Shared", provider: "omo" };
    await act(async () => opening.resolve(shared));
    expect([title(0), title(1)]).toEqual(["Shared", null]);
    await act(async () => oldRequest.resolve(shared));
    expect([title(0), title(1)]).toEqual(["Shared", null]);
    assertNoDestructiveCalls();
  });
  it("allows independent session choices in other panes while a discovered open completes", async () => {
    await mount(); await click(row(pane(1), "Discovered B"));
    await focusPane(0); await click(sidebar("Newer"));
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect([title(0), title(1)]).toEqual(["Newer", "Opened B"]);
    assertNoDestructiveCalls();
  });
  it("activates occupied and empty panes by keyboard while portal focus preserves the active destination", async () => {
    await mount(); await focusPane(1);
    expect(pane(1).matches(".th-pane--focused")).toBe(true);
    await click(button(pane(0), '.th-disconnect-btn'));
    expect(pane(1).matches(".th-pane--focused")).toBe(true);
    await click(button(document, '.th-confirm-actions .th-btn--ghost'));
    await focusPane(0);
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
  });
  it("opens discovered rows through the empty picker and preserves the captured target across focus changes", async () => {
    await mount(); await click(row(pane(1), "Discovered B")); await focusPane(0);
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect([title(0), title(1)]).toEqual(["Stored A", "Opened B"]);
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(1);
  });
  it.each(["newer", "closed"])("drops a deferred sidebar open when its destination is %s", async (mode) => {
    await mount(); await focusPane(1); await click(sidebar("Discovered B"));
    if (mode === "newer") await click(sidebar("Newer"));
    else await click(button(pane(1), '[aria-label="Close pane"]'));
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect(container.querySelectorAll(".th-termhead-name")).toHaveLength(mode === "newer" ? 2 : 1);
    expect([...container.querySelectorAll(".th-termhead-name")].map(e => e.textContent)).toEqual(mode === "newer" ? ["Stored A", "Newer"] : ["Stored A"]);
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
    assertNoDestructiveCalls();
  });
  it.each([false, true])("pages and opens discovered sessions in the shared empty surface (narrow=%s)", async (mobile) => {
    narrow = mobile; empty = true; await mount();
    const surface = narrow ? button(container, ".th-empty").parentElement ?? container : pane(1);
    expect(row(surface, "Stored A")).toBeDefined(); expect(row(surface, "Union row")).toBeDefined();
    await click(button(surface, ".th-picker-load-more"));
    await click(row(surface, "Discovered C"));
    await act(async () => opening.resolve({ id: "opened-c", name: "Opened C", provider: "omo" }));
    expect(container.querySelectorAll(".th-termhead-name")).toHaveLength(1);
    expect(container.querySelector(".th-termhead-name")?.textContent).toBe("Opened C");
  });
  it.each(["newer", "closed"])("keeps new-chat completion from replacing a %s target", async (mode) => {
    await mount(); await click(button(pane(1), ".th-picker-pane-create button"));
    expect(requests.filter(r => r.method === "POST" && r.path.endsWith("/chats"))).toHaveLength(1);
    if (mode === "newer") { await focusPane(1); await click(sidebar("Newer")); }
    else await click(button(pane(1), '[aria-label="Close pane"]'));
    await act(async () => opening.resolve({ id: "created", name: "Created", provider: "omo" }));
    expect([...container.querySelectorAll(".th-termhead-name")].map(e => e.textContent)).toEqual(mode === "newer" ? ["Stored A", "Newer"] : ["Stored A"]);
  });
  it("lands deferred New Chat in its captured pane while later active and DOM focus stay authoritative", async () => {
    await mount();
    await act(async () => button(pane(1), ".th-picker-pane-create button").focus());
    await click(button(pane(1), ".th-picker-pane-create button"));
    const files = button(pane(0), ".th-files-toggle");
    await act(async () => files.focus());
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
    expect(document.activeElement).toBe(files);
    await act(async () => opening.resolve({ id: "created", name: "Created", provider: "omo" }));
    expect([title(0), title(1)]).toEqual(["Stored A", "Created"]);
    expect(document.activeElement).toBe(files);
    expect(pane(0).querySelector(".th-pane--focused")).not.toBeNull();
    expect(container.querySelectorAll(".th-pane--focused")).toHaveLength(1);
    await click(sidebar("Newer"));
    expect([title(0), title(1)]).toEqual(["Newer", "Created"]);
  });
  it("opens an unresolved stored row without a preparation request", async () => {
    await mount(); await click(row(pane(1), "Union row"));
    expect(title(1)).toBe("Union row");
    expect(requests.filter(r => r.path.endsWith("/sessions/open"))).toHaveLength(0);
  });
  it("shows first-page failure and supports explicit retry without a fetch loop", async () => {
    failPage = true; await mount();
    expect(pane(1).querySelector('[role="alert"]')).not.toBeNull();
    failPage = false; await click(button(pane(1), ".th-picker-page-retry"));
    expect(row(pane(1), "Discovered B")).toBeDefined();
  });
  it("retains loaded rows and exposes retry after a continuation failure", async () => {
    await mount(); failMore = true; await click(button(pane(1), ".th-picker-load-more"));
    expect(pane(1).querySelector('[role="alert"]')).not.toBeNull();
    expect(row(pane(1), "Stored A")).toBeDefined();
    failMore = false; await click(button(pane(1), ".th-picker-page-retry"));
    expect(row(pane(1), "Discovered C")).toBeDefined();
  });
  it("keeps session-active recovery explicit and opens exactly once on force", async () => {
    activeConflict = true; await mount(); await click(row(pane(1), "Discovered B"));
    expect(pane(1).querySelector('[role="status"]')).not.toBeNull();
    await click(button(pane(1), ".th-picker-force-open"));
    await act(async () => opening.resolve({ id: "opened-b", name: "Opened B", provider: "omo" }));
    expect(title(1)).toBe("Opened B");
    expect(requests.filter(r => r.path.endsWith("/sessions/open")).map(r => JSON.parse(r.body).force ?? false)).toEqual([false, true]);
  });
});
