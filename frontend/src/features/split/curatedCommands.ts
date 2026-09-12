import type { CommandEntry } from "../../lib/chatWs";
import { commandPrefix } from "./commandMatch";

export const NEW_COMMAND: CommandEntry = { name: "new", source: "builtin", syntax: "slash" };

/**
 * Locale key for the curated compact description. The palette resolves it
 * through the i18n tables at render time; provider-advertised descriptions
 * are always rendered verbatim.
 */
export const COMPACT_DESCRIPTION_I18N_KEY = "chat.compactDescription";

/**
 * Client-curated palette entries that dispatch dedicated actions instead of
 * becoming model prompts. They are appended behind the provider-discovered
 * list and deduplicated by name, so a provider-advertised command always
 * stays authoritative and the palette never shows a duplicate row. The
 * compact description is not stored here: it is localized via
 * COMPACT_DESCRIPTION_I18N_KEY.
 */
export const COMPACT_COMMAND: CommandEntry = {
  name: "compact",
  source: "builtin",
  syntax: "slash",
};

export const UPDATE_COMMAND: CommandEntry = {
  name: "update",
  source: "builtin",
  syntax: "slash",
};

const CURATED: readonly CommandEntry[] = [COMPACT_COMMAND, UPDATE_COMMAND];

/** Merge curated entries behind the discovered list, skipping discovered names. */
export function mergeCommands(discovered: readonly CommandEntry[], includeNewChat = false): readonly CommandEntry[] {
  // Exact /new is a web navigation action, not the provider's in-place reset.
  // Reserve its slash row only; a provider's $new remains a separate command.
  const commands = includeNewChat
    ? [...discovered.filter(command => command.name !== NEW_COMMAND.name || commandPrefix(command) !== "/"), NEW_COMMAND]
    : discovered;
  const present = new Set(commands.map((command) => command.name));
  const additions = CURATED.filter((command) => !present.has(command.name));
  return additions.length === 0 ? commands : [...commands, ...additions];
}

/**
 * Whether a palette entry is the curated compact action. Compared by identity
 * so a same-named provider-discovered command is never hijacked.
 */
export function isCuratedCompact(command: CommandEntry): boolean {
  return command === COMPACT_COMMAND;
}
