import { describe, expect, it, vi } from "vitest";
import { ChatSendStore } from "./chatSendState";

const draft = { text: "  /wish original  ", image: { data: "AAAA", mimeType: "image/png", name: "original.png" }, command: { name: "wish", description: "Wish" } };
describe("ChatSendStore", () => {
  it("retains the immutable original separately from the trimmed wire text", () => {
    const store = new ChatSendStore();
    store.register("r", "prompt", draft, 1);
    expect(store.get("r")).toMatchObject({ draft, text: "/wish original", phase: "sending", hold: true });
    store.admit("r");
    expect(store.get("r")?.phase).toBe("admitted");
    store.complete("r");
    expect(store.getSnapshot()).toEqual([]);
    expect(store.terminal("r")).toBe("completed");
  });
  it("ignores unowned outcomes without claiming their replay identity", () => {
    const store = new ChatSendStore();
    expect(store.fail("r")).toBeUndefined();
    expect(store.complete("r")).toBe(false);
    expect(store.terminal("r")).toBeUndefined();
    store.register("r", "prompt", draft, 1);
    expect(store.fail("r")?.draft).toBe(draft);
  });
  it.each(["completed", "failed"] as const)("does not regress terminal %s on replay", outcome => {
    const store = new ChatSendStore(); store.register("r", "prompt", draft, 1);
    if (outcome === "completed") store.complete("r"); else store.fail("r");
    const snapshot = store.getSnapshot();
    store.admit("r"); store.complete("r"); store.fail("r"); store.rollback("r");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.terminal("r")).toBe(outcome);
  });
  it("disconnect captures only unresolved requests belonging to that socket", () => {
    const store = new ChatSendStore();
    store.register("A", "prompt", draft, 1); store.register("B", "queued", draft, 2);
    store.disconnect(1); store.admit("A");
    expect(store.get("A")).toMatchObject({ phase: "unknown", hold: false });
    expect(store.get("B")).toMatchObject({ phase: "sending" });
    store.complete("A");
    expect(store.getSnapshot().map(request => request.requestId)).toEqual(["B"]);
  });
  it.each([true, false])("retains queue ownership across failure-first=%s without local recovery", failureFirst => {
    const store = new ChatSendStore(); store.register("r", "queued", draft, 1);
    if (failureFirst) store.fail("r");
    store.handoff(new Set(["r"]));
    if (!failureFirst) store.fail("r");
    expect(store.get("r")).toBeUndefined();
    expect(store.terminal("r")).toBe("queueFailed");
    expect(store.getSnapshot()).toEqual([]);
  });
  it("releases queue-owned originals at handoff without claiming send success", () => {
    const store = new ChatSendStore(); store.register("r", "queued", draft, 1);
    store.handoff(new Set(["r"]));
    expect(store.getSnapshot()).toEqual([]);
    expect(store.terminal("r")).toBe("queued");
    store.handoff(new Set());
    expect(store.getSnapshot()).toEqual([]);
    expect(store.terminal("r")).toBe("queued");
  });
  it.each([true, false])("accepts eventual queue completion after failure-first=%s without retaining the original", failureFirst => {
    const store = new ChatSendStore(); store.register("r", "queued", draft, 1);
    if (failureFirst) store.fail("r");
    store.handoff(new Set(["r"]));
    if (!failureFirst) store.fail("r");
    expect(store.complete("r")).toBe(true);
    expect(store.getSnapshot()).toEqual([]);
    expect(store.terminal("r")).toBe("completed");
    expect(store.fail("r")).toBeUndefined();
    store.handoff(new Set(["r"]));
    expect(store.terminal("r")).toBe("completed");
  });
  it("bounds queue ownership receipts without retaining removed or cleared drafts", () => {
    const store = new ChatSendStore();
    for (let i = 0; i < 513; i++) {
      store.register(String(i), "queued", draft, 1);
      store.handoff(new Set([String(i)]));
      store.handoff(new Set());
    }
    expect(store.getSnapshot()).toEqual([]);
    expect(store.terminal("0")).toBeUndefined();
    expect(store.terminal("512")).toBe("queued");
  });
  it("run.done retires prompt holds and steer display without settling outcomes or pending queue handoff", () => {
    const store = new ChatSendStore();
    for (const kind of ["prompt", "queued", "steer"] as const) store.register(kind, kind, draft, 1);
    store.endRun();
    expect(store.get("prompt")).toMatchObject({ phase: "unknown", hold: false });
    expect(store.get("steer")).toMatchObject({ phase: "unknown", showSteer: false });
    expect(store.get("queued")).toMatchObject({ phase: "sending", queueOwned: false });
    expect(store.fail("steer")?.draft).toBe(draft);
  });
  it("recovery releases the payload exactly once and makes late frames harmless", () => {
    const store = new ChatSendStore(); store.register("r", "prompt", draft, 1); store.disconnect(1);
    expect(store.retire("r")).toBe(draft);
    expect(store.retire("r")).toBeUndefined();
    expect(store.fail("r")).toBeUndefined();
    expect(store.complete("r")).toBe(false);
    expect(store.getSnapshot()).toEqual([]);
  });
  it("bounds terminal IDs at 512 without retaining completed image payloads", () => {
    const store = new ChatSendStore();
    for (let i = 0; i < 513; i++) { store.register(String(i), "prompt", draft, 1); store.complete(String(i)); }
    expect(store.terminal("0")).toBeUndefined();
    expect(store.terminal("1")).toBe("completed");
    expect(store.terminal("512")).toBe("completed");
    expect(store.getSnapshot()).toEqual([]);
  });
  it("bounds retained recovery at 20 without evicting active sends", () => {
    const store = new ChatSendStore(); store.register("active", "queued", draft, 2);
    for (let i = 0; i < 21; i++) { store.register(String(i), "prompt", draft, 1); store.fail(String(i)); }
    expect(store.getSnapshot()).toHaveLength(21);
    expect(store.get("active")?.phase).toBe("sending");
    expect(store.get("0")).toBeUndefined();
    expect(store.get("20")?.draft).toBe(draft);
    expect(store.terminal("0")).toBe("dismissed");
  });
  it("notifies subscribed views synchronously and stops notifying after teardown", () => {
    const store = new ChatSendStore(); const listener = vi.fn(); const remove = store.subscribe(listener);
    store.register("r", "prompt", draft, 1); expect(listener).toHaveBeenCalledOnce();
    remove(); store.complete("r"); expect(listener).toHaveBeenCalledOnce();
  });
});
