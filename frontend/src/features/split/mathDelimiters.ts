import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { InlineMath } from "mdast-util-math";
import type { Root, Text } from "mdast";

interface SourceFile {
  readonly value: unknown;
}

interface MutableParent {
  readonly type: string;
  readonly url?: string;
  children: Array<MutableNode>;
}

type BackslashMath = Omit<InlineMath, "data"> & {
  data: NonNullable<InlineMath["data"]> & { readonly backslashDelimiter: "[" | "(" };
};

type MutableNode = (Text | BackslashMath | MutableParent) & {
  position?: Text["position"];
};

interface SourceToken {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly delimiter?: "[" | "]" | "(" | ")";
  valueStart?: number;
}

const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

/**
 * Turn model-style backslash math delimiters into mdast math nodes. CommonMark
 * has already classified code before this transformer runs, so only text nodes
 * are inspected. Node offsets let us detect real delimiters in the original
 * source; aligned source tokens preserve TeX spelling while excluding container
 * syntax that CommonMark omits from the text value.
 */
export function remarkBackslashMath(): (tree: Root, file: SourceFile) => void {
  return (tree, file) => {
    const source = typeof file.value === "string" ? file.value : String(file.value ?? "");
    transformChildren(tree as unknown as MutableParent, source);
  };
}

function transformChildren(parent: MutableParent, source: string): void {
  const next: MutableNode[] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      next.push(...transformText(child as Text, source));
    } else {
      if ("children" in child && !isAutolink(child, source)) {
        transformChildren(child as MutableParent, source);
      }
      next.push(child);
    }
  }
  parent.children = next;
}

function isAutolink(node: MutableNode, source: string): boolean {
  if (node.type !== "link" || !("children" in node) || node.children.length !== 1) return false;
  const child = node.children[0];
  if (child?.type !== "text" || node.url === undefined) return false;
  const text = child as Text;
  if (
    text.value !== node.url &&
    `mailto:${text.value}` !== node.url &&
    `http://${text.value}` !== node.url
  ) return false;

  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const spelling = source.slice(start, end);

  // CommonMark angle autolinks retain their backslashes, as do bare links
  // introduced by remark-gfm. Explicit links have Markdown label syntax here.
  return spelling.startsWith("<") || spelling === text.value;
}

function transformText(node: Text, source: string): MutableNode[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [node];

  const tokens = tokenizeSource(source.slice(start, end), start);
  alignTokens(tokens, node.value);
  const pairs = pairDelimiters(tokens);
  if (pairs.length === 0) return [node];

  const result: MutableNode[] = [];
  let valueOffset = 0;
  for (const [opener, closer] of pairs) {
    if (opener.valueStart === undefined || closer.valueStart === undefined) continue;
    if (opener.valueStart < valueOffset || closer.valueStart < opener.valueStart) continue;
    if (opener.valueStart > valueOffset) {
      result.push({ type: "text", value: node.value.slice(valueOffset, opener.valueStart) });
    }
    const value = sourceSpellingBetween(tokens, opener, closer, source);
    const delimiter = opener.delimiter === "[" ? "[" : "(";
    const display = delimiter === "[";
    result.push({
      type: "inlineMath",
      value,
      data: {
        hName: "code",
        hProperties: { className: ["language-math", display ? "math-display" : "math-inline"] },
        hChildren: [{ type: "text", value }],
        backslashDelimiter: delimiter,
      },
      position: {
        start: pointAt(source, opener.start),
        end: pointAt(source, closer.end),
      },
    });
    valueOffset = closer.valueStart + closer.value.length;
  }
  if (result.length === 0) return [node];
  if (valueOffset < node.value.length) result.push({ type: "text", value: node.value.slice(valueOffset) });
  return result;
}

function tokenizeSource(raw: string, baseOffset: number): SourceToken[] {
  const tokens: SourceToken[] = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === "\\") {
      let runEnd = i;
      while (raw[runEnd] === "\\") runEnd++;
      const following = raw[runEnd];
      const runLength = runEnd - i;
      if (runLength === 1 && following !== undefined && "[]()".includes(following)) {
        tokens.push({
          start: baseOffset + i,
          end: baseOffset + runEnd + 1,
          value: following,
          delimiter: following as "[" | "]" | "(" | ")",
        });
        i = runEnd + 1;
        continue;
      }
      if (runLength > 1 && following !== undefined && ESCAPABLE.test(following)) {
        const escapedFollowing = runLength % 2 === 1;
        tokens.push({
          start: baseOffset + i,
          end: baseOffset + runEnd + (escapedFollowing ? 1 : 0),
          value: "\\".repeat(Math.floor(runLength / 2)) + (escapedFollowing ? following : ""),
        });
        i = runEnd + (escapedFollowing ? 1 : 0);
        continue;
      }
      if (raw[i + 1] !== undefined && ESCAPABLE.test(raw[i + 1]!)) {
        tokens.push({ start: baseOffset + i, end: baseOffset + i + 2, value: raw[i + 1]! });
        i += 2;
        continue;
      }
    }
    if (raw[i] === "&") {
      const match = /^&(#(?:x[\dA-Fa-f]+|\d+)|[A-Za-z][A-Za-z\d]+);/.exec(raw.slice(i));
      const decoded = match === null ? false : decodeNamedCharacterReference(match[1]!);
      if (match !== null && decoded !== false) {
        tokens.push({ start: baseOffset + i, end: baseOffset + i + match[0].length, value: decoded });
        i += match[0].length;
        continue;
      }
    }
    if (raw[i] === "\r" && raw[i + 1] === "\n") {
      tokens.push({ start: baseOffset + i, end: baseOffset + i + 2, value: "\n" });
      i += 2;
      continue;
    }
    tokens.push({ start: baseOffset + i, end: baseOffset + i + 1, value: raw[i]! });
    i++;
  }
  return tokens;
}

/**
 * Align source tokens from the text node's positional boundaries. The first
 * source line starts at the node start; continuation lines end at their node
 * segment's line end. Working inward from those anchors excludes Markdown
 * container prefixes without comparing their characters to decoded text.
 */
function alignTokens(tokens: SourceToken[], value: string): void {
  const valueLines = value.split("\n");
  let tokenStart = 0;
  let valueStart = 0;

  for (let lineIndex = 0; lineIndex < valueLines.length; lineIndex++) {
    let tokenEnd = tokens.findIndex((token, index) => index >= tokenStart && token.value === "\n");
    if (tokenEnd === -1) tokenEnd = tokens.length;

    const valueLength = valueLines[lineIndex]!.length;
    if (lineIndex === 0) {
      alignForward(tokens, tokenStart, tokenEnd, valueStart, valueLength);
    } else {
      alignBackward(tokens, tokenStart, tokenEnd, valueStart, valueLength);
    }

    if (lineIndex < valueLines.length - 1 && tokenEnd < tokens.length) {
      tokens[tokenEnd]!.valueStart = valueStart + valueLength;
      tokenStart = tokenEnd + 1;
      valueStart += valueLength + 1;
    }
  }
}

function alignForward(
  tokens: SourceToken[],
  start: number,
  end: number,
  valueStart: number,
  valueLength: number,
): void {
  let length = 0;
  for (let index = start; index < end && length < valueLength; index++) {
    const token = tokens[index]!;
    if (length + token.value.length > valueLength) return;
    token.valueStart = valueStart + length;
    length += token.value.length;
  }
}

function alignBackward(
  tokens: SourceToken[],
  start: number,
  end: number,
  valueStart: number,
  valueLength: number,
): void {
  let index = end - 1;
  while (index >= start && (tokens[index]!.value === " " || tokens[index]!.value === "\t")) index--;

  let length = valueLength;
  for (; index >= start && length > 0; index--) {
    const token = tokens[index]!;
    if (token.value.length > length) return;
    length -= token.value.length;
    token.valueStart = valueStart + length;
  }
}

function sourceSpellingBetween(
  tokens: SourceToken[],
  opener: SourceToken,
  closer: SourceToken,
  source: string,
): string {
  const start = tokens.indexOf(opener) + 1;
  const end = tokens.indexOf(closer);
  return tokens
    .slice(start, end)
    .filter((token) => token.valueStart !== undefined)
    .map((token) => token.value === "\n" ? "\n" : source.slice(token.start, token.end))
    .join("");
}

function pairDelimiters(tokens: SourceToken[]): Array<readonly [SourceToken, SourceToken]> {
  const pairs: Array<readonly [SourceToken, SourceToken]> = [];
  let opener: SourceToken | undefined;
  for (const token of tokens) {
    if (token.valueStart === undefined || token.delimiter === undefined) continue;
    if (opener === undefined) {
      if (token.delimiter === "[" || token.delimiter === "(") opener = token;
      continue;
    }
    const expected = opener.delimiter === "[" ? "]" : ")";
    if (token.delimiter === expected) {
      pairs.push([opener, token]);
      opener = undefined;
    }
  }
  return pairs;
}

function pointAt(source: string, offset: number): { line: number; column: number; offset: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\r") {
      if (source[i + 1] === "\n") i++;
      line++;
      lineStart = i + 1;
    } else if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}
