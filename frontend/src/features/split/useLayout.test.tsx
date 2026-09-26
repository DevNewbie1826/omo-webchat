import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "./paneTree";
import type { LayoutApi } from "./useLayout";
import { useLayout } from "./useLayout";

const layoutMocks = vi.hoisted(() => ({
	getLayout: vi.fn<() => Promise<unknown>>(),
	putLayout: vi.fn<(layout: unknown) => Promise<void>>(),
}));

vi.mock("./layout", () => layoutMocks);

function transcriptNodes(node: PaneNode): React.ReactNode {
	if (node.kind === "split") {
		return <div key={node.id}>{transcriptNodes(node.first)}{transcriptNodes(node.second)}</div>;
	}
	return <div key={node.id} className="th-pane-wrap" data-pane-id={node.id}>
		<div className="th-chat-scrollport">{node.sessionId ?? "empty"}</div>
	</div>;
}

function LayoutProbe({
	authed = false,
	onReady,
}: {
	readonly authed?: boolean;
	readonly onReady: (layout: LayoutApi) => void;
}) {
	const layout = useLayout(authed);
	useEffect(() => onReady(layout), [layout, onReady]);
	return <>{transcriptNodes(layout.root)}</>;
}

function pendingTransitions(): Array<() => unknown> {
	const callbacks: Array<() => unknown> = [];
	const never = new Promise<void>(() => undefined);
	document.startViewTransition = ((callback: ViewTransitionUpdateCallback | StartViewTransitionOptions) => {
		const update = typeof callback === "function" ? callback : callback.update;
		if (update) callbacks.push(update);
		return {
			ready: never,
			finished: never,
			updateCallbackDone: never,
			skipTransition: () => undefined,
			types: new Set<string>() as unknown as ViewTransitionTypeSet,
		};
	}) as typeof document.startViewTransition;
	return callbacks;
}

function leafSessions(node: PaneNode): string[] {
	if (node.kind === "split") return [...leafSessions(node.first), ...leafSessions(node.second)];
	return node.sessionId === null ? [] : [node.sessionId];
}

describe("useLayout assignment", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		layoutMocks.getLayout.mockReset();
		layoutMocks.getLayout.mockResolvedValue(null);
		layoutMocks.putLayout.mockReset();
		layoutMocks.putLayout.mockResolvedValue(undefined);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(document, "startViewTransition");
	});

	function mountedLayout(): { layout: LayoutApi | null } {
		const state: { layout: LayoutApi | null } = { layout: null };
		act(() => root.render(<LayoutProbe onReady={next => { state.layout = next; }} />));
		return state;
	}

	function current(state: { layout: LayoutApi | null }): LayoutApi {
		if (!state.layout) throw new Error("layout did not update");
		return state.layout;
	}

	function assertPlacement(state: { layout: LayoutApi | null }, expected: readonly string[]): void {
		const layout = current(state);
		const sessions = leafSessions(layout.root);
		expect(sessions).toEqual(expected);
		expect(sessions.length).toBe(new Set(sessions).size);
		expect(layout.placed).toEqual(new Set(expected));
	}

	it("keeps a closed target closed when its session transition releases", () => {
		const state = mountedLayout();
		const first = current(state).focusedPaneId;
		act(() => current(state).split(first, "h"));
		const split = current(state).root;
		if (split.kind !== "split") throw new Error("split missing");
		const second = split.second.id;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(second, "later"));
		act(() => current(state).closePane(second));
		expect(current(state).hasPane(second)).toBe(false);
		act(() => { for (const callback of callbacks) callback(); });

		expect(current(state).hasPane(second)).toBe(false);
		expect(current(state).focusedPaneId).toBe(first);
		expect(container.textContent).toBe("empty");
		assertPlacement(state, []);
	});

	it("keeps intervening split and ratio changes when a session transition releases", () => {
		const state = mountedLayout();
		const first = current(state).focusedPaneId;
		act(() => current(state).split(first, "h"));
		const initial = current(state).root;
		if (initial.kind !== "split") throw new Error("split missing");
		const second = initial.second.id;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(first, "new-session"));
		act(() => current(state).split(second, "v"));
		act(() => current(state).changeRatio(initial.id, 0.7));
		act(() => current(state).focusPane(second));
		act(() => { for (const callback of callbacks) callback(); });

		const final = current(state).root;
		if (final.kind !== "split") throw new Error("split missing");
		expect(final.ratio).toBe(0.7);
		expect(final.second.kind).toBe("split");
		expect(current(state).hasPane(second)).toBe(true);
		expect(current(state).focusedPaneId).toBe(second);
		expect(container.querySelector(`[data-pane-id="${first}"]`)?.textContent).toBe("new-session");
		assertPlacement(state, ["new-session"]);
	});

	it("commits independent assignments to two panes from held callbacks", () => {
		const state = mountedLayout();
		const first = current(state).focusedPaneId;
		act(() => current(state).split(first, "h"));
		const split = current(state).root;
		if (split.kind !== "split") throw new Error("split missing");
		const second = split.second.id;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(first, "session-a"));
		act(() => current(state).assignSession(second, "session-b"));
		act(() => { for (const callback of callbacks) callback(); });

		expect(container.querySelector(`[data-pane-id="${first}"]`)?.textContent).toBe("session-a");
		expect(container.querySelector(`[data-pane-id="${second}"]`)?.textContent).toBe("session-b");
		expect(current(state).focusedPaneId).toBe(second);
		assertPlacement(state, ["session-a", "session-b"]);
	});

	it("commits only the last of three pending choices in one pane", () => {
		const state = mountedLayout();
		const pane = current(state).focusedPaneId;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(pane, "one"));
		act(() => current(state).assignSession(pane, "two"));
		act(() => current(state).assignSession(pane, "three"));
		act(() => { for (const callback of callbacks) callback(); });

		expect(container.querySelector(".th-chat-scrollport")?.textContent).toBe("three");
		expect(current(state).focusedPaneId).toBe(pane);
		assertPlacement(state, ["three"]);
	});

	it("does not restore a session explicitly unplaced while its assignment waits", () => {
		const state = mountedLayout();
		const first = current(state).focusedPaneId;
		act(() => current(state).assignSession(first, "keep"));
		act(() => current(state).split(first, "h"));
		const split = current(state).root;
		if (split.kind !== "split") throw new Error("split missing");
		const second = split.second.id;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(second, "removed"));
		act(() => current(state).unplaceSession("removed"));
		act(() => { for (const callback of callbacks) callback(); });

		expect(container.querySelector(`[data-pane-id="${first}"]`)?.textContent).toBe("keep");
		expect(container.querySelector(`[data-pane-id="${second}"]`)?.textContent).toBe("empty");
		expect(current(state).focusedPaneId).toBe(second);
		assertPlacement(state, ["keep"]);
	});

	it("does not move a session back to an older pending destination", () => {
		const state = mountedLayout();
		const first = current(state).focusedPaneId;
		act(() => current(state).split(first, "h"));
		const split = current(state).root;
		if (split.kind !== "split") throw new Error("split missing");
		const second = split.second.id;
		const callbacks = pendingTransitions();

		act(() => current(state).assignSession(first, "shared"));
		act(() => current(state).assignSession(second, "shared"));
		act(() => { for (const callback of [...callbacks].reverse()) callback(); });

		expect(container.querySelector(`[data-pane-id="${first}"]`)?.textContent).toBe("empty");
		expect(container.querySelector(`[data-pane-id="${second}"]`)?.textContent).toBe("shared");
		expect(current(state).focusedPaneId).toBe(second);
		assertPlacement(state, ["shared"]);
	});

	it("cancels its pending persistence when unmounted", () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<LayoutProbe onReady={layout => {
        if (layout.placed.size === 0) layout.assignSession(layout.focusedPaneId, "session");
      }} />));
      expect(vi.getTimerCount()).toBe(1);
      act(() => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not let a late restore overwrite a local mutation", async () => {
		let resolveRestore: (layout: unknown) => void = () => undefined;
		layoutMocks.getLayout.mockReturnValue(new Promise((resolve) => {
			resolveRestore = resolve;
		}));
		const state: { layout: LayoutApi | null } = { layout: null };
		const onReady = (next: LayoutApi): void => {
			state.layout = next;
		};

		act(() => {
			root.render(<LayoutProbe authed onReady={onReady} />);
		});
		expect(layoutMocks.getLayout).toHaveBeenCalledOnce();
		const initialLayout = state.layout;
		if (!initialLayout) throw new Error("layout did not initialize");
		act(() => {
			initialLayout.assignSession(initialLayout.focusedPaneId, "local-session");
		});

		await act(async () => {
			resolveRestore({ kind: "leaf", id: "restored-pane", sessionId: "server-session" });
			await Promise.resolve();
		});

		const currentLayout = state.layout;
		if (!currentLayout) throw new Error("layout did not update");
		expect(currentLayout.placed.has("local-session")).toBe(true);
		expect(currentLayout.placed.has("server-session")).toBe(false);
		expect(currentLayout.root.kind).toBe("leaf");
		if (currentLayout.root.kind === "leaf") {
			expect(currentLayout.root.sessionId).toBe("local-session");
		}
	});

	it("leaves a session unplaced when its pane closed before assignment", () => {
		const state: { layout: LayoutApi | null } = { layout: null };
		const onReady = (next: LayoutApi): void => {
			state.layout = next;
		};

		act(() => {
			root.render(<LayoutProbe onReady={onReady} />);
		});
		const initialLayout = state.layout;
		if (!initialLayout) throw new Error("layout did not initialize");
		const closedPaneId = initialLayout.focusedPaneId;

		act(() => {
			initialLayout.closePane(closedPaneId);
		});
		const updatedLayout = state.layout;
		if (!updatedLayout) throw new Error("layout did not update");
		const focusedPaneId = updatedLayout.focusedPaneId;
		expect(updatedLayout.hasPane(closedPaneId)).toBe(false);

		act(() => {
			updatedLayout.assignSession(closedPaneId, "terminal-1");
		});
		expect(updatedLayout.placed.has("terminal-1")).toBe(false);
		expect(updatedLayout.focusedPaneId).toBe(focusedPaneId);
	});
});
