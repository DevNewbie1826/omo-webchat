interface ContentAuthority {
  readonly bindingId: string | undefined;
  readonly revision: number;
}

// Overview receipts and attached content share the server's exposed clock.
// This watermark is independent of arrival ordering and payload-side caches.
const authorities = new Map<string, ContentAuthority>();

export function observeLiveContentRevision(
  id: string, bindingId: string | undefined, revision: number | undefined,
): void {
  const previous = authorities.get(id);
  if (previous !== undefined && previous.bindingId !== bindingId) authorities.delete(id);
  if (revision === undefined) return;
  authorities.set(id, { bindingId, revision: Math.max(
    previous?.bindingId === bindingId ? previous?.revision ?? -1 : -1, revision,
  ) });
}

export function acceptAttachedContentRevision(
  id: string, bindingId: string | undefined, revision: number | undefined,
): boolean {
  const previous = authorities.get(id);
  const known = previous?.bindingId === bindingId ? previous?.revision : undefined;
  if (revision === undefined) return known === undefined;
  // A tie is a replay, not a fresh heartbeat or new count admission.
  if (known !== undefined && revision <= known) return false;
  observeLiveContentRevision(id, bindingId, revision);
  return true;
}

/** Retired rows retain their fence until identity history evicts them. */
export function forgetLiveContentRevision(id: string): number {
  const revision = authorities.get(id)?.revision ?? -1;
  authorities.delete(id);
  return revision;
}

export function migrateLiveContentRevision(from: string, to: string, bindingId: string | undefined): void {
  const source = authorities.get(from);
  if (source !== undefined && source.bindingId === bindingId) {
    observeLiveContentRevision(to, bindingId, source.revision);
  }
}

export function resetLiveContentRevisions(): void {
  authorities.clear();
}
