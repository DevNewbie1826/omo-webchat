import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nContext, translate, type I18nValue, type Lang } from "../../i18n";
import { ToolCard, type ToolCardProps } from "./ToolCard";

const subagentOutput = "Inspection complete";

function subagentProps(): ToolCardProps {
	return {
		toolCallId: "task-1",
		toolName: "task",
		phase: "end",
		text: subagentOutput,
		isError: false,
		details: { task_id: "st_1", status: "completed", task_summary: "Inspect frontend" },
	};
}

describe("ToolCard disclosures", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

	function renderCard(props: ToolCardProps, lang?: Lang): HTMLElement {
		const value: I18nValue | undefined = lang === undefined ? undefined : {
			lang,
			setLang: () => undefined,
			font: "system",
			setFont: () => undefined,
			fontSize: 13,
			setFontSize: () => undefined,
			t: (key, vars) => translate(lang, key, vars),
		};
		act(() => {
			root.render(
				value === undefined
					? <ToolCard {...props} />
					: <I18nContext.Provider value={value}><ToolCard {...props} /></I18nContext.Provider>,
			);
		});
		const card = container.querySelector<HTMLElement>(".th-tool");
		if (!card) throw new Error("tool card missing");
		return card;
	}

	function click(card: HTMLElement): void {
		const head = card.querySelector<HTMLButtonElement>(".th-tool-head");
		if (!head) throw new Error("tool head missing");
		act(() => {
			head.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}

	it("collapses the subagent body behind an accessible head by default", () => {
		const card = renderCard(subagentProps());

		expect(card.querySelector(".th-tool-body")).toBeNull();
		const head = card.querySelector(".th-tool-head");
		expect(head?.tagName).toBe("BUTTON");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
	});

	it("expands and collapses the subagent body through the head control", () => {
		const card = renderCard(subagentProps());
		const head = card.querySelector<HTMLButtonElement>(".th-tool-head");

		click(card);
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")?.textContent).toContain(subagentOutput);

		click(card);
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("keeps the subagent title, status, and preview visible while collapsed", () => {
		const card = renderCard(subagentProps());

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("Inspect frontend");
		expect(card.querySelector(".th-tool-status--ok")?.textContent).toBe("tool.done");
		expect(card.querySelector(".th-tool-preview")?.textContent).toBe(subagentOutput);
	});

	it("collapses a generic tool card with its latest output line as the preview", () => {
		const card = renderCard({
			toolCallId: "call-1",
			toolName: "bash",
			phase: "end",
			text: "first line\n\nlast status line",
			isError: false,
		});

		const head = card.querySelector<HTMLButtonElement>(".th-tool-head");
		expect(head?.getAttribute("aria-expanded")).toBe("false");
		// Single-line truncation is visual (CSS ellipsis); the preview exposes the
		// latest non-empty output line in full to the accessibility tree, so a
		// closed card still reads live progress.
		expect(card.querySelector(".th-tool-preview")?.textContent).toBe("last status line");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("keeps an untouched running card collapsed in every phase", () => {
		const card = renderCard({
			toolCallId: "call-live",
			toolName: "bash",
			phase: "update",
			text: "working…",
			isError: false,
		});

		expect(card.querySelector(".th-tool-head")?.getAttribute("aria-expanded")).toBe("false");
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("auto-opens an untouched failed card so errors are impossible to miss", () => {
		const card = renderCard({
			toolCallId: "call-failed",
			toolName: "bash",
			phase: "end",
			text: "boom",
			isError: true,
		});

		expect(card.querySelector(".th-tool-head")?.getAttribute("aria-expanded")).toBe("true");
		expect(card.querySelector(".th-tool-body")?.textContent).toContain("boom");
	});

	it("toggles a generic tool body open and closed", () => {
		const card = renderCard({
			toolCallId: "call-1",
			toolName: "bash",
			phase: "end",
			text: "file1\nfile2\n",
			isError: false,
		});

		click(card);
		expect(card.querySelector(".th-tool-body")?.textContent).toContain("file1\nfile2\n");

		click(card);
		expect(card.querySelector(".th-tool-body")).toBeNull();
	});

	it("labels a failed tool with the error status glyph and word", () => {
		const card = renderCard({
			toolCallId: "call-err",
			toolName: "bash",
			phase: "end",
			text: "boom",
			isError: true,
		});

		expect(card.classList.contains("th-tool--error")).toBe(true);
		expect(card.querySelector(".th-tool-status--error")?.textContent).toBe("tool.error");
		expect(card.querySelector(".th-tool-glyph--error")?.textContent).toBe("!");
	});

	it("titles a read of skills/<name>/SKILL.md with the skill directory", () => {
		const card = renderCard({
			toolCallId: "call-skill",
			toolName: "read",
			phase: "end",
			text: "skill manifest",
			isError: false,
			args: { path: "/home/user/project/skills/my-skill/SKILL.md" },
		}, "en");

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("Read skill: my-skill");
		// The disclosure anatomy is unchanged: collapsed until toggled, then the
		// invocation input and output still fold open behind the same head.
		expect(card.querySelector(".th-tool-body")).toBeNull();
		click(card);
		expect(card.querySelector(".th-tool-body")?.textContent).toContain("my-skill");
	});

	it("keeps the generic read header for a non-skill path", () => {
		const card = renderCard({
			toolCallId: "call-read",
			toolName: "read",
			phase: "end",
			text: "notes",
			isError: false,
			args: { path: "/home/user/notes.md" },
		}, "en");

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("read");
	});

	it("matches the SKILL.md basename case-sensitively", () => {
		const card = renderCard({
			toolCallId: "call-lower",
			toolName: "read",
			phase: "end",
			text: "notes",
			isError: false,
			args: { path: "/home/user/project/skill.md" },
		}, "en");

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("read");
	});

	it("falls back to SKILL.md as the name when there is no parent directory", () => {
		const card = renderCard({
			toolCallId: "call-bare",
			toolName: "read",
			phase: "end",
			text: "skill manifest",
			isError: false,
			args: { path: "SKILL.md" },
		}, "en");

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("Read skill: SKILL.md");
	});

	it("localizes the skill-read header in Korean", () => {
		const card = renderCard({
			toolCallId: "call-skill-ko",
			toolName: "read",
			phase: "end",
			text: "skill manifest",
			isError: false,
			args: { path: "/home/user/project/skills/another-skill/SKILL.md" },
		}, "ko");

		expect(card.querySelector(".th-tool-name")?.textContent).toBe("스킬 읽음: another-skill");
	});
});
