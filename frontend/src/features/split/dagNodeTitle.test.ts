import { describe, expect, it } from "vitest";
import { dagNodeTitle } from "./dagNodeTitle";

describe("dagNodeTitle", () => {
  it("uses a present label", () => {
    expect(dagNodeTitle({ id: "node-1", label: "Build UI" })).toBe("Build UI");
  });

  it("falls back to the id when label is undefined", () => {
    expect(dagNodeTitle({ id: "node-1" })).toBe("node-1");
  });

  it("falls back to the id when label is empty", () => {
    expect(dagNodeTitle({ id: "node-1", label: "" })).toBe("node-1");
  });

  it("falls back to the id when label contains only whitespace", () => {
    expect(dagNodeTitle({ id: "node-1", label: " \t\n " })).toBe("node-1");
  });

  it("trims surrounding spaces from a label", () => {
    expect(dagNodeTitle({ id: "node-1", label: "  Build UI  " })).toBe("Build UI");
  });

  it("uses a CJK label", () => {
    expect(dagNodeTitle({ id: "node-1", label: "画面を作る" })).toBe("画面を作る");
  });

  it("falls back to the id when no label is provided", () => {
    expect(dagNodeTitle({ id: "node-42" })).toBe("node-42");
  });
});
