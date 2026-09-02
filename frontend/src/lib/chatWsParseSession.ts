import type { ChatServerFrame } from "./chatWs";
import {
  isRecord,
  mapRecords,
  optBoolean,
  optNumber,
  optString,
  optStringArray,
  parseCommandEntry,
  parseContextUsage,
  parseModelEntry,
  reqBoolean,
  reqString,
  sanitizeJson,
} from "./chatWsParseFields";

type SessionFrameType = "state" | "stats" | "extensionEvent" | "sessions.activity" | "approval" | "commands" | "models" | "entries";

/**
 * Session-surface frames, built field-by-field into the generated contract
 * members. entries now enforces the v2 wire contract: `entries` must be an
 * array and `final` is REQUIRED on every page (invariant 18) — the seam keeps
 * `final` optional only because features deliver typed literals directly.
 */
export function parseSessionFrame(
  type: SessionFrameType,
  msg: Record<string, unknown>,
  sessionId: string | null,
): ChatServerFrame | null {
  switch (type) {
    case "state": {
      if (sessionId === null) return null;
      const isStreaming = reqBoolean(msg, "isStreaming");
      const isCompacting = reqBoolean(msg, "isCompacting");
      if (isStreaming === null || isCompacting === null) return null;
      const thinkingLevel = optString(msg, "thinkingLevel");
      const sessionName = optString(msg, "sessionName");
      if (thinkingLevel === null || sessionName === null) return null;
      const rawModel = msg["model"];
      let model: { readonly provider: string; readonly modelId: string } | null | undefined;
      if (rawModel === undefined) model = undefined;
      else if (rawModel === null) model = null;
      else if (isRecord(rawModel)) {
        const provider = reqString(rawModel, "provider");
        const modelId = reqString(rawModel, "modelId");
        if (provider === null || modelId === null) return null;
        model = { provider, modelId };
      } else return null;
      return {
        type: "state",
        sessionId,
        isStreaming,
        isCompacting,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(sessionName !== undefined ? { sessionName } : {}),
      };
    }
    case "stats": {
      if (sessionId === null) return null;
      const cost = optNumber(msg, "cost");
      const contextUsage = parseContextUsage(msg["contextUsage"]);
      const tokens = msg["tokens"] as import("./contract/types_gen").TokenUsage | undefined;
      if (cost === null || contextUsage === null) return null;
      if (cost === undefined && contextUsage === undefined && tokens === undefined) return null;
      return {
        type: "stats",
        sessionId,
        ...(cost !== undefined ? { cost } : {}),
        ...(contextUsage !== undefined ? { contextUsage } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      };
    }
    case "extensionEvent": {
      if (sessionId === null) return null;
      const name = reqString(msg, "name");
      const data = msg["data"];
      if (name === null || name.length === 0) return null;
      return { type: "extensionEvent", sessionId, name, ...(data !== undefined ? { data: sanitizeJson(data) } : {}) };
    }
    case "sessions.activity": {
      if (sessionId === null || !Array.isArray(msg["snapshots"])) return null;
      const overflow = reqBoolean(msg, "overflow");
      if (overflow === null) return null;
      const snapshots = msg["snapshots"].map((value) => {
        if (!isRecord(value)) return null;
        const name = value["name"];
        const oversized = reqBoolean(value, "oversized");
        if ((name !== "omo.task.updated" && name !== "omo.dag.updated") || oversized === null) return null;
        return {
          name,
          oversized,
          ...(value["data"] === undefined ? {} : { data: sanitizeJson(value["data"]) }),
        };
      });
      if (snapshots.some((snapshot) => snapshot === null)) return null;
      const taskDigest = msg["taskDigest"] as import("./contract/types_gen").TaskDigest | undefined;
      const dagDigest = msg["dagDigest"] as import("./contract/types_gen").DagDigest | undefined;
      return {
        type: "sessions.activity",
        sessionId,
        snapshots: snapshots as import("./contract/types_gen").ActivitySnapshot[],
        overflow,
        ...(taskDigest === undefined ? {} : { taskDigest }),
        ...(dagDigest === undefined ? {} : { dagDigest }),
      };
    }
    case "approval": {
      if (sessionId === null) return null;
      const id = reqString(msg, "id");
      const method = msg["method"];
      if (id === null) return null;
      if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return null;
      const title = optString(msg, "title");
      const message = optString(msg, "message");
      const options = optStringArray(msg, "options");
      const prefill = optString(msg, "prefill");
      const placeholder = optString(msg, "placeholder");
      if (title === null || message === null || options === null || prefill === null || placeholder === null) return null;
      return {
        type: "approval",
        sessionId,
        id,
        method,
        ...(title !== undefined ? { title } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      };
    }
    case "commands": {
      if (sessionId === null) return null;
      const commands = mapRecords(msg["commands"], parseCommandEntry);
      if (commands === null) return null;
      return { type: "commands", sessionId, commands };
    }
    case "models": {
      if (sessionId === null) return null;
      const models = mapRecords(msg["models"], parseModelEntry);
      if (models === null) return null;
      return { type: "models", sessionId, models };
    }
    case "entries": {
      if (sessionId === null) return null;
      const rawEntries = msg["entries"];
      if (!Array.isArray(rawEntries)) return null;
      const entries = rawEntries.map((item) => sanitizeJson(item));
      const leafId = optString(msg, "leafId");
      if (leafId === null) return null;
      // final is REQUIRED on every entries page (invariant 18); a frame
      // without it is malformed wire data, not a terminal page.
      const final = reqBoolean(msg, "final");
      if (final === null) return null;
      return { type: "entries", sessionId, entries, ...(leafId !== undefined ? { leafId } : {}), final };
    }
  }
}
