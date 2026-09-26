import { describe, expect, it } from "vitest";
import { resolveLiveSummaryTarget } from "./liveSummaryTarget";
import type { Workspace, WorkspaceSession } from "./workspace";

const workspaces: readonly Workspace[] = [
  {
    id: "ws-1",
    name: "Workspace One",
    path: "/one",
    chats: [{ id: "chat-1", name: "Stored chat", provider: "omo" }],
  },
  { id: "ws-2", name: "Workspace Two", path: "/two", chats: [] },
];

const chatRow: WorkspaceSession = { id: "chat-1", name: "Stored chat", source: "stored", recencyMs: 5 };
const diskRow: WorkspaceSession = {
  id: "disk-2",
  name: "Disk session",
  source: "discovered",
  recencyMs: 1,
  resumeIdentity: "/s/disk-2.jsonl",
};
const sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]> = new Map([
  ["ws-1", [chatRow]],
  ["ws-2", [diskRow]],
]);

describe("resolveLiveSummaryTarget", () => {
  it("resolves a stored chat to its workspace and terminal", () => {
    expect(resolveLiveSummaryTarget({ id: "chat-1" }, workspaces, sessionLists))
      .toEqual({ kind: "chat", workspace: workspaces[0], terminal: workspaces[0]!.chats[0] });
  });

  it("resolves a loaded session row through the session-catalog path", () => {
    expect(resolveLiveSummaryTarget({ id: "disk-2" }, workspaces, sessionLists))
      .toEqual({ kind: "session", workspace: workspaces[1], session: diskRow });
  });

  it("prefers the stored chat when the id is both a chat and a loaded row", () => {
    expect(resolveLiveSummaryTarget({ id: "chat-1" }, workspaces, sessionLists))
      .toMatchObject({ kind: "chat", workspace: workspaces[0] });
  });

  it("returns null for an engine-UUID row no stored chat or loaded row owns", () => {
    expect(resolveLiveSummaryTarget({ id: "durable-uuid-9" }, workspaces, sessionLists)).toBeNull();
  });

  it("returns null when no workspace is loaded at all", () => {
    expect(resolveLiveSummaryTarget({ id: "chat-1" }, [], sessionLists)).toBeNull();
  });
});
