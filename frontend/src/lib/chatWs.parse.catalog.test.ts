import { describe, expect, it } from "vitest";
import { parseChatServerFrame } from "./chatWs";

describe("parseChatServerFrame", () => {
  it("parses raw JSON errors for every established backend code", () => {
    const codes = [
      "pi_eof", "resume_failed", "session_unloaded", "session_mismatch", "prompt_in_flight",
      "compaction_in_flight", "provider_error", "persist_failed", "decode_failed", "bad_frame",
      "unknown_type", "bad_create", "bad_provider", "no_workspace", "no_chat", "start_failed",
      "initialize_failed", "provider_overflow", "provider_timeout", "bad_approval", "bad_resume",
      "bad_send", "bad_set", "no_session", "send_failed", "compact_failed",
    ];
    for (const code of codes) {
      const raw = JSON.stringify({ type: "error", sessionId: "c1", code, message: code });
      expect(parseChatServerFrame(JSON.parse(raw))).toMatchObject({ type: "error", code, message: code });
    }
  });

  it("preserves the input modalities field on each model", () => {
    const frame = parseChatServerFrame({
      type: "models",
      sessionId: "c1",
      models: [
        { provider: "zai", modelId: "glm-5.2", input: ["text"] },
        { provider: "moonshot", modelId: "kimi-k2.5", input: ["text", "image"] },
      ],
    });
    if (frame?.type !== "models") throw new Error("expected models frame");
    expect(frame.models[0]?.input).toEqual(["text"]);
    expect(frame.models[1]?.input).toEqual(["text", "image"]);
  });

  it("validates every command and model entry", () => {
    expect(
      parseChatServerFrame({
        type: "commands",
        sessionId: "c1",
        commands: [{ name: "/help", description: "help" }, { name: "/clear" }],
      }),
    ).toMatchObject({ type: "commands" });
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ description: "no name" }] })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "/x", description: 5 }] })).toBeNull();
    expect(
      parseChatServerFrame({ type: "models", sessionId: "c1", models: [{ provider: "omo", modelId: "m1", name: "M" }] }),
    ).toMatchObject({ type: "models" });
    expect(parseChatServerFrame({ type: "models", sessionId: "c1", models: [{ provider: "omo" }] })).toBeNull();
  });

  it("sanitizes opaque history entries instead of forwarding raw JSON", () => {
    const frame = parseChatServerFrame({
      type: "entries",
      sessionId: "c1",
      entries: JSON.parse('[{"type":"message","message":{"role":"user","content":"hi","__proto__":{"bad":true}}}]'),
      leafId: "leaf",
      final: true,
    });
    expect(frame).toMatchObject({ type: "entries", leafId: "leaf" });
    const entries = frame?.type === "entries" ? (frame.entries as unknown as Array<Record<string, unknown>>) : [];
    const message = entries[0]?.["message"] as Record<string, unknown>;
    expect(Object.keys(message ?? {}).includes("__proto__")).toBe(false);
    expect(message?.["content"]).toBe("hi");
  });

  it("requires entries.final on every page (invariant 18) and an array payload", () => {
    const base = { type: "entries", sessionId: "c1", entries: [] as readonly unknown[] };
    expect(parseChatServerFrame({ ...base, final: true })).toMatchObject({ type: "entries", final: true });
    expect(parseChatServerFrame({ ...base, final: false })).toMatchObject({ type: "entries", final: false });
    expect(parseChatServerFrame({ ...base })).toBeNull();
    expect(parseChatServerFrame({ ...base, final: "no" })).toBeNull();
    expect(parseChatServerFrame({ ...base, final: true, entries: "nope" })).toBeNull();
  });

  it("keeps the real Omo command fields (syntax, sourceInfo) and drops location", () => {
    const frame = parseChatServerFrame({
      type: "commands",
      sessionId: "c1",
      commands: [
        {
          name: "hooks",
          description: "Inspect loaded builtin hook sources and diagnostics.",
          source: "extension",
          syntax: "slash",
          sourceInfo: { path: "<builtin:hooks>", baseDir: "/workspace", source: "builtin", scope: "temporary", origin: "top-level" },
        },
      ],
    });
    const entry = frame?.type === "commands" ? frame.commands[0] : undefined;
    expect(entry).toEqual({
      name: "hooks",
      description: "Inspect loaded builtin hook sources and diagnostics.",
      source: "extension",
      syntax: "slash",
      sourceInfo: { path: "<builtin:hooks>", baseDir: "/workspace", source: "builtin", scope: "temporary", origin: "top-level" },
    });
    // Partial sourceInfo is still valid; the retired fake field never survives.
    const partial = parseChatServerFrame({
      type: "commands",
      sessionId: "c1",
      commands: [{ name: "x", sourceInfo: { path: "~/.omo/x.md" }, location: "project" }],
    });
    const partialEntry = partial?.type === "commands" ? partial.commands[0] : undefined;
    expect(partialEntry?.sourceInfo).toEqual({ path: "~/.omo/x.md" });
    expect(parseChatServerFrame({
      type: "commands",
      sessionId: "c1",
      commands: [{ name: "x", sourceInfo: { path: "~/.omo/x.md", baseDir: "/workspace" } }],
    })).toMatchObject({ commands: [{ sourceInfo: { baseDir: "/workspace" } }] });
    expect("location" in (partialEntry ?? {})).toBe(false);
    // Malformed command metadata rejects the whole frame.
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", syntax: 5 }] })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", sourceInfo: "builtin" }] })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", sourceInfo: { path: 5 } }] })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", sourceInfo: { baseDir: 5 } }] })).toBeNull();
    const inherited = Object.create({ baseDir: "/inherited" }) as Record<string, unknown>;
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", sourceInfo: inherited }] })).toBeNull();
    expect(parseChatServerFrame({ type: "commands", sessionId: "c1", commands: [{ name: "x", sourceInfo: null }] })).toBeNull();
  });
});
