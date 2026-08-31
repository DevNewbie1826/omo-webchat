import { act } from "react";
import type { Root } from "react-dom/client";
import { vi } from "vitest";
import { I18nContext, type I18nValue } from "../../i18n";
import type {
	ChatClientFrame,
	ChatConnector,
	ChatServerFrame,
	CommandEntry,
} from "../../lib/chatWs";
import type { ChatSessionRef } from "../workspace/workspace";
import { ChatComposer } from "./ChatComposer";
import { ChatPane } from "./ChatPane";

export const i18n: I18nValue = {
	lang: "en",
	setLang: () => undefined,
	font: "system",
	setFont: () => undefined,
	fontSize: 13,
	setFontSize: () => undefined,
	t: (key) => key,
};

export const chatSession = {
	id: "chat-1",
	name: "Chat 1",
	wsId: "workspace-1",
	cwd: "/work",
	provider: "omo",
} as const;

export const longChatSession = {
	id: "chat-1",
	name: "A title that must remain visible",
	wsId: "workspace-1",
	cwd: "/work/with/a/very/long/path",
	provider: "omo",
} as const;

function resizeRect(width = 1024, height = 768): ResizeObserverEntry {
	return {
		target: document.createElement("div"),
		contentRect: {
			width,
			height,
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: width,
			bottom: height,
			toJSON: () => ({}),
		},
	} as unknown as ResizeObserverEntry;
}

export class ControlledResizeObserver {
	static instances: ControlledResizeObserver[] = [];
	readonly targets = new Set<Element>();

	constructor(readonly callback: ResizeObserverCallback) {
		ControlledResizeObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.targets.add(target);
		this.callback(
			[
				{
					target,
					contentRect: resizeRect().contentRect,
				} as ResizeObserverEntry,
			],
			this as unknown as ResizeObserver,
		);
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	disconnect(): void {
		this.targets.clear();
	}

	static trigger(target: Element): void {
		for (const observer of ControlledResizeObserver.instances) {
			if (!observer.targets.has(target)) continue;
			observer.callback(
				[
					{
						target,
						contentRect: resizeRect().contentRect,
					} as ResizeObserverEntry,
				],
				observer as unknown as ResizeObserver,
			);
		}
	}
}

export function setTextareaValue(
	input: HTMLTextAreaElement,
	value: string,
): void {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("missing textarea value setter");
	input.focus();
	setter.call(input, value);
	input.dispatchEvent(
		new InputEvent("input", { bubbles: true, composed: true, data: value }),
	);
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function pressKey(
	target: HTMLElement,
	key: string,
	options: { readonly shiftKey?: boolean; readonly isComposing?: boolean } = {},
): KeyboardEvent {
	const eventInit: KeyboardEventInit = {
		key,
		bubbles: true,
		cancelable: true,
	};
	if (options.shiftKey !== undefined) eventInit.shiftKey = options.shiftKey;
	if (options.isComposing !== undefined)
		eventInit.isComposing = options.isComposing;
	const event = new KeyboardEvent("keydown", eventInit);
	target.dispatchEvent(event);
	return event;
}

export function requireElement<T>(
	value: T | null | undefined,
	message: string,
): T {
	if (value == null) throw new Error(message);
	return value;
}

export function renderChatPane(
	root: Root,
	session: ChatSessionRef = chatSession,
): { deliver: (frame: ChatServerFrame) => void; sent: ChatClientFrame[] } {
	let deliver: ((frame: ChatServerFrame) => void) | undefined;
	const sent: ChatClientFrame[] = [];
	const connect: ChatConnector = (handlers) => {
		deliver = handlers.onFrame;
		handlers.onOpen?.();
		return {
			send: vi.fn((frame: ChatClientFrame) => {
				sent.push(frame);
				return true;
			}),
			close: vi.fn(),
		};
	};
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<ChatPane
					chatSession={session}
					focused
					splitEnabled={false}
					onFocus={() => undefined}
					onSplit={() => undefined}
					onClose={() => undefined}
					onOpenSidebar={() => undefined}
					connect={connect}
					notify={() => undefined}
				/>
			</I18nContext.Provider>,
		);
	});
	return { deliver: (frame) => deliver?.(frame), sent };
}

export function renderTwoChatComposers(
	root: Root,
	commands: readonly CommandEntry[],
): void {
	act(() => {
		root.render(
			<I18nContext.Provider value={i18n}>
				<div className="th-split">
					{["first", "second"].map((pane) => (
						<section key={pane} data-pane={pane}>
							<ChatComposer
								commands={commands}
								running={false}
								isCompacting={false}
								retryDraft={null}
								onSubmit={() => true}
								onSteer={() => undefined}
								onStop={() => undefined}
								provider="omo"
								cwd="/tmp"
							/>
						</section>
					))}
				</div>
			</I18nContext.Provider>,
		);
	});
}
