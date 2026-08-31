import type { CommandEntry } from "../../lib/chatWs";

export type CommandPrefix = "/" | "$";

/** Invocation marker advertised by the provider; legacy entries are slash commands. */
export function commandPrefix(command: CommandEntry): CommandPrefix {
  return command.syntax === "dollar" ? "$" : "/";
}

export function matchCommands(
  commands: readonly CommandEntry[],
  query: string,
): readonly CommandEntry[] {
  if (query === "") return commands;
  const needle = query.toLowerCase();
  const prefixed: CommandEntry[] = [];
  const contained: CommandEntry[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefixed.push(command);
    else if (name.includes(needle)) contained.push(command);
  }
  return [...prefixed, ...contained];
}

export interface CommandTrigger {
  readonly start: number;
  readonly query: string;
  readonly prefix: CommandPrefix;
}

/** Finds a slash or dollar command trigger at the caret position. Mirrors the
 *  @-mention boundary rule: the trigger starts a whitespace-delimited token,
 *  and the caret remains inside that token. */
export function detectCommandTrigger(input: string, caret: number): CommandTrigger | null {
  if (caret <= 0) return null;
  const prev = input[caret - 1];
  if (prev === " " || prev === "\n" || prev === "\t") return null;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = input[i];
    if (ch === "/" || ch === "$") {
      const before = i === 0 ? " " : input[i - 1];
      if (before === " " || before === "\n" || before === "\t") {
        return { start: i, query: input.slice(i + 1, caret), prefix: ch };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
  }
  return null;
}
