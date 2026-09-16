import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nContext } from "../../i18n";
import type { I18nValue } from "../../i18n";
import { ApprovalDock } from "./ApprovalDock";

const i18n: I18nValue = {
	lang: "en", setLang: () => undefined, font: "system", setFont: () => undefined,
	fontSize: 13, setFontSize: () => undefined, t: (key) => key,
};

describe("question id robustness", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
		"submits exact answer keys when the question id is %s",
		(id) => {
			// Given a schema-valid id that also names an inherited object property.
			vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const onRespond = vi.fn();
			try {
				// When the request is rendered, selected, and submitted.
				act(() => root.render(
					<I18nContext.Provider value={i18n}>
						<ApprovalDock request={{ id: "request", method: "question", questions: [
							{ id, multiSelect: true, options: [{ label: "Go" }] },
						] }} onRespond={onRespond} />
					</I18nContext.Provider>,
				));
				const option = container.querySelector<HTMLButtonElement>(".th-approval-question-option");
				expect(option).not.toBeNull();
				act(() => option?.click());
				expect(option?.getAttribute("aria-pressed")).toBe("true");
				const submit = container.querySelector<HTMLButtonElement>(".th-approval-question-actions button");
				act(() => submit?.click());
				// Then the exact id survives as an own, serializable answer key.
				expect(onRespond).toHaveBeenCalledExactlyOnceWith({
					answers: Object.fromEntries([[id, { selected: ["Go"] }]]),
				});
				expect(JSON.stringify(onRespond.mock.calls[0]?.[0])).toBe(
					JSON.stringify({ answers: Object.fromEntries([[id, { selected: ["Go"] }]]) }),
				);
			} finally {
				act(() => root.unmount());
				container.remove();
			}
		},
	);
});
