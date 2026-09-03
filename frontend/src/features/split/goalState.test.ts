import { describe, expect, it } from "vitest";
import { parseChatGoalResponse } from "./goalState";

describe("goalState REST parsing", () => {
  it("parses a full goal document", () => {
    const goal = parseChatGoalResponse({
      goal: {
        objective: "골 상태 실시간 웹 표시",
        status: "active",
        createdAt: 1788430891,
        updatedAt: 1788448206,
      },
    });
    expect(goal).toEqual({
      objective: "골 상태 실시간 웹 표시",
      status: "active",
      createdAt: 1788430891,
      updatedAt: 1788448206,
    });
  });

  it("parses blocked goals with their reason", () => {
    const goal = parseChatGoalResponse({
      goal: { objective: "x", status: "blocked", blockedReason: "user interrupted the turn" },
    });
    expect(goal?.blockedReason).toBe("user interrupted the turn");
  });

  it("returns null for a goal-less response", () => {
    expect(parseChatGoalResponse({ goal: null })).toBeNull();
  });

  it("rejects malformed goal payloads", () => {
    expect(parseChatGoalResponse(null)).toBeNull();
    expect(parseChatGoalResponse({})).toBeNull();
    expect(parseChatGoalResponse({ goal: {} })).toBeNull();
    expect(parseChatGoalResponse({ goal: { objective: 5, status: "active" } })).toBeNull();
    expect(parseChatGoalResponse({ goal: { objective: "x", status: "active", createdAt: "soon" } })).toBeNull();
  });
});
