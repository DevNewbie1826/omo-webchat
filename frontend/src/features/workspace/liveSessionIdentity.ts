/** Identity belongs to the overview row, never to a transitive durable alias.
 * PR #197: stored rows use chat IDs; durable-keyed rows are provisional, and
 * replacements name either that provisional ID or the durable's current chat.
 */
import { observeAttachedOverview } from "./liveAttachedBindings";
import { forgetLiveContentRevision, migrateLiveContentRevision, observeLiveContentRevision, resetLiveContentRevisions } from "./liveContentRevision";

interface RowIdentity {
  readonly durable?: string;
  readonly bindingId?: string;
  readonly receipt?: number;
  readonly generation: number;
  readonly removed: boolean;
}

type Delivery = {
  readonly chatId: string;
  readonly durableId?: string;
  readonly bindingId?: string;
  readonly receipt?: number;
} & (
  | { readonly kind: "push"; readonly sequence: number; readonly replacedId?: string }
  | { readonly kind: "poll"; readonly requestSequence: number }
);

export type LiveAdmission =
  | { readonly accept: false }
  | { readonly accept: true; readonly id: string; readonly durable?: string;
      readonly bindingId?: string; readonly changedBinding: boolean;
      readonly receipt?: number; readonly sequence: number; readonly generation: number;
      readonly changedDurable: boolean; readonly replacedId?: string;
      readonly provisional: boolean; readonly migrateSource: boolean };

let rows = new Map<string, RowIdentity>();
let owners = new Map<string, string>();
let aliases = new Map<string, { readonly owner: string; readonly durable: string }>();
let generations = new Map<string, number>();
// Membership can retire a row while an older publication is still queued.
// Keep resident fences and a bounded history of retired/replaced IDs.
const MAX_ROW_WATERMARKS = 512;
let rowWatermarks = new Map<string, number>();
let evictionFloor = -1;

function pruneRowWatermarks(): void {
  if (rowWatermarks.size <= MAX_ROW_WATERMARKS) return;
  const resident = new Set<string>();
  for (const [id, row] of rows) if (!row.removed) resident.add(id);
  for (const owner of owners.values()) resident.add(owner);
  for (const alias of aliases.values()) resident.add(alias.owner);
  while (rowWatermarks.size > MAX_ROW_WATERMARKS) {
    let oldest: string | undefined;
    let revision = Infinity;
    for (const [id, known] of rowWatermarks) {
      if (!resident.has(id) && known < revision) {
        oldest = id;
        revision = known;
      }
    }
    if (oldest === undefined) break;
    rowWatermarks.delete(oldest);
    evictionFloor = Math.max(evictionFloor, revision, forgetLiveContentRevision(oldest));
  }
}

export function canonicalLiveSessionId(id: string): string {
  return aliases.get(id)?.owner ?? id;
}

/** The overview's accepted binding for this row, not an attached socket's claim. */
export function liveAcceptedDurable(id: string): string | undefined {
  return liveAcceptedBinding(id)?.durable;
}

export function liveAcceptedBinding(id: string): RowIdentity | undefined {
  const row = rows.get(canonicalLiveSessionId(id));
  return row?.removed === false ? row : undefined;
}

export function liveDurableOwner(durable: string): string | undefined {
  return owners.get(durable);
}

/** Bound historical caches only after their row, ownership and alias leave. */
export function isResidentLiveSession(id: string): boolean {
  return rows.get(id)?.removed === false
    || [...owners.values()].includes(id)
    || [...aliases.values()].some((alias) => alias.owner === id);
}

/** The server issues REST and WS row revisions from one manager-wide clock.
 * A versioned publication must exceed every ID it touches (destination and
 * replacement source); only an identical same-row replay may tie. Request
 * generations fence timestamp-less legacy rows, never versioned rows.
 */
export function admitCurrentLiveFrame(frame: Delivery): LiveAdmission {
  const id = frame.chatId;
  const previous = rows.get(id);
  const durable = frame.durableId ?? previous?.durable;
  const changedDurable = previous?.durable !== undefined && durable !== previous.durable;
  const changedBinding = previous !== undefined && previous.bindingId !== frame.bindingId;
  const sequence = frame.kind === "push" ? frame.sequence : frame.requestSequence;
  const replacedId = frame.kind === "push" ? frame.replacedId : undefined;
  const source = replacedId === undefined ? undefined : rows.get(replacedId);
  const provisional = replacedId !== undefined && replacedId === durable
    && (source?.durable === undefined || source.durable === replacedId);
  if (frame.kind === "poll") {
    if (aliases.has(id)) return { accept: false };
    if (frame.receipt === undefined && (generations.get(id) ?? -1) > sequence) return { accept: false };
    // A durable-keyed REST row cannot represent a chat which already owns it.
    if ((durable === id || durable === undefined) && owners.has(id) && owners.get(id) !== id) {
      return { accept: false };
    }
    if (frame.receipt === undefined && durable !== undefined
      && (generations.get(durable) ?? -1) > sequence) return { accept: false };
  }
  if (replacedId !== undefined) {
    if (durable === undefined) return { accept: false };
    // A self-replacement cannot move an existing row to another durable.
    if (replacedId === id && source?.durable !== undefined && source.durable !== durable) {
      return { accept: false };
    }
    // Timestamp-less legacy publications still need local ownership evidence.
    if (frame.receipt === undefined && replacedId !== id
      && (source?.removed || aliases.has(replacedId)
        || (source?.durable !== durable && !(provisional && !owners.has(durable)))
        || (owners.get(durable) !== replacedId && !(provisional && !owners.has(durable))))) {
      return { accept: false };
    }
  }
  const owner = durable === undefined ? undefined : owners.get(durable);
  if (frame.receipt !== undefined) {
    const touched = replacedId === undefined || replacedId === id ? [id] : [id, replacedId];
    for (const touchedId of touched) {
      const known = rowWatermarks.get(touchedId);
      if (known === undefined && frame.receipt <= evictionFloor) return { accept: false };
      if (known !== undefined && (frame.receipt < known
        || (frame.receipt === known && (replacedId !== undefined && replacedId !== id
          || touchedId !== id || previous?.removed
          || previous?.receipt !== known || previous.bindingId !== frame.bindingId || (previous.durable !== undefined
            && previous.durable !== durable))))) return { accept: false };
    }
    // A replacement must also beat the present durable owner, even when it
    // names an older source that no longer owns this durable.
    if (replacedId !== undefined && replacedId !== id && owner !== undefined
      && owner !== id && owner !== replacedId
      && frame.receipt <= (rowWatermarks.get(owner) ?? rows.get(owner)?.receipt ?? -1)) {
      return { accept: false };
    }
  } else if (previous?.receipt !== undefined) {
    // A timestamp-less legacy row cannot supersede a versioned row.
    return { accept: false };
  }
  const replacement = replacedId !== undefined && replacedId !== id;
  const generation = changedDurable || changedBinding || replacement || (owner !== undefined && owner !== id)
    ? sequence : previous?.generation ?? -1;
  return {
    accept: true, id, sequence, generation, changedDurable, changedBinding, provisional,
    ...(frame.bindingId === undefined ? {} : { bindingId: frame.bindingId }),
    migrateSource: (source !== undefined && source.durable === durable && source.bindingId === frame.bindingId)
      || (provisional && source?.bindingId === undefined),
    ...(durable === undefined ? {} : { durable }),
    ...(frame.receipt === undefined ? {} : { receipt: frame.receipt }),
    ...(replacement ? { replacedId } : {}),
  };
}

export function applyLiveIdentity(admission: Extract<LiveAdmission, { readonly accept: true }>): void {
  const { id, durable, bindingId, generation, replacedId, receipt } = admission;
  const currentOwner = durable === undefined ? undefined : owners.get(durable);
  const takesOwnership = durable !== undefined && currentOwner !== id
    && (replacedId !== undefined || currentOwner === undefined || receipt === undefined
      || receipt > (rowWatermarks.get(currentOwner) ?? -1));
  if (receipt !== undefined) {
    for (const touchedId of replacedId === undefined ? [id] : [id, replacedId]) {
      rowWatermarks.set(touchedId, Math.max(rowWatermarks.get(touchedId) ?? -1, receipt));
    }
  }
  // An accepted row can lose ownership arbitration; its durable aliases
  // expire only when the durable actually changes owner.
  for (const [alias, value] of aliases) {
    if ((value.owner === id && value.durable !== durable)
      || (takesOwnership && value.durable === durable && value.owner !== id)) aliases.delete(alias);
  }
  for (const [key, owner] of owners) {
    if ((owner === id && key !== durable) || owner === replacedId) owners.delete(key);
  }
  if (replacedId !== undefined) {
    const source = rows.get(replacedId);
    if (admission.migrateSource) migrateLiveContentRevision(replacedId, id, bindingId);
    rows.set(replacedId, { ...source, generation, removed: true });
    generations.set(replacedId, generation);
    if (admission.provisional && admission.migrateSource && durable !== undefined) {
      aliases.set(replacedId, { owner: id, durable });
    }
  }
  rows.set(id, { generation, removed: false,
    ...(bindingId === undefined ? {} : { bindingId }),
    ...(durable === undefined ? {} : { durable }),
    ...(receipt === undefined ? {} : { receipt }),
  });
  generations.set(id, generation);
  if (durable !== undefined) {
    if (takesOwnership) owners.set(durable, id);
    generations.set(durable, Math.max(generations.get(durable) ?? -1, generation));
  }
  pruneRowWatermarks();
  observeLiveContentRevision(id, bindingId, receipt);
  observeAttachedOverview(admission);
}

export function retireLiveIdentities(ids: readonly string[]): void {
  const retired = new Set(ids);
  for (const id of retired) rows.delete(id);
  for (const [durable, owner] of owners) if (retired.has(owner)) owners.delete(durable);
  for (const [alias, value] of aliases) if (retired.has(value.owner)) aliases.delete(alias);
  pruneRowWatermarks();
}

export function __liveIdentitySnapshotForTests() {
  return {
    rows: Object.fromEntries(rows),
    owners: Object.fromEntries(owners),
    aliases: Object.fromEntries([...aliases].map(([id, value]) => [id, value.owner])),
    generations: Object.fromEntries(generations),
  };
}

export function resetLiveIdentities(): void {
  resetLiveContentRevisions();
  rows = new Map();
  owners = new Map();
  aliases = new Map();
  generations = new Map();
  rowWatermarks = new Map();
  evictionFloor = -1;
}
