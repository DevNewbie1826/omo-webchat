import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatClientFrame, ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { COMPACT_COMMAND } from "./curatedCommands";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-1",
  name: "Chat",
  wsId: "workspace-1",
  cwd: "/work",
  provider: "omo",
} as const;

describe("useChatSession manual compaction", () => {
  let root: Root;
  let container: HTMLDivElement;
  let deliver: ((frame: ChatServerFrame) => void) | undefined;
  let current: ReturnType<typeof useChatSession> | undefined;
  let sent: ChatClientFrame[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    sent = [];
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
      return {
        send: (frame) => {
          sent.push(frame);
          return true;
        },
        close: () => undefined,
      };
    };
    function Probe() {
      current = useChatSession(session, connect);
      return null;
    }
    act(() => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  const compactFrames = (): ChatClientFrame[] => sent.filter((frame) => frame.type === "chat.compact");
  const promptFrames = (): ChatClientFrame[] => sent.filter((frame) => frame.type === "chat.send");

  it("routes an exact /compact submission to chat.compact with no prompt and no optimistic message", () => {
    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "  /compact  ", image: null }) ?? false;
    });

    expect(accepted).toBe(true);
    expect(compactFrames()).toEqual([{ type: "chat.compact", sessionId: "chat-1" }]);
    expect(promptFrames()).toHaveLength(0);
    expect(current?.messages).toEqual([]);
  });

  it("still sends /compact with arguments as an ordinary prompt", () => {
    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "/compact aggressive", image: null }) ?? false;
    });

    expect(accepted).toBe(true);
    expect(compactFrames()).toHaveLength(0);
    expect(promptFrames()).toEqual([
      { type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "/compact aggressive" } },
    ]);
  });

  it("never hijacks a provider-advertised manually typed /compact", () => {
    act(() => {
      deliver?.({
        type: "commands",
        sessionId: "chat-1",
        commands: [{ name: "compact", source: "extension", syntax: "slash" }],
      });
    });

    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(compactFrames()).toHaveLength(0);
    expect(promptFrames()).toEqual([
      { type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "/compact" } },
    ]);
  });

  it("preserves curated compact identity through a later provider command refresh", () => {
    act(() => {
      deliver?.({
        type: "commands",
        sessionId: "chat-1",
        commands: [{ name: "compact", source: "extension", syntax: "slash" }],
      });
    });
    act(() => {
      deliver?.({ type: "commands", sessionId: "chat-1", commands: [] });
    });

    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null, command: COMPACT_COMMAND }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(compactFrames()).toEqual([{ type: "chat.compact", sessionId: "chat-1" }]);
    expect(promptFrames()).toHaveLength(0);
  });

  it("keeps an explicit provider compact selection on the prompt path after refresh removes it", () => {
    const providerCompact = { name: "compact", source: "extension", syntax: "slash" } as const;
    act(() => {
      deliver?.({ type: "commands", sessionId: "chat-1", commands: [providerCompact] });
      deliver?.({ type: "commands", sessionId: "chat-1", commands: [] });
    });

    let accepted = false;
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null, command: providerCompact }) ?? false;
    });

    expect(accepted).toBe(true);
    expect(compactFrames()).toHaveLength(0);
    expect(promptFrames()).toEqual([
      { type: "chat.send", sessionId: "chat-1", run: { kind: "prompt", message: "/compact" } },
    ]);
  });

  it("keeps exact /compact with an image on the prompt path", () => {
    let accepted = false;
    act(() => {
      accepted = current?.submit({
        text: "/compact",
        image: { name: "context.png", mimeType: "image/png", data: "YWJj" },
      }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(compactFrames()).toHaveLength(0);
    expect(promptFrames()).toEqual([
      {
        type: "chat.send",
        sessionId: "chat-1",
        run: { kind: "prompt", message: "/compact", images: [{ mimeType: "image/png", data: "YWJj" }] },
      },
    ]);
  });

  it("rejects a prompt during compaction without an optimistic message", () => {
    act(() => {
      deliver?.({ type: "compaction.started", sessionId: "chat-1" });
    });
    let accepted = true;
    act(() => {
      accepted = current?.submit({ text: "not now", image: null }) ?? true;
    });
    expect(accepted).toBe(false);
    expect(promptFrames()).toHaveLength(0);
    expect(current?.messages).toEqual([]);
    expect(current?.error).toContain("compact");
  });

  it("tracks compaction.started and compaction.done, reporting a failed compaction", () => {
    act(() => {
      deliver?.({ type: "compaction.started", sessionId: "chat-1" });
    });
    expect(current?.isCompacting).toBe(true);

    // A failed compaction surfaces its error on the live error surface.
    act(() => {
      deliver?.({ type: "compaction.done", sessionId: "chat-1", error: "Nothing to compact" });
    });
    expect(current?.isCompacting).toBe(false);
    expect(current?.error).toBe("Nothing to compact");

    // A later compaction clears the stale error; a clean completion keeps it clear.
    act(() => {
      deliver?.({ type: "compaction.started", sessionId: "chat-1" });
    });
    expect(current?.error).toBe("");
    act(() => {
      deliver?.({ type: "compaction.done", sessionId: "chat-1" });
    });
    expect(current?.isCompacting).toBe(false);
    expect(current?.error).toBe("");
  });

  it("rejects a repeated compact while one is already in progress", () => {
    act(() => {
      deliver?.({ type: "compaction.started", sessionId: "chat-1" });
    });

    let accepted = true;
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null }) ?? true;
    });

    expect(accepted).toBe(false);
    expect(compactFrames()).toHaveLength(0);
    expect(current?.error).toContain("already in progress");
  });

  it("rejects a compact while a run is active and allows it once the run ends", () => {
    act(() => {
      deliver?.({ type: "run.started", sessionId: "chat-1" });
    });

    let accepted = true;
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null }) ?? true;
    });
    expect(accepted).toBe(false);
    expect(compactFrames()).toHaveLength(0);
    expect(promptFrames()).toHaveLength(0);

    act(() => {
      deliver?.({ type: "run.done", sessionId: "chat-1", reason: "stop" });
    });
    act(() => {
      accepted = current?.submit({ text: "/compact", image: null }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(compactFrames()).toHaveLength(1);
  });
});
