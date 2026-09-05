import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatSession, renderChatPane, requireElement, setTextareaValue } from "./chatPaneTestHarness";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 300);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it("keeps dynamic queue and recovery controls in the bounded content scroll shell, separate from the multiline composer", () => {
  const { deliver } = renderChatPane(root);
  const input = requireElement(container.querySelector<HTMLTextAreaElement>("textarea"), "input");
  act(() => setTextareaValue(input, "first\nsecond\nthird\nfourth\nfifth\nsixth"));
  act(() => deliver({ type: "queue", sessionId: chatSession.id, revision: 1,
    items: [{ id: "q1", text: "queued fixture", hasImage: false, createdAt: 1 }],
    engine: { pendingMessageCount: 0, ordered: [] } }));
  act(() => requireElement(container.querySelector<HTMLButtonElement>(".th-queue-header"), "queue header").click());
  act(() => deliver({ type: "error", sessionId: chatSession.id, code: "send_failed", message: "Fixture recovery" }));
  const content = requireElement(container.querySelector<HTMLElement>(".th-chat-main-content"), "bounded content shell");
  for (const selector of [".th-queue", ".th-queue-clear", ".th-send-error-banner", ".th-chat-status", ".th-chat-scrollport"]) {
    expect(content.contains(requireElement(container.querySelector(selector), selector))).toBe(true);
  }
  expect(content.contains(input)).toBe(false);
  expect(content.nextElementSibling).toBe(input.closest(".th-chat-input"));
  expect(input.value.split("\n")).toHaveLength(6);
});

it("provides a shrinkable scroll shell and a column-local editor ceiling for a 320x300 pane", () => {
  const pane = readFileSync("src/styles/chat-pane.css", "utf8");
  const composer = readFileSync("src/styles/chat-composer.css", "utf8");
  const body = (css: string, selector: string): string => css.match(new RegExp(selector.replaceAll(".", "\\.") + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
  expect(body(pane, ".th-chat-main-content")).toMatch(/min-height:\s*0/);
  expect(body(pane, ".th-chat-main-content")).toMatch(/overflow-y:\s*auto/);
  expect(body(pane, ".th-chat-main")).toMatch(/container:\s*chat-column\s*\/\s*size/);
  // The editor must respond to its actual column, not a viewport-height proxy.
  expect(body(composer, ".th-chat-input textarea")).toMatch(/max-height:\s*min\(160px,\s*max\(44px,\s*calc\(100cqh - 200px\)\)\)/);
});
