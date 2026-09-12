import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../../lib/chatWs";
import { COMPACT_COMMAND, isCuratedCompact, mergeCommands, NEW_COMMAND } from "./curatedCommands";

describe("mergeCommands", () => {
  it("appends the curated compact action after the provider-discovered commands", () => {
    const discovered: readonly CommandEntry[] = [
      { name: "hooks", description: "Inspect hooks", source: "extension", syntax: "slash" },
      { name: "todo", description: "Todos", source: "extension", syntax: "slash" },
    ];
    expect(mergeCommands(discovered)).toEqual([...discovered, COMPACT_COMMAND]);
  });

  it("keeps the provider-discovered list untouched and in order when nothing is added", () => {
    const discovered: readonly CommandEntry[] = [{ name: "compact", description: "Provider compact", source: "extension" }];
    // A provider-advertised compact suppresses the curated entry: the
    // discovered list is returned by identity, so provider commands stay
    // authoritative and no duplicate /compact row can render.
    expect(mergeCommands(discovered)).toBe(discovered);
  });

  it("offers the curated compact action when nothing was discovered", () => {
    expect(mergeCommands([])).toEqual([COMPACT_COMMAND]);
  });

  it("offers local new-chat navigation only when the composer can create chats", () => {
    expect(mergeCommands([], true)).toEqual([NEW_COMMAND, COMPACT_COMMAND]);
  });

  it("reserves /new without hijacking $new or provider compact", () => {
    const slashNew: CommandEntry = { name: "new", source: "extension" };
    const dollarNew: CommandEntry = { name: "new", source: "skill", syntax: "dollar" };
    const compact: CommandEntry = { name: "compact", source: "extension" };
    const discovered = [slashNew, dollarNew, compact];
    expect(mergeCommands(discovered, true)).toEqual([dollarNew, compact, NEW_COMMAND]);
    expect(discovered).toEqual([slashNew, dollarNew, compact]);
  });
});

describe("isCuratedCompact", () => {
  it("matches only the curated entry, never a same-named provider command", () => {
    expect(isCuratedCompact(COMPACT_COMMAND)).toBe(true);
    expect(isCuratedCompact({ name: "compact", description: "Provider compact", source: "extension" })).toBe(false);
  });
});
