import { isRecord } from "../../lib/chatWsParseFields";

/** Map array records, dropping malformed items instead of rejecting the snapshot. */
export function mapDrop<T>(value: unknown, mapItem: (item: Record<string, unknown>) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const mapped = mapItem(item);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

export function optSchemaVersion(record: Record<string, unknown>): number | string | null | undefined {
  const value = record["schemaVersion"];
  if (value === undefined) return undefined;
  return typeof value === "string" || typeof value === "number" ? value : null;
}
