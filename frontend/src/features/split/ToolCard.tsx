import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { IconCheck, IconChevron } from "../../components/icons";
import type { JsonValue } from "../../lib/chatWs";

export interface ToolCardProps {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly phase: "start" | "update" | "end";
  readonly text: string;
  readonly isError: boolean;
  readonly details?: JsonValue | undefined;
  readonly args?: unknown;
  readonly open?: boolean | undefined;
  readonly onOpenChange?: (open: boolean) => void;
  /** The previous transcript record is also a record: extend the rail up. */
  readonly continuesRail?: boolean | undefined;
  /** Extra root classes (the transcript's one-shot row entrance). */
  readonly className?: string | undefined;
}

interface SubagentMetadata {
  readonly title: string;
  readonly completed: boolean;
}

type ToolStatus = "error" | "ok" | "running";

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function subagentMetadata({ toolName, phase, text, details, args }: ToolCardProps): SubagentMetadata {
  const detailsObject = isObjectRecord(details) ? details : undefined;
  const argsObject = isObjectRecord(args) ? args : undefined;
  const tasks = argsObject && Array.isArray(argsObject["tasks"]) ? argsObject["tasks"] : undefined;
  const firstTask = tasks?.[0];
  const reportedStatus = nonEmptyString(detailsObject?.["status"]);
  return {
    title: nonEmptyString(detailsObject?.["task_summary"])
      ?? nonEmptyString(argsObject?.["description"])
      ?? nonEmptyString(isObjectRecord(firstTask) ? firstTask["name"] : undefined)
      ?? toolName,
    completed: reportedStatus === "completed"
      || (reportedStatus !== "running" && (phase === "end" || /\bcompleted?\b/i.test(text))),
  };
}

/** Arguments with at least one key; an empty object reads as no arguments. */
function argsRecord(args: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isObjectRecord(args)) return undefined;
  return Object.keys(args).length > 0 ? args : undefined;
}

/**
 * A read whose target file is exactly SKILL.md (case-sensitive basename)
 * presents as a skill read; the skill name is the manifest's immediate parent
 * directory, falling back to SKILL.md when the path has no parent.
 */
function skillReadName(args: unknown): string | undefined {
  if (!isObjectRecord(args)) return undefined;
  const path = args["path"];
  if (typeof path !== "string") return undefined;
  const segments = path.split("/");
  if (segments[segments.length - 1] !== "SKILL.md") return undefined;
  const parent = segments[segments.length - 2];
  return parent !== undefined && parent.length > 0 ? parent : "SKILL.md";
}

/** Tool names that ask the user structured questions (omo TOOL_NAMES). */
const ASK_USER_TOOL_NAMES = new Set(["ask_user_question", "request_user_input"]);

interface AskUserToolSummary {
  readonly headers: readonly string[];
  readonly wait: boolean;
  readonly statusLine: string | undefined;
}

/**
 * Question-tool header/summary (IS-9), mirroring omo's renderCall /
 * renderResult: the call presents as `[H1] [H2]` plus whether it waits for
 * the answer; a finished call summarizes as `status; N answered; N
 * unanswered` from the result details. Undefined for any other tool.
 */
function askUserToolSummary(toolName: string, args: unknown, details: JsonValue | undefined): AskUserToolSummary | undefined {
  if (!ASK_USER_TOOL_NAMES.has(toolName)) return undefined;
  const argsObject = isObjectRecord(args) ? args : undefined;
  const questions = Array.isArray(argsObject?.["questions"]) ? argsObject["questions"] : [];
  const headers = questions.map((question) =>
    isObjectRecord(question) && typeof question["header"] === "string" ? question["header"] : "Question",
  );
  const wait = argsObject?.["waitForAnswer"] === true || argsObject?.["wait_for_answer"] === true;
  let statusLine: string | undefined;
  if (isObjectRecord(details) && typeof details["status"] === "string") {
    let line: string = details["status"];
    const answers = details["answers"];
    if (isObjectRecord(answers)) line += `; ${Object.keys(answers).length} answered`;
    const unanswered = details["unanswered"];
    if (Array.isArray(unanswered)) line += `; ${unanswered.length} unanswered`;
    statusLine = line;
  }
  return { headers, wait, statusLine };
}

/** Latest non-empty line of an output stream, trimmed for the one-line preview. */
function latestOutputLine(text: string): string {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * One addressable transcript block per tool invocation (DESIGN.md
 * "Tool-execution block anatomy"): a two-line disclosure header (status glyph
 * and localized word, operation title, mono invocation summary with the latest
 * non-empty output line) over an inset Command/Input + Output body. Status is never
 * colour alone: running shows a spinner ring, done a check mark, failed an
 * exclamation mark, each beside a visible localized word. An untouched card
 * stays collapsed in every phase — running included; only a failed call
 * auto-opens, so errors are impossible to miss. The collapsed header preview
 * always shows the latest non-empty output line, so a closed card still reads
 * live progress. The first user toggle freezes that card's disclosure choice
 * permanently; later phase updates and completion never move it again.
 */
function toolStatus(props: ToolCardProps): ToolStatus {
  const subagent = props.toolName === "task" ? subagentMetadata(props) : undefined;
  if (subagent) return props.isError ? "error" : subagent.completed ? "ok" : "running";
  return props.phase === "end" ? (props.isError ? "error" : "ok") : "running";
}

export function ToolCard(props: ToolCardProps) {
  const { toolCallId, toolName, text } = props;
  const { t } = useT();
  const subagent = toolName === "task" ? subagentMetadata(props) : undefined;
  const status = toolStatus(props);
  // Uncontrolled fallback: an untouched card stays collapsed in every phase
  // (running included) — only a failed call auto-opens so errors are
  // impossible to miss, while the collapsed header preview keeps showing the
  // latest output line so a closed card still reads live progress. userChoice
  // stays null until this card's first toggle, which freezes the choice; a
  // controlled `open` prop (user choice recorded by the transcript) takes
  // precedence over both.
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const open = props.open ?? (userChoice ?? status === "error");
  // The output well reports a real overflow state so the bottom fade only
  // paints when content genuinely exceeds the cap (and clears once the
  // reader scrolls to the bottom). ResizeObserver and the scroll event are
  // layout signals, never timers.
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [outputClipped, setOutputClipped] = useState(false);
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (element === null) {
      setOutputClipped(false);
      return;
    }
    const measure = (): void => {
      const clipped = element.scrollHeight > element.clientHeight + 1;
      const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
      setOutputClipped(clipped && !atBottom);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [open, text]);

  const record = argsRecord(props.args);
  const command = record ? nonEmptyString(record["command"]) : undefined;
  const askUser = askUserToolSummary(toolName, props.args, props.details);
  // Question tools replace the raw-args invocation with the omo-style line:
  // `답을 기다림` / `나중에 답` while running, `status; N answered; N
  // unanswered` once done (IS-9). The full args stay in the expanded body.
  const askUserLine = askUser === undefined
    ? undefined
    : status === "running"
      ? t(askUser.wait ? "question.tool.wait" : "question.tool.later")
      : askUser.statusLine;
  const invocation = askUser === undefined
    ? command ?? (record ? JSON.stringify(record) : undefined)
    : undefined;
  const inputJson = record && command === undefined ? JSON.stringify(record, null, 2) : undefined;
  const preview = latestOutputLine(text);
  const hasBody = command !== undefined || inputJson !== undefined || text.length > 0;

  const skillName = toolName === "read" ? skillReadName(props.args) : undefined;
  const name = askUser !== undefined && askUser.headers.length > 0
    ? askUser.headers.map((header) => `[${header}]`).join(" ")
    : skillName !== undefined
      ? t("tool.skillRead", { name: skillName })
      : subagent?.title ?? toolName;
  const label = status === "running" ? t("tool.running") : status === "error" ? t("tool.error") : t("tool.done");
  return (
    <div
      className={
        `th-tool th-chat-record th-tool--${status}` +
        (props.continuesRail ? " th-chat-record--continue" : "") +
        (props.className ?? "")
      }
      data-tool-call-id={toolCallId}
    >
      <span className="th-chat-record-rail" aria-hidden="true" />
      <button
        type="button"
        className="th-tool-head"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          if (props.onOpenChange) props.onOpenChange(next);
          else setUserChoice(next);
        }}
      >
        <span className="th-tool-line">
          {status === "running" ? (
            <span className="th-chat-record-glyph th-tool-glyph th-tool-glyph--running" aria-hidden="true" />
          ) : status === "error" ? (
            <span className="th-chat-record-glyph th-tool-glyph th-tool-glyph--error" aria-hidden="true">!</span>
          ) : (
            <span className="th-chat-record-glyph th-tool-glyph th-tool-glyph--ok" aria-hidden="true">
              <IconCheck size={12} />
            </span>
          )}
          <span className={`th-tool-chevron${open ? " th-tool-chevron--open" : ""}`} aria-hidden="true">
            <IconChevron size={12} />
          </span>
          <span className="th-tool-name">{name}</span>
          <span className={`th-tool-status th-tool-status--${status}`}>{label}</span>
        </span>
        {(invocation !== undefined || askUserLine !== undefined || preview.length > 0) && (
          <span className="th-tool-summary">
            {invocation !== undefined && <span className="th-tool-cmd">{invocation}</span>}
            {askUserLine !== undefined && <span className="th-tool-cmd">{askUserLine}</span>}
            {(invocation !== undefined || askUserLine !== undefined) && preview.length > 0 && (
              <span className="th-tool-sep" aria-hidden="true"> · </span>
            )}
            {preview.length > 0 && <span className="th-tool-preview">{preview}</span>}
          </span>
        )}
      </button>
      {open && hasBody && (
        <div className="th-tool-body">
          {command !== undefined && (
            <section className="th-tool-section">
              <span className="th-tool-caption">{t("tool.command")}</span>
              <pre className="th-tool-io">{command}</pre>
            </section>
          )}
          {inputJson !== undefined && (
            <section className="th-tool-section">
              <span className="th-tool-caption">{t("tool.input")}</span>
              <pre className="th-tool-io">{inputJson}</pre>
            </section>
          )}
          {text.length > 0 && (
            <section className="th-tool-section">
              <span className="th-tool-caption">{t("tool.output")}</span>
              <pre
                ref={outputRef}
                className="th-tool-io th-tool-output"
                data-clipped={outputClipped ? "true" : undefined}
              >{text}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
