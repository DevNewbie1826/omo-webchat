import { describe, expect, it } from "vitest";
import { concatEntries } from "./chatEntries";

describe("concatEntries", () => {
	it("flattens page arrays in order and ignores non-arrays", () => {
		expect(concatEntries([[{ a: 1 }], [{ b: 2 }, { c: 3 }], "nope"])).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});
