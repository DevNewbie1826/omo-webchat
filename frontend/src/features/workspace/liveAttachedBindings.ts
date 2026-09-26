export interface AttachedBadgeProvenance {
  readonly attemptToken: object;
  readonly instanceId: string | undefined;
  readonly connection: number;
  readonly currentConnection: number;
  readonly bindingId: string | undefined;
  readonly durableSessionId: string | undefined;
}

interface AttachedSource {
  sessionId: string;
  readonly provenance: AttachedBadgeProvenance;
  status: "pending" | "accepted" | "retired";
}

interface OverviewBinding {
  readonly bindingId?: string;
}

// Entries live only as long as their attached hook; a route change releases
// its attempt explicitly. A ready is a claim, not evidence of freshness.
const sources = new Map<object, AttachedSource>();

export function bindAttachedSource(
  sessionId: string, provenance: AttachedBadgeProvenance, overview: OverviewBinding | undefined,
): void {
  const previous = sources.get(provenance.attemptToken);
  if (previous !== undefined && previous.provenance.bindingId === provenance.bindingId
    && previous.provenance.connection === provenance.connection) return;
  sources.set(provenance.attemptToken, {
    sessionId, provenance,
    status: provenance.bindingId !== undefined && provenance.bindingId === overview?.bindingId
      ? "accepted" : "pending",
  });
}

export function releaseAttachedBadgeSource(attemptToken: object): void {
  sources.delete(attemptToken);
}

/** Called only after overview revision/identity admission, including REST.
 * A matching incarnation promotes a pending ready without replaying events;
 * after matching, a newer different publication retires it. Until that first
 * match, even a higher revision can be queued activity from the old binding:
 * receiving ready establishes no cross-stream ordering. */
export function observeAttachedOverview(
  row: OverviewBinding & { readonly id: string; readonly replacedId?: string; readonly provisional: boolean;
    readonly migrateSource: boolean },
): void {
  for (const source of sources.values()) {
    if (source.sessionId === row.replacedId && row.provisional && row.migrateSource) source.sessionId = row.id;
    if (source.sessionId !== row.id || source.status === "retired") continue;
    if (source.provenance.bindingId !== undefined && source.provenance.bindingId === row.bindingId) {
      source.status = "accepted";
    } else if (source.status === "accepted") {
      source.status = "retired";
    }
  }
}

export function admitsAttachedBinding(provenance: AttachedBadgeProvenance, bindingId: string | undefined): boolean {
  const source = sources.get(provenance.attemptToken);
  return source?.status === "accepted"
    && bindingId !== undefined && provenance.bindingId === bindingId
    && source.provenance.bindingId === bindingId
    && source.provenance.instanceId === provenance.instanceId
    && source.provenance.connection === provenance.connection;
}

export function resetAttachedSourcesForTests(): void {
  sources.clear();
}
