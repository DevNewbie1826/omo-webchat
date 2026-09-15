import { afterEach, describe, expect, it, vi } from "vitest";
import { parseChatServerFrame } from "./chatWsParse";

/**
 * Safety net for request frames the panel cannot fully render: a frame that
 * carries an id and a prompt-like payload but a method or shape this client
 * does not recognise must surface as a minimal fallback instead of vanishing.
 */
describe("unknown approval request safety net", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces an unknown-method approval request as a fallback frame instead of dropping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = {
      type: "approval",
      sessionId: "s",
      id: "u1",
      method: "gate.alpha",
      title: "Deploy to prod?",
      message: "Approve the rollout",
    };

    const parsed = parseChatServerFrame(raw);

    expect(parsed).toMatchObject({
      type: "approval",
      fallback: true,
      id: "u1",
      method: "gate.alpha",
      title: "Deploy to prod?",
      message: "Approve the rollout",
    });
    // Logged once in the console, naming the unknown method.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("gate.alpha");
    // A replay of the same method never floods the console.
    expect(parseChatServerFrame(raw)).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs each distinct unknown method once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    parseChatServerFrame({ type: "approval", sessionId: "s", id: "u2", method: "gate.beta" });
    parseChatServerFrame({ type: "approval", sessionId: "s", id: "u3", method: "gate.gamma" });
    parseChatServerFrame({ type: "approval", sessionId: "s", id: "u4", method: "gate.beta" });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("falls back for a known method whose shape the panel cannot render", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const parsed = parseChatServerFrame({
      type: "approval",
      sessionId: "s",
      id: "m1",
      method: "select",
      title: "Pick one",
      options: "not-a-list",
    });

    expect(parsed).toMatchObject({
      type: "approval",
      fallback: true,
      id: "m1",
      method: "select",
      title: "Pick one",
    });
  });

  it("still ignores an approval frame without an id, logging it once with the method name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      parseChatServerFrame({ type: "approval", sessionId: "s", method: "gate.delta", message: "hi" }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("gate.delta");

    expect(parseChatServerFrame({ type: "approval", sessionId: "s", method: "gate.delta" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps known approval frames exactly as parsed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = { type: "approval", sessionId: "s", id: "a1", method: "select", options: ["yes", "no"] };

    expect(parseChatServerFrame(raw)).toEqual(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps non-request frames dropped silently as before", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(parseChatServerFrame({ type: "mystery", sessionId: "s", id: "x" })).toBeNull();
    expect(parseChatServerFrame("not a frame")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
