/**
 * omo answer-frame support (IS-2, IS-9): the engine delivers an answered
 * ask_user_question / request_user_input as a USER message whose text is
 * `[Answer to question <requestId>]\n<body>`. These helpers parse that frame
 * and derive the chip summary rows exactly the way omo's own client does
 * (parseAskUserAnswerFrame / summaryRows / getAskUserAnswerHeaders), so the
 * transcript shows an answer chip instead of a bubble that reads as the
 * user's own words. Parsers return undefined/empty on malformed input and
 * never throw.
 */

export interface AskUserAnswerFrame {
  readonly requestId: string;
  readonly body: string;
}

/** Exact omo frame regex: header line, then the verbatim body. */
const ANSWER_FRAME_RE = /^\[Answer to question ([^\]\r\n]+)\]\r?\n([\s\S]*)$/;

/** Body prefixes omo treats as "no answer was given" outcomes. */
const NO_ANSWER_RE = /^(?:The user did not answer|The user dismissed|The pending question|This session has no user)/;

export function parseAskUserAnswerFrame(text: string): AskUserAnswerFrame | undefined {
  const match = ANSWER_FRAME_RE.exec(text);
  return match ? { requestId: match[1] ?? "", body: match[2] ?? "" } : undefined;
}

/** True when the frame body is one of omo's no-answer outcomes. */
export function askUserAnswerIsNoAnswer(frame: AskUserAnswerFrame): boolean {
  return NO_ANSWER_RE.test(frame.body);
}

/**
 * One chip summary row: `header` with the answered `value`, or `value`
 * undefined for a `(no answer)` row (the chip localizes that marker).
 * Mirrors omo's summaryRows: no-answer bodies collapse to one row per
 * fallback header; answered bodies yield one `Header: value` row per answer
 * line, a comment row keyed by the first known header, or one `(no answer)`
 * row per unanswered header; an unparseable body falls back to the headers.
 */
export interface AskUserAnswerRow {
  readonly header: string;
  readonly value?: string | undefined;
}

export function askUserAnswerRows(frame: AskUserAnswerFrame, headers: readonly string[]): readonly AskUserAnswerRow[] {
  const fallbackHeaders = headers.length > 0 ? headers : [frame.requestId];
  if (askUserAnswerIsNoAnswer(frame)) {
    return fallbackHeaders.map((header) => ({ header }));
  }
  const answers: AskUserAnswerRow[] = [];
  let comment: string | undefined;
  let unanswered: readonly string[] = [];
  for (const line of frame.body.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator < 1) continue;
    const header = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (header === "The user responded") comment = value;
    else if (header === "Unanswered") unanswered = value.split(", ");
    else answers.push({ header, value });
  }
  if (comment !== undefined) {
    answers.push({ header: headers[0] ?? unanswered[0] ?? frame.requestId, value: JSON.stringify(comment) });
  } else {
    answers.push(...unanswered.map((header) => ({ header })));
  }
  return answers.length > 0 ? answers : fallbackHeaders.map((header) => ({ header }));
}

/** Tool names whose args carry the question headers (omo TOOL_NAMES). */
const ASK_USER_TOOL_NAMES = new Set(["ask_user_question", "request_user_input"]);

/** Minimal structural view of a transcript message for header lookup. */
export interface AskUserHeaderSource {
  readonly blocks?: readonly {
    readonly kind: string;
    readonly id?: string | undefined;
    readonly name?: string | undefined;
    readonly arguments?: unknown;
  }[] | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Headers of the ask_user_question / request_user_input call whose toolCallId
 * is `requestId`, read from the transcript's toolCall blocks (newest first,
 * like omo's getAskUserAnswerHeaders). Empty when no matching call exists;
 * callers fall back to `[requestId]`.
 */
export function askUserHeadersFor(requestId: string, messages: readonly AskUserHeaderSource[]): readonly string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.blocks ?? [];
    for (const block of blocks) {
      if (block.kind !== "toolCall" && block.kind !== "tool") continue;
      if (block.id !== requestId) continue;
      if (block.name === undefined || !ASK_USER_TOOL_NAMES.has(block.name)) continue;
      const args = isRecord(block.arguments) ? block.arguments : undefined;
      const questions = Array.isArray(args?.["questions"]) ? args["questions"] : [];
      const headers = questions
        .map((question) => (isRecord(question) ? question["header"] : undefined))
        .filter((header): header is string => typeof header === "string");
      if (headers.length > 0) return headers;
    }
  }
  return [];
}
