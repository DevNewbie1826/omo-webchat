import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConnector, ChatServerFrame } from "../../lib/chatWs";
import { useChatSession } from "./useChatSession";

const session = {
  id: "chat-goal",
  name: "Goal",
  wsId: "workspace-goal",
  cwd: "/work",
  provider: "omo",
} as const;

function goalFrame(goal: unknown): ChatServerFrame {
  return { type: "chat.goal", sessionId: session.id, goal } as ChatServerFrame;
}

describe("useChatSession live goal updates", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useChatSession> | undefined;
  let deliver: (frame: ChatServerFrame) => void;
  let resolvers: Map<string, (response: Response) => void>;

  const render = (): void => {
    const connect: ChatConnector = (handlers) => {
      deliver = handlers.onFrame;
      handlers.onOpen?.();
      return { send: () => true, close: () => undefined };
    };
    function Probe() {
      const chat = useChatSession(session, connect);
      current = chat;
      return null;
    }
    act(() => root.render(<Probe />));
  };

  const resolveGoal = async (body: unknown): Promise<void> => {
    const resolve = resolvers.get("/api/workspaces/workspace-goal/chats/chat-goal/goal");
    if (!resolve) throw new Error("goal fetch not started");
    await act(async () => {
      resolve(new Response(JSON.stringify(body), { status: 200 }));
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resolvers = new Map();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      resolvers.set(String(input), resolve);
    })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("hydrates the goal from REST at attach", async () => {
    render();
    await resolveGoal({ goal: { objective: "골 상태 실시간 웹 표시", status: "active" } });
    expect(current?.goal?.objective).toBe("골 상태 실시간 웹 표시");
    expect(current?.goal?.status).toBe("active");
  });

  it("stays null when the chat has no goal", async () => {
    render();
    await resolveGoal({ goal: null });
    expect(current?.goal).toBeNull();
  });

  it("lets a live push outrank an in-flight REST response", async () => {
    render();
    act(() => deliver(goalFrame({ objective: "pushed objective", status: "blocked", blockedReason: "halted" })));
    await resolveGoal({ goal: { objective: "stale rest objective", status: "active" } });
    expect(current?.goal?.objective).toBe("pushed objective");
    expect(current?.goal?.blockedReason).toBe("halted");
  });

  it("applies pushes that arrive after hydration", async () => {
    render();
    await resolveGoal({ goal: null });
    expect(current?.goal).toBeNull();
    act(() => deliver(goalFrame({ objective: "new goal", status: "active", updatedAt: 1788448206 })));
    expect(current?.goal?.objective).toBe("new goal");
    act(() => deliver(goalFrame(null)));
    expect(current?.goal).toBeNull();
  });
});
