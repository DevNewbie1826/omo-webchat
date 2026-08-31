import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { I18nValue } from "../../i18n";
import { I18nContext } from "../../i18n";
import { connectChat } from "../../lib/chatWs";
import type { ChatSessionRef, Workspace, WorkspaceSession } from "../workspace/workspace";
import type { WorkspaceSessionPaging } from "../workspace/useWorkspaces";
import type { PaneNode } from "./paneTree";
import { leaf } from "./paneTree";
import type { SplitActions } from "./SplitView";
import { SplitView } from "./SplitView";

vi.mock("../../lib/chatWs", () => ({ connectChat: vi.fn() }));

const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
} as I18nValue;

function makeActions(overrides: Partial<SplitActions> = {}): SplitActions {
	return {
		onFocusPane: () => undefined,
		onAssign: () => undefined,
		onCreateTerminal: () => undefined,
		onSplit: () => undefined,
		onClosePane: () => undefined,
		onRatioChange: () => undefined,
		onOpenSidebar: () => undefined,
		notify: () => undefined,
		...overrides,
	};
}

function sessionRefs(workspaces: readonly Workspace[]): ReadonlyMap<string, ChatSessionRef> {
	return new Map(workspaces.flatMap((workspace) => workspace.chats.map((chat) => [
		chat.id,
		{ ...chat, wsId: workspace.id, cwd: workspace.path },
	] as const)));
}

function useResizeObserverSize(width: number, height: number): void {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private readonly callback: ResizeObserverCallback) {}
			observe(target: Element): void {
				const rect = {
					width,
					height,
					x: 0,
					y: 0,
					top: 0,
					left: 0,
					right: width,
					bottom: height,
					toJSON: () => ({}),
				};
				this.callback(
					[{ target, contentRect: rect } as ResizeObserverEntry],
					this as unknown as ResizeObserver,
				);
			}
			disconnect(): void {}
			unobserve(): void {}
		},
	);
}

describe("SplitView empty pane", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.mocked(connectChat).mockImplementation((handlers) => {
			handlers.onOpen?.();
			return { send: vi.fn(), close: vi.fn() };
		});
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	function render(
		node: PaneNode,
		actions: SplitActions,
		splitEnabled = true,
		sessions: ReadonlyMap<string, ChatSessionRef> = new Map(),
		workspaces: readonly Workspace[] = [],
		placed: ReadonlySet<string> = new Set(),
		sessionLists: ReadonlyMap<string, readonly WorkspaceSession[]> = new Map(),
		sessionPages: ReadonlyMap<string, WorkspaceSessionPaging> = new Map(),
		onEnsureSessions: (wsId: string) => void = () => undefined,
	): void {
		act(() => {
			root.render(
				<I18nContext.Provider value={i18n}>
					<SplitView
						node={node}
						workspaces={workspaces}
						placed={placed}
						sessions={sessions}
						sessionLists={sessionLists}
						sessionPages={sessionPages}
						onEnsureSessions={onEnsureSessions}
						focusedPaneId={node.id}
						splitEnabled={splitEnabled}
						actions={actions}
					/>
				</I18nContext.Provider>,
			);
		});
	}

	it("uses the generic empty state when there are zero workspaces", () => {
		render(leaf(null), makeActions(), true, new Map(), []);

		expect(container.querySelector(".th-picker-pane-empty")?.textContent).toBe("split.pickEmpty");
		expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
		expect(container.querySelector<HTMLButtonElement>(".th-picker-pane-create button")?.disabled).toBe(true);
	});

	it("renders a close button for a pane with no session", () => {
		render(leaf(null), makeActions());
		const close = container.querySelector<HTMLButtonElement>(
			'button[aria-label="split.close"]',
		);
		expect(close).not.toBeNull();
	});

	it("calls onClosePane with the pane id when the empty-pane close is clicked", () => {
		const onClosePane = vi.fn();
		const node = leaf(null);
		render(node, makeActions({ onClosePane }));
		const close = container.querySelector<HTMLButtonElement>(
			'button[aria-label="split.close"]',
		);
		act(() => {
			close?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onClosePane).toHaveBeenCalledWith(node.id);
	});

	it("hides the empty-pane close button when splitting is disabled", () => {
		render(leaf(null), makeActions(), false);
		expect(
			container.querySelector('button[aria-label="split.close"]'),
		).toBeNull();
	});

	it("truncates long session names to one line while keeping the full text available", () => {
		const longName = "refactor-auth-provider-and-migrate-all-tests-terminal-session";
		const pickerWorkspaces: readonly Workspace[] = [
			{
				id: "ws-1",
				name: "cli-webchat",
				path: "/repo/cli-webchat",
				chats: [{ id: "chat-9", name: longName, provider: "omo" }],
			},
		];
		const pickerLists = new Map<string, readonly WorkspaceSession[]>([
			["ws-1", [{ id: "chat-9", name: longName, source: "stored", recencyMs: 1 }]],
		]);
		const pickerPages = new Map<string, WorkspaceSessionPaging>([
			["ws-1", { ready: true, loading: false, hasMore: false, nextCursor: "" }],
		]);
		render(
			leaf(null),
			makeActions(),
			true,
			sessionRefs(pickerWorkspaces),
			pickerWorkspaces,
			new Set(),
			pickerLists,
			pickerPages,
		);

		const item = container.querySelector<HTMLButtonElement>(
			"button.th-picker-pane-item",
		);
		expect(item).not.toBeNull();
		// Full text stays available: content is the accessible name, title is the tooltip.
		expect(item?.textContent).toContain(longName);
		expect(item?.getAttribute("title")).toBe(`cli-webchat / ${longName}`);
		expect(item?.getAttribute("aria-label")).toBe(`cli-webchat / ${longName}`);

		// The row shows the name only; no workspace label or separator spans.
		expect(item?.querySelector("span.th-picker-pane-ws")).toBeNull();
		expect(item?.querySelector("span.th-picker-pane-sep")).toBeNull();
		const nameLabel = item?.querySelector<HTMLElement>("span.th-picker-pane-name");
		expect(nameLabel?.textContent).toBe(longName);

		// The name span owns the ellipsis so every card keeps one stable line.
		const css = readFileSync("src/styles/split-view.css", "utf8");
		expect(css).toMatch(/\.th-picker-pane-name\s*\{[^}]*min-width:\s*0/);
		expect(css).toMatch(/\.th-picker-pane-name\s*\{[^}]*white-space:\s*nowrap/);
		expect(css).toMatch(/\.th-picker-pane-name\s*\{[^}]*overflow:\s*hidden/);
		expect(css).toMatch(/\.th-picker-pane-name\s*\{[^}]*text-overflow:\s*ellipsis/);
	});

	describe("workspace-filtered picker", () => {
		const workspaces: readonly Workspace[] = [
			{
				id: "ws-alpha",
				name: "alpha",
				path: "/repo/alpha",
				chats: [
					{ id: "chat-a1", name: "fix login flow", provider: "omo" },
					{ id: "chat-a2", name: "add picker tests", provider: "omo" },
				],
			},
			{
				id: "ws-beta",
				name: "beta",
				path: "/repo/beta",
				chats: [{ id: "chat-b1", name: "tune dag layout", provider: "omo" }],
			},
		];
		const sessions = sessionRefs(workspaces);

		const pickerLists = new Map<string, readonly WorkspaceSession[]>([
			[
				"ws-alpha",
				[
					{ id: "chat-a1", name: "fix login flow", source: "stored", recencyMs: 30 },
					{ id: "chat-a2", name: "add picker tests", source: "stored", recencyMs: 20 },
				],
			],
			[
				"ws-beta",
				[{ id: "chat-b1", name: "tune dag layout", source: "stored", recencyMs: 10 }],
			],
		]);

		const pickerPages = new Map<string, WorkspaceSessionPaging>([
			["ws-alpha", { ready: true, loading: false, hasMore: false, nextCursor: "" }],
			["ws-beta", { ready: true, loading: false, hasMore: false, nextCursor: "" }],
		]);

		function pickerSelect(): HTMLSelectElement {
			const select = container.querySelector<HTMLSelectElement>(
				'select[aria-label="split.pickWorkspace"]',
			);
			expect(select).not.toBeNull();
			return select as HTMLSelectElement;
		}

		function chooseWorkspace(value: string): void {
			const select = pickerSelect();
			act(() => {
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
		}

		function rowNames(): string[] {
			return Array.from(
				container.querySelectorAll("button.th-picker-pane-item"),
			).map((row) => row.textContent);
		}

		it("renders unplaced stored sessions in sessionLists (MRU) order, not ws.chats order", () => {
			const mruChats = [
				{ id: "s-1", name: "Session 1", provider: "omo" as const },
				{ id: "s-2", name: "Session 2", provider: "omo" as const },
				{ id: "s-3", name: "Session 3", provider: "omo" as const },
			];
			const mruWorkspaces: readonly Workspace[] = [
				{ id: "ws-mru", name: "mru", path: "/repo/mru", chats: mruChats },
			];
			// Server MRU order deliberately differs from the ws.chats append order,
			// and a discovered row must never surface in the picker.
			const mruLists = new Map<string, readonly WorkspaceSession[]>([
				[
					"ws-mru",
					[
						{ id: "d-1", name: "Discovered", source: "discovered", recencyMs: 40 },
						{ id: "s-3", name: "Session 3", source: "stored", recencyMs: 30 },
						{ id: "s-1", name: "Session 1", source: "stored", recencyMs: 20 },
						{ id: "s-2", name: "Session 2", source: "stored", recencyMs: 10 },
					],
				],
			]);
			const mruPages = new Map<string, WorkspaceSessionPaging>([
				["ws-mru", { ready: true, loading: false, hasMore: false, nextCursor: "" }],
			]);

			render(
				leaf(null),
				makeActions(),
				true,
				sessionRefs(mruWorkspaces),
				mruWorkspaces,
				new Set(["s-1"]),
				mruLists,
				mruPages,
			);
			expect(rowNames()).toEqual(["Session 3", "Session 2"]);
		});

		it("requests the first session page once and shows a loading note while it is in flight", () => {
			const onEnsureSessions = vi.fn();

			// No paging state yet: the picker must ask for the first page exactly once.
			render(
				leaf(null),
				makeActions(),
				true,
				sessions,
				workspaces,
				new Set(),
				pickerLists,
				new Map(),
				onEnsureSessions,
			);
			expect(onEnsureSessions).toHaveBeenCalledTimes(1);
			expect(onEnsureSessions).toHaveBeenCalledWith("ws-alpha");

			// First page in flight: loading note replaces the list.
			render(
				leaf(null),
				makeActions(),
				true,
				sessions,
				workspaces,
				new Set(),
				pickerLists,
				new Map([["ws-alpha", { ready: false, loading: true, hasMore: false, nextCursor: "" }]]),
				onEnsureSessions,
			);
			expect(container.querySelector(".th-picker-pane-empty")?.textContent).toBe("split.pickLoading");
			expect(rowNames()).toEqual([]);

			// Page ready: rows render from sessionLists and the trigger stays silent.
			render(
				leaf(null),
				makeActions(),
				true,
				sessions,
				workspaces,
				new Set(),
				pickerLists,
				new Map([["ws-alpha", { ready: true, loading: false, hasMore: false, nextCursor: "" }]]),
				onEnsureSessions,
			);
			expect(rowNames()).toEqual(["fix login flow", "add picker tests"]);
			expect(onEnsureSessions).toHaveBeenCalledTimes(1);
		});

		it("sits directly under the title and lists only the selected workspace's chats", () => {
			render(leaf(null), makeActions(), true, sessions, workspaces, new Set(), pickerLists, pickerPages);

			const title = container.querySelector(".th-picker-pane-title");
			const select = pickerSelect();
			expect(title?.nextElementSibling).toBe(select);
			expect(select.value).toBe("ws-alpha");

			// Rows show the session name only - beta's chats never leak in.
			expect(rowNames()).toEqual(["fix login flow", "add picker tests"]);
		});

		it("hides chats already placed in other panes", () => {
			render(leaf(null), makeActions(), true, sessions, workspaces, new Set(["chat-a1"]), pickerLists, pickerPages);
			expect(rowNames()).toEqual(["add picker tests"]);
		});

		it("hides stored session rows that are absent from the resolvable sessions map", () => {
			render(leaf(null), makeActions(), true, new Map(), workspaces, new Set(), pickerLists, pickerPages);
			expect(rowNames()).toEqual([]);
		});

		it("falls back to the first workspace when the selected one disappears", () => {
			const onCreateTerminal = vi.fn();
			const node = leaf(null);
			render(node, makeActions({ onCreateTerminal }), true, sessions, workspaces, new Set(), pickerLists, pickerPages);
			chooseWorkspace("ws-beta");
			render(node, makeActions({ onCreateTerminal }), true, sessionRefs([workspaces[0]!]), [workspaces[0]!], new Set(), pickerLists, pickerPages);
			expect(pickerSelect().value).toBe("ws-alpha");
			expect(rowNames()).toEqual(["fix login flow", "add picker tests"]);
			const createButton = container.querySelector<HTMLButtonElement>(".th-picker-pane-create button");
			act(() => createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(onCreateTerminal).toHaveBeenCalledWith(node.id, "ws-alpha");
		});

		it("re-filters the list when the dropdown changes", () => {
			render(leaf(null), makeActions(), true, sessions, workspaces, new Set(), pickerLists, pickerPages);

			chooseWorkspace("ws-beta");
			expect(rowNames()).toEqual(["tune dag layout"]);
			chooseWorkspace("ws-alpha");
			expect(rowNames()).toEqual(["fix login flow", "add picker tests"]);
		});

		it("keeps the combined label in title and aria-label of each row", () => {
			render(leaf(null), makeActions(), true, sessions, workspaces, new Set(), pickerLists, pickerPages);

			const row = container.querySelector<HTMLButtonElement>(
				'button.th-picker-pane-item[aria-label="alpha / fix login flow"]',
			);
			expect(row).not.toBeNull();
			expect(row?.getAttribute("title")).toBe("alpha / fix login flow");
		});

		it("creates a terminal in the selected workspace", () => {
			const onCreateTerminal = vi.fn();
			const node = leaf(null);
			render(node, makeActions({ onCreateTerminal }), true, new Map(), workspaces, new Set(), pickerLists, pickerPages);

			const createButton = container.querySelector<HTMLButtonElement>(
				'.th-picker-pane-create button[aria-label="split.pickNew"], .th-picker-pane-create button',
			);
			act(() => {
				createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(onCreateTerminal).toHaveBeenCalledWith(node.id, "ws-alpha");

			chooseWorkspace("ws-beta");
			act(() => {
				createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(onCreateTerminal).toHaveBeenLastCalledWith(node.id, "ws-beta");
		});

		it("shows the per-workspace empty state when the selection has no unplaced chats", () => {
			const empty: readonly Workspace[] = [
				{
					id: "ws-alpha",
					name: "alpha",
					path: "/repo/alpha",
					chats: [{ id: "chat-a1", name: "fix login flow", provider: "omo" }],
				},
				{ id: "ws-beta", name: "beta", path: "/repo/beta", chats: [] },
			];
			const emptyLists = new Map<string, readonly WorkspaceSession[]>([
				["ws-alpha", [{ id: "chat-a1", name: "fix login flow", source: "stored", recencyMs: 1 }]],
			]);
			const emptyPages = new Map<string, WorkspaceSessionPaging>([
				["ws-alpha", { ready: true, loading: false, hasMore: false, nextCursor: "" }],
			]);
			render(leaf(null), makeActions(), true, new Map(), empty, new Set(), emptyLists, emptyPages);

			chooseWorkspace("ws-beta");
			expect(rowNames()).toEqual([]);
			expect(
				container.querySelector(".th-picker-pane-empty")?.textContent,
			).toBe("split.pickEmptyFiltered");
		});

		it("disables the new-session button when no workspace is selected", () => {
			render(leaf(null), makeActions(), true, new Map(), []);

			const createButton = container.querySelector<HTMLButtonElement>(
				".th-picker-pane-create button",
			);
			expect(createButton?.disabled).toBe(true);
		});
	});

	it("keeps keyboard-resized horizontal panes at least 320px wide", () => {
		useResizeObserverSize(1000, 700);
		const first = leaf(null);
		const second = leaf(null);
		const node: PaneNode = {
			kind: "split",
			id: "split-1",
			dir: "h",
			ratio: 0.5,
			first,
			second,
		};
		const onRatioChange = vi.fn();
		render(node, makeActions({ onRatioChange }));

		const separator = container.querySelector<HTMLHRElement>("hr.th-divider");
		expect(separator?.tabIndex).toBe(0);
		expect(separator?.getAttribute("aria-orientation")).toBe("vertical");
		expect(separator?.getAttribute("aria-valuemin")).toBe("32");
		expect(separator?.getAttribute("aria-valuemax")).toBe("68");
		expect(separator?.getAttribute("aria-valuenow")).toBe("50");

		for (const key of ["Home", "End"] as const) {
			act(() =>
				separator?.dispatchEvent(
					new KeyboardEvent("keydown", {
						key,
						bubbles: true,
						cancelable: true,
					}),
				),
			);
			const ratio = onRatioChange.mock.lastCall?.[1];
			expect(ratio).toBeTypeOf("number");
			expect((ratio as number) * 996).toBeGreaterThanOrEqual(320);
			expect((1 - (ratio as number)) * 996).toBeGreaterThanOrEqual(320);
		}

		act(() =>
			separator?.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowRight",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(onRatioChange).toHaveBeenLastCalledWith("split-1", 0.55);
	});

	it("uses an even safe ratio when the container cannot fit two 320px panes", () => {
		useResizeObserverSize(600, 700);
		const node: PaneNode = {
			kind: "split",
			id: "split-small",
			dir: "h",
			ratio: 0.5,
			first: leaf(null),
			second: leaf(null),
		};
		const onRatioChange = vi.fn();
		render(node, makeActions({ onRatioChange }));

		const separator = container.querySelector<HTMLHRElement>("hr.th-divider");
		act(() =>
			separator?.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "End",
					bubbles: true,
					cancelable: true,
				}),
			),
		);
		expect(onRatioChange).toHaveBeenLastCalledWith("split-small", 0.5);
		expect(separator?.getAttribute("aria-valuemin")).toBe("50");
		expect(separator?.getAttribute("aria-valuemax")).toBe("50");
	});

	it("retains the omo provider across session switches without sending a model", () => {
		const node = leaf("chat-one");
		const sessions = new Map([
			[
				"chat-one",
				{
					id: "chat-one",
					wsId: "ws-1",
					name: "One",
					cwd: "/tmp",
					provider: "omo" as const,
				},
			],
			[
				"chat-two",
				{
					id: "chat-two",
					wsId: "ws-1",
					name: "Two",
					cwd: "/tmp",
					provider: "omo" as const,
				},
			],
		]);
		render(node, makeActions(), true, sessions);

		expect(container.querySelector(".th-provider-badge")?.textContent).toBe(
			"omo",
		);
		const firstClient = vi.mocked(connectChat).mock.results[0]?.value;
		expect(firstClient.send).toHaveBeenCalledWith({
			type: "chat.create",
			wsId: "ws-1",
			chatId: "chat-one",
		});
		expect(JSON.stringify(firstClient.send.mock.calls)).not.toContain("model");

		render(leaf("chat-two"), makeActions(), true, sessions);
		expect(container.querySelector(".th-provider-badge")?.textContent).toBe(
			"omo",
		);
		const secondClient = vi.mocked(connectChat).mock.results[1]?.value;
		expect(secondClient.send).toHaveBeenCalledWith({
			type: "chat.create",
			wsId: "ws-1",
			chatId: "chat-two",
		});
		expect(JSON.stringify(secondClient.send.mock.calls)).not.toContain("model");
	});
});
