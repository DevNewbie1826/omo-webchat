import { apiJson } from "../../lib/api";
import { isRecord } from "../../lib/chatWsParseFields";
import type { LiveSessionInfo as LegacySessionInfo } from "./workspace";

/** Session-level scalars are independent of retained task/DAG topology. */
export interface LeanSessionFields {
  readonly last_activity_ms?: number;
  readonly running?: { readonly agents?: number; readonly tasks?: number; readonly dag?: number };
  readonly done?: number;
  readonly dag_done?: number;
  readonly dag_total?: number;
  readonly truncated?: { readonly task?: boolean; readonly dag?: boolean };
  readonly last_line?: string;
}
export interface LiveSessionInfo extends LegacySessionInfo {
  readonly lean?: LeanSessionFields;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Unknown or malformed optional scalars remain absent at the REST boundary. */
export function parseLeanSessionFields(value: unknown): LeanSessionFields | undefined {
  if (!isRecord(value)) return undefined;
  const running = isRecord(value["running"]) ? value["running"] : {};
  const truncated = isRecord(value["truncated"]) ? value["truncated"] : {};
  const agents = count(running["agents"]), tasks = count(running["tasks"]), dag = count(running["dag"]);
  const at = count(value["last_activity_ms"]), done = count(value["done"]);
  const dagDone = count(value["dag_done"]), dagTotal = count(value["dag_total"]);
  const fields: LeanSessionFields = {
    ...(at === undefined ? {} : { last_activity_ms: at }),
    ...(agents === undefined && tasks === undefined && dag === undefined ? {} : { running: {
      ...(agents === undefined ? {} : { agents }), ...(tasks === undefined ? {} : { tasks }),
      ...(dag === undefined ? {} : { dag }),
    } }),
    ...(done === undefined ? {} : { done }),
    ...(dagDone === undefined ? {} : { dag_done: dagDone }),
    ...(dagTotal === undefined ? {} : { dag_total: dagTotal }),
    ...(typeof truncated["task"] !== "boolean" && typeof truncated["dag"] !== "boolean" ? {} : { truncated: {
      ...(typeof truncated["task"] === "boolean" ? { task: truncated["task"] } : {}),
      ...(typeof truncated["dag"] === "boolean" ? { dag: truncated["dag"] } : {}),
    } }),
    ...(typeof value["last_line"] === "string" ? { last_line: value["last_line"] } : {}),
  };
  return Object.keys(fields).length === 0 ? undefined : fields;
}

export async function listLiveSummarySessions(signal: AbortSignal): Promise<readonly LiveSessionInfo[]> {
  const response = await apiJson<unknown>("/api/sessions/live", { signal });
  if (!isRecord(response) || !Array.isArray(response["sessions"])) throw new TypeError("Invalid live sessions response");
  const sessions: LiveSessionInfo[] = [];
  for (const entry of response["sessions"]) {
    if (typeof entry === "string") {
      if (entry.length > 0) sessions.push({ id: entry, title: "", task: null, dag: null, lean: {} });
      continue;
    }
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"].length === 0) continue;
    const lean = parseLeanSessionFields(entry);
    sessions.push({
      id: entry["id"], title: typeof entry["title"] === "string" ? entry["title"] : "",
      ...(typeof entry["active"] === "boolean" ? { active: entry["active"] } : {}),
      task: null, dag: null, lean: lean ?? {},
    });
  }
  return sessions;
}

/** Retain the newest server revision across poll settles, pushes and aliases.
 * Arrival ordering is only a fallback for transitional timestamp-less rows. */
export function acceptLeanSession(previous: LiveSessionInfo | undefined, incoming: LiveSessionInfo): LiveSessionInfo {
  if (previous?.lean === undefined) return incoming;
  const known = previous.lean.last_activity_ms;
  const at = incoming.lean?.last_activity_ms;
  if (incoming.lean === undefined || (known !== undefined && (at === undefined || at < known))) return previous;
  return { ...incoming, lean: {
    ...previous.lean, ...incoming.lean,
    ...(previous.lean.running === undefined && incoming.lean.running === undefined ? {} : {
      running: { ...previous.lean.running, ...incoming.lean.running },
    }),
    ...(previous.lean.truncated === undefined && incoming.lean.truncated === undefined ? {} : {
      truncated: { ...previous.lean.truncated, ...incoming.lean.truncated },
    }),
  } };
}
