import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, assert } from "vitest";
import { detectLang, persistLang, useDocumentLang } from "./index";
import type { Lang } from "./index";

import pageHtml from "../../index.html?raw";

/** Evals the real pre-hydration inline script from index.html in an iframe. */
function evalPreHydrationLangScript(options: {
	readonly stored?: string;
	readonly navigatorLanguage: string;
}): string {
	const script = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
		.map((match) => match[1])
		.find((body) => body?.includes('"th-lang"'));
	assert(script, "index.html must carry an inline pre-hydration lang script");

	const frame = document.createElement("iframe");
	document.body.appendChild(frame);
	assert(frame.contentWindow);
	assert(frame.contentDocument);
	const scope = frame.contentWindow as typeof window;
	try {
		Object.defineProperty(scope.navigator, "language", {
			configurable: true,
			value: options.navigatorLanguage,
		});
		// Same-origin storage is shared across iframes in jsdom: start clean.
		scope.localStorage.removeItem("th-lang");
		if (options.stored !== undefined) {
			scope.localStorage.setItem("th-lang", options.stored);
		}
		scope.eval(script);
		return frame.contentDocument.documentElement.lang;
	} finally {
		frame.remove();
	}
}

describe("pre-hydration document language (index.html inline script)", () => {
	it("applies a stored ko choice before hydration, over an English navigator", () => {
		expect(evalPreHydrationLangScript({ stored: "ko", navigatorLanguage: "en-US" })).toBe("ko");
	});

	it("applies a stored en choice before hydration, over a Korean navigator", () => {
		expect(evalPreHydrationLangScript({ stored: "en", navigatorLanguage: "ko-KR" })).toBe("en");
	});

	it("detects Korean from the navigator before hydration when nothing is stored", () => {
		expect(evalPreHydrationLangScript({ navigatorLanguage: "ko-KR" })).toBe("ko");
	});

	it("defaults to English before hydration for a non-Korean navigator", () => {
		expect(evalPreHydrationLangScript({ navigatorLanguage: "en-US" })).toBe("en");
	});
});

describe("detectLang", () => {
	afterEach(() => {
		window.localStorage.clear();
		vi.unstubAllGlobals();
	});

	function stubNavigatorLanguage(language: string): void {
		vi.stubGlobal("navigator", { language });
	}

	it("prefers a stored en choice over a Korean navigator", () => {
		window.localStorage.setItem("th-lang", "en");
		stubNavigatorLanguage("ko-KR");
		expect(detectLang()).toBe("en");
	});

	it("prefers a stored ko choice over an English navigator", () => {
		window.localStorage.setItem("th-lang", "ko");
		stubNavigatorLanguage("en-US");
		expect(detectLang()).toBe("ko");
	});

	it("detects Korean from the navigator when nothing is stored", () => {
		stubNavigatorLanguage("ko-KR");
		expect(detectLang()).toBe("ko");
	});

	it("falls back to English for a non-Korean navigator when nothing is stored", () => {
		stubNavigatorLanguage("en-US");
		expect(detectLang()).toBe("en");
	});

	it("ignores a stored value that is not a supported locale", () => {
		window.localStorage.setItem("th-lang", "fr");
		stubNavigatorLanguage("en-US");
		expect(detectLang()).toBe("en");
	});

	it("falls back to navigator language when storage reads throw", () => {
		stubNavigatorLanguage("ko-KR");
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		try {
			expect(detectLang()).toBe("ko");
		} finally {
			getItem.mockRestore();
		}
	});

	it("treats a throwing storage write as a non-persistent choice", () => {
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		try {
			expect(() => persistLang("ko")).not.toThrow();
		} finally {
			setItem.mockRestore();
		}
	});
});

describe("useDocumentLang", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.documentElement.lang = "";
		vi.unstubAllGlobals();
	});

	function Harness({ initial }: { readonly initial: Lang }) {
		const [lang, setLang] = useState<Lang>(initial);
		useDocumentLang(lang);
		return (
			<button type="button" data-testid="switch" onClick={() => setLang(lang === "en" ? "ko" : "en")}>
				switch
			</button>
		);
	}

	it("sets the document language to the active locale on mount", () => {
		act(() => {
			root.render(<Harness initial="ko" />);
		});
		expect(document.documentElement.lang).toBe("ko");
	});

	it("tracks the document language when the locale switches", () => {
		act(() => {
			root.render(<Harness initial="en" />);
		});
		expect(document.documentElement.lang).toBe("en");

		const button = container.querySelector<HTMLButtonElement>('[data-testid="switch"]');
		if (!button) throw new Error("missing switch button");
		act(() => {
			button.click();
		});
		expect(document.documentElement.lang).toBe("ko");
	});
});
