import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./App", () => ({
  App: () => {
    throw new Error("app render failed");
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.localStorage.setItem("th-lang", "ko");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows a localized reload fallback instead of an empty page when the app fails to render", async () => {
  const { AppRoot } = await import("./AppRoot");
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  act(() => root.render(<AppRoot />));

  const fallback = container.querySelector(".th-app-error");
  expect(fallback?.textContent).toContain("문제가 발생했습니다");
  expect(fallback?.textContent).toContain("app render failed");
  act(() => container.querySelector<HTMLButtonElement>(".th-app-error-reload")?.click());
  expect(reload).toHaveBeenCalledTimes(1);
});
