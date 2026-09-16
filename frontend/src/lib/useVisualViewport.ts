import { useEffect, useState } from "react";

/** The visible region as the compositor reports it: the layout viewport
 *  minus whatever covers it (software keyboard, pinch zoom, iOS URL-bar
 *  pans). Unlike innerHeight, the iOS keyboard does NOT shrink the layout
 *  viewport — it covers it — so only this geometry sees the keyboard. */
export interface VisualViewportBox {
	readonly width: number;
	readonly height: number;
	readonly offsetTop: number;
	readonly offsetLeft: number;
}

function readBox(viewport: VisualViewport | null): VisualViewportBox {
	return viewport
		? {
				width: viewport.width,
				height: viewport.height,
				offsetTop: viewport.offsetTop,
				offsetLeft: viewport.offsetLeft,
			}
		: { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 };
}

/** Tracks window.visualViewport (resize + the pan offsets' scroll events).
 *  Absent VisualViewport (jsdom, old browsers): falls back to window resize
 *  with innerWidth/innerHeight and zero offsets — geometry only, no keyboard
 *  inference happens at this layer. Returns null until the first
 *  measurement, then a fresh box only when a value actually changed. */
export function useVisualViewport(): VisualViewportBox | null {
	const [box, setBox] = useState<VisualViewportBox | null>(null);
	useEffect(() => {
		const viewport = window.visualViewport ?? null;
		const measure = (): void => {
			setBox((previous) => {
				const next = readBox(viewport);
				return previous !== null &&
					previous.width === next.width &&
					previous.height === next.height &&
					previous.offsetTop === next.offsetTop &&
					previous.offsetLeft === next.offsetLeft
					? previous
					: next;
			});
		};
		measure();
		if (viewport) {
			viewport.addEventListener("resize", measure);
			viewport.addEventListener("scroll", measure);
			return () => {
				viewport.removeEventListener("resize", measure);
				viewport.removeEventListener("scroll", measure);
			};
		}
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);
	return box;
}
