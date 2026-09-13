import type { SessionsActivityFrame } from "../../lib/contract/types_gen";
import { canonicalLiveSessionId, retireLiveTaskSessions, settleLiveBadgePush } from "./liveBadgeStore";
import { acceptLeanSession, parseLeanSessionFields } from "./useLiveSessionsLean";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

/** Membership and server-revision authority for the two lean live transports. */
export class LiveSessionMembership {
  private readonly accepted = new Map<string, LiveSessionInfo>();
  private readonly pushed = new Map<string, number>();
  // Receipt provenance outlives the request-sequence membership fence: even a
  // later poll cannot overwrite a tied push from a compatible older server.
  private readonly pushedReceipts = new Map<string, number>();
  // Disconnect withdraws push authority for main activity only, not child scalars.
  private readonly disconnected = new Map<string, number>();
  private readonly activeArrivals = new Map<string, number>();
  private readonly closed = new Map<string, number>();
  private polled = new Set<string>();

  values(): readonly LiveSessionInfo[] {
    return [...this.accepted.values()]
      .sort((a, b) => (b.lean?.last_activity_ms ?? 0) - (a.lean?.last_activity_ms ?? 0));
  }

  poll(next: readonly LiveSessionInfo[], sequence: number): void {
    const live = new Set<string>();
    for (const row of next) {
      const id = canonicalLiveSessionId(row.id);
      live.add(id);
      const previous = this.accepted.get(id);
      const pushedReceipt = this.pushedReceipts.get(id);
      if (pushedReceipt !== undefined && row.lean?.last_activity_ms === pushedReceipt) {
        const disconnectedAt = this.disconnected.get(id);
        if (previous !== undefined && previous.lean?.last_activity_ms === pushedReceipt
          && disconnectedAt !== undefined && sequence > disconnectedAt && row.active !== undefined) {
          // A fresh fallback request can recover locally cleared main activity.
          // The tied push still owns child counts and all other server fields.
          this.accepted.set(id, { ...previous, active: row.active });
        }
        continue;
      }
      const closedDuringRequest = (this.closed.get(id) ?? -1) > sequence;
      const pushedDuringRequest = (this.activeArrivals.get(id) ?? -1) > sequence
        && row.lean?.last_activity_ms === undefined;
      const active = closedDuringRequest ? false
        : pushedDuringRequest ? previous?.active : row.active ?? previous?.active;
      this.accepted.set(id, acceptLeanSession(previous, { ...row, id,
        ...(active === undefined ? {} : { active }),
      }));
    }
    this.polled = live;
    const retired: string[] = [];
    for (const id of this.accepted.keys()) {
      if (live.has(id)) {
        if ((this.pushed.get(id) ?? -1) <= sequence) this.pushed.delete(id);
        continue;
      }
      if ((this.pushed.get(id) ?? -1) > sequence) continue;
      this.accepted.delete(id);
      this.pushed.delete(id);
      this.pushedReceipts.delete(id);
      this.disconnected.delete(id);
      this.activeArrivals.delete(id);
      this.closed.delete(id);
      retired.push(id);
    }
    retireLiveTaskSessions(retired);
  }

  push(frame: SessionsActivityFrame, sequence: number): void {
    // Tombstones are an internal lifecycle extension, not a public wire field.
    if ("tombstone" in frame && frame.tombstone === true) {
      if (canonicalLiveSessionId(frame.sessionId) === frame.sessionId) this.clear(frame.sessionId, sequence);
      return;
    }
    const id = canonicalLiveSessionId(frame.sessionId);
    const sourceIds = [...new Set([frame.replacesSessionId, frame.durableSessionId]
      .filter((source): source is string => source !== undefined && source !== id))];
    for (const sourceId of sourceIds) {
      const source = this.accepted.get(sourceId);
      if (source !== undefined) {
        const target = this.accepted.get(id);
        this.accepted.set(id, acceptLeanSession(target, { ...source, id,
          ...(source.active === undefined && target?.active !== undefined ? { active: target.active } : {}),
        }));
        this.accepted.delete(sourceId);
      }
      if (this.polled.delete(sourceId)) this.polled.add(id);
      for (const arrivals of [this.pushed, this.pushedReceipts, this.disconnected, this.activeArrivals, this.closed]) {
        const at = arrivals.get(sourceId);
        if (at !== undefined) arrivals.set(id, Math.max(at, arrivals.get(id) ?? -1));
        arrivals.delete(sourceId);
      }
    }
    settleLiveBadgePush(id, sourceIds, false, false, sequence);
    const previous = this.accepted.get(id);
    const lean = parseLeanSessionFields(frame) ?? {};
    const knownAt = previous?.lean?.last_activity_ms;
    if (knownAt !== undefined && (lean.last_activity_ms === undefined || lean.last_activity_ms < knownAt)) return;
    this.accepted.set(id, acceptLeanSession(previous, {
      id, title: frame.title ?? previous?.title ?? "", task: null, dag: null, lean,
      ...(frame.active === undefined
        ? previous?.active === undefined ? {} : { active: previous.active }
        : { active: frame.active }),
    }));
    this.disconnected.delete(id);
    this.pushed.delete(id);
    this.pushed.set(id, sequence);
    if (lean.last_activity_ms !== undefined) this.pushedReceipts.set(id, lean.last_activity_ms);
    if (frame.active !== undefined) this.activeArrivals.set(id, sequence);
    while (this.pushed.size > 256) {
      const oldest = this.pushed.keys().next().value;
      if (oldest === undefined) break;
      this.pushed.delete(oldest);
      if (!this.polled.has(oldest)) {
        this.accepted.delete(oldest);
        this.pushedReceipts.delete(oldest);
      }
      this.disconnected.delete(oldest);
      this.activeArrivals.delete(oldest);
      this.closed.delete(oldest);
      retireLiveTaskSessions([oldest]);
    }
  }

  clear(id: string, sequence: number): void {
    const canonical = canonicalLiveSessionId(id);
    const previous = this.accepted.get(canonical);
    if (previous === undefined) return;
    this.disconnected.delete(canonical);
    this.closed.set(canonical, sequence);
    this.activeArrivals.set(canonical, sequence);
    this.pushed.delete(canonical);
    if (this.polled.has(canonical)) this.accepted.set(canonical, { ...previous, active: false });
    else {
      this.accepted.delete(canonical);
      this.pushedReceipts.delete(canonical);
    }
  }

  disconnect(sequence: number): void {
    for (const [id, previous] of this.accepted) {
      this.accepted.set(id, { ...previous, active: false });
      this.disconnected.set(id, sequence);
      this.closed.set(id, sequence);
      this.activeArrivals.set(id, sequence);
    }
  }

  reset(): void {
    retireLiveTaskSessions([...this.accepted.keys()]);
    this.accepted.clear();
    this.pushed.clear();
    this.pushedReceipts.clear();
    this.disconnected.clear();
    this.activeArrivals.clear();
    this.closed.clear();
    this.polled.clear();
  }
}
