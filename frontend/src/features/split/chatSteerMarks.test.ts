import { beforeEach, describe, expect, it } from "vitest";
import { forgetSteerMark, recordSteerMark, steerMarkCounts } from "./chatSteerMarks";

describe("chatSteerMarks client-side store", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("records steer texts per chat and reads them back", () => {
    recordSteerMark("chat-1", "hold on");
    recordSteerMark("chat-1", "also lint");
    recordSteerMark("chat-2", "hold on");
    expect(steerMarkCounts("chat-1")).toEqual({ "hold on": 1, "also lint": 1 });
    expect(steerMarkCounts("chat-2")).toEqual({ "hold on": 1 });
    expect(steerMarkCounts("chat-3")).toEqual({});
  });

  it("keeps duplicate texts as separate occurrences", () => {
    recordSteerMark("chat-1", "again");
    recordSteerMark("chat-1", "again");
    expect(steerMarkCounts("chat-1")).toEqual({ again: 2 });
  });

  it("survives a simulated reload through sessionStorage", () => {
    recordSteerMark("chat-1", "hold on");
    const raw = window.sessionStorage.getItem("th-chat-steer:chat-1");
    expect(raw).not.toBeNull();
    // A reload re-reads the persisted payload with no in-memory state.
    expect(steerMarkCounts("chat-1")).toEqual({ "hold on": 1 });
  });

  it("forgets one occurrence when a steer is rejected", () => {
    recordSteerMark("chat-1", "racy");
    recordSteerMark("chat-1", "racy");
    forgetSteerMark("chat-1", "racy");
    expect(steerMarkCounts("chat-1")).toEqual({ racy: 1 });
    forgetSteerMark("chat-1", "racy");
    expect(steerMarkCounts("chat-1")).toEqual({});
    expect(window.sessionStorage.getItem("th-chat-steer:chat-1")).toBe("[]");
  });

  it("ignores corrupt persisted payloads", () => {
    window.sessionStorage.setItem("th-chat-steer:chat-1", "{not json");
    expect(steerMarkCounts("chat-1")).toEqual({});
    recordSteerMark("chat-1", "fresh");
    expect(steerMarkCounts("chat-1")).toEqual({ fresh: 1 });
  });
});
