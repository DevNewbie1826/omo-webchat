import { useState } from "react";
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
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
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

/** First non-empty line of an output stream, trimmed for the one-line preview. */
function firstOutputLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * One addressable transcript block per tool invocation (DESIGN.md
 * "Tool-execution block anatomy"): a two-line disclosure header (status glyph
 * and localized word, operation title, mono invocation summary with the first
 * output line) over an inset Command/Input + Output body. Status is never
 * colour alone: running shows a spinner ring, done a check mark, failed an
 * exclamation mark, each beside a visible localized word. A newly started
 * block begins expanded so current work is observable; once the user toggles
 * it, phase updates and completion never override that choice.
 */
function toolStatus(props: ToolCardProps): ToolStatus {
  const subagent = props.toolName === "task" ? subagentMetadata(props) : undefined;
  if (subagent) return props.isError ? "error" : subagent.completed ? "ok" : "running";
  return props.phase === "end" ? (props.isError ? "error" : "ok") : "running";
}

export function toolCardInitiallyOpen(props: ToolCardProps): boolean {
  return toolStatus(props) === "running";
}

export function ToolCard(props: ToolCardProps) {
  const { toolCallId, toolName, text } = props;
  const { t } = useT();
  const subagent = toolName === "task" ? subagentMetadata(props) : undefined;
  const status = toolStatus(props);
  // Completed blocks restored from history start collapsed; a live block
  // starts expanded. The initial value is latched: later phase updates and
  // completion never move the disclosure on the user's behalf.
  const [localOpen, setLocalOpen] = useState(() => status === "running");
  const open = props.open ?? localOpen;

  const record = argsRecord(props.args);
  const command = record ? nonEmptyString(record["command"]) : undefined;
  const invocation = command ?? (record ? JSON.stringify(record) : undefined);
  const inputJson = record && command === undefined ? JSON.stringify(record, null, 2) : undefined;
  const preview = firstOutputLine(text);
  const hasBody = command !== undefined || inputJson !== undefined || text.length > 0;

  const name = subagent?.title ?? toolName;
  const label = status === "running" ? t("tool.running") : status === "error" ? t("tool.error") : t("tool.done");
  return (
    <div className={`th-tool th-tool--${status}`} data-tool-call-id={toolCallId}>
      <button
        type="button"
        className="th-tool-head"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          if (props.onOpenChange) props.onOpenChange(next);
          else setLocalOpen(next);
        }}
      >
        <span className="th-tool-line">
          <span className={`th-tool-chevron${open ? " th-tool-chevron--open" : ""}`} aria-hidden="true">
            <IconChevron size={12} />
          </span>
          {status === "running" ? (
            <span className="th-tool-glyph th-tool-glyph--running" aria-hidden="true" />
          ) : status === "error" ? (
            <span className="th-tool-glyph th-tool-glyph--error" aria-hidden="true">!</span>
          ) : (
            <span className="th-tool-glyph th-tool-glyph--ok" aria-hidden="true">
              <IconCheck size={12} />
            </span>
          )}
          <span className="th-tool-name">{name}</span>
          <span className={`th-tool-status th-tool-status--${status}`}>{label}</span>
        </span>
        {(invocation !== undefined || preview.length > 0) && (
          <span className="th-tool-summary">
            {invocation !== undefined && <span className="th-tool-cmd">{invocation}</span>}
            {invocation !== undefined && preview.length > 0 && (
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
              <pre className="th-tool-io th-tool-output">{text}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
