import { useEffect, useState } from "react";

/** The app-global keyboard judgment: the boot script in index.html toggles
 *  this attribute on <html> when the visible viewport shrinks more than
 *  100px below its unobscured baseline, and global.css shrinks #root by the
 *  same attribute. It is the single source of truth — components read it
 *  instead of re-deriving keyboard-ness from their own geometry thresholds,
 *  or the app prices the keyboard twice (the #root shrink AND a local
 *  clamp). */
const KEYBOARD_OPEN_ATTRIBUTE = "data-th-keyboard-open";

function readKeyboardOpen(): boolean {
	return document.documentElement.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE);
}

/** React read of the boot script's data-th-keyboard-open decision. Re-reads
 *  on window resize and visualViewport resize/scroll (the geometry events
 *  the boot script judges by) and on the attribute itself through a
 *  MutationObserver — the authoritative edge, delivered even when the
 *  attribute flips without a geometry event this component observed.
 *  Stable: state flips only when the attribute actually does (setState
 *  bails on an unchanged boolean), so geometry noise never re-renders. */
export function useGlobalKeyboardOpen(): boolean {
	const [open, setOpen] = useState<boolean>(readKeyboardOpen);
	useEffect(() => {
		const read = (): void => {
			setOpen(readKeyboardOpen());
		};
		read();
		window.addEventListener("resize", read);
		const viewport = window.visualViewport ?? null;
		viewport?.addEventListener("resize", read);
		viewport?.addEventListener("scroll", read);
		const observer = new MutationObserver(read);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [KEYBOARD_OPEN_ATTRIBUTE],
		});
		return () => {
			window.removeEventListener("resize", read);
			viewport?.removeEventListener("resize", read);
			viewport?.removeEventListener("scroll", read);
			observer.disconnect();
		};
	}, []);
	return open;
}
