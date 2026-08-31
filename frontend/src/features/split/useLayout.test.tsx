import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "./useLayout";
import { useLayout } from "./useLayout";

const layoutMocks = vi.hoisted(() => ({
	getLayout: vi.fn<() => Promise<unknown>>(),
	putLayout: vi.fn<(layout: unknown) => Promise<void>>(),
}));

vi.mock("./layout", () => layoutMocks);

function LayoutProbe({
	authed = false,
	onReady,
}: {
	readonly authed?: boolean;
	readonly onReady: (layout: LayoutApi) => void;
}) {
	const layout = useLayout(authed);
	useEffect(() => onReady(layout), [layout, onReady]);
	return null;
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
