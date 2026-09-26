import type { SessionsActivityFrame } from "../../lib/chatWs";
import { hasProvisionalLiveData, resetLiveBadgeState, retireLiveTaskSessions, settleLiveBadgePoll, settleLiveBadgePush } from "./liveBadgeStore";
import { admitCurrentLiveFrame, applyLiveIdentity, canonicalLiveSessionId, liveDurableOwner } from "./liveSessionIdentity";
import { acceptLeanSession, parseLeanSessionFields } from "./useLiveSessionsLean";
import type { LiveSessionInfo } from "./useLiveSessionsLean";

/** Membership and server-revision authority for the two lean live transports. */
export class LiveSessionMembership {
  private readonly accepted = new Map<string, LiveSessionInfo>();
  // Pending REST omission fences are membership provenance, not an evictable
  // push cache: a resident row keeps its arrival until REST acknowledges it.
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
      const id = row.id;
      live.add(id);
      const admission = admitCurrentLiveFrame({
        kind: "poll", chatId: id, requestSequence: sequence,
        ...(row.durableSessionId === undefined ? {} : { durableId: row.durableSessionId }),
        ...(row.bindingId === undefined ? {} : { bindingId: row.bindingId }),
        ...(row.lean?.last_activity_ms === undefined ? {} : { receipt: row.lean.last_activity_ms }),
      });
      if (!admission.accept) continue;
      if (admission.changedDurable || admission.changedBinding) retireLiveTaskSessions([id]);
      if (row.task !== null || row.dag !== null
        || row.taskDigest !== undefined || row.dagDigest !== undefined) settleLiveBadgePoll([row], sequence);
      const previous = this.accepted.get(id);
      const pushedReceipt = this.pushedReceipts.get(id);
      if (!admission.changedDurable && !admission.changedBinding && pushedReceipt !== undefined && row.lean?.last_activity_ms === pushedReceipt) {
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
      const accepted = acceptLeanSession(admission.changedDurable || admission.changedBinding ? undefined : previous, { ...row, id,
        ...(admission.durable === undefined ? {} : { durableSessionId: admission.durable }),
        ...(active === undefined ? {} : { active }),
      });
      this.accepted.set(id, accepted);
      if (accepted !== previous) applyLiveIdentity(admission);
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
    const id = frame.sessionId;
    const lean = parseLeanSessionFields(frame) ?? {};
    const durable = frame.durableSessionId;
    const provisional = durable === undefined ? undefined : this.accepted.get(durable);
    // A first publication can discover provisional attached-socket data even
    // when the overview missed the durable-keyed row.
    const inferredSource = durable !== undefined && durable !== id
      && (liveDurableOwner(durable) === undefined || liveDurableOwner(durable) === durable)
      && ((provisional !== undefined && (provisional.durableSessionId ?? durable) === durable)
        || (provisional === undefined && hasProvisionalLiveData(durable))) ? durable : undefined;
    const replacedId = frame.replacesSessionId ?? inferredSource;
    const admission = admitCurrentLiveFrame({ kind: "push", chatId: id, sequence,
      ...(durable === undefined ? {} : { durableId: durable }),
      ...(frame.bindingId === undefined ? {} : { bindingId: frame.bindingId }),
      ...(replacedId === undefined ? {} : { replacedId }),
      ...(lean.last_activity_ms === undefined ? {} : { receipt: lean.last_activity_ms }),
    });
    if (!admission.accept) return;
    const source = replacedId === undefined ? undefined : this.accepted.get(replacedId);
    const previous = this.accepted.get(id);
    // Admission already compared the replacement revision against both its
    // destination and source; keep the destination's prior row only if its
    // durable is unchanged.
    const retained = admission.changedDurable || admission.changedBinding ? undefined : previous;
    if (replacedId !== undefined && replacedId !== id) {
      this.accepted.delete(replacedId);
      if (this.polled.delete(replacedId)) this.polled.add(id);
      for (const arrivals of [this.pushed, this.pushedReceipts, this.disconnected, this.activeArrivals, this.closed]) {
        arrivals.delete(replacedId);
      }
      if (!admission.migrateSource) retireLiveTaskSessions([replacedId]);
    }
    if (admission.changedDurable || admission.changedBinding) retireLiveTaskSessions([id]);
    applyLiveIdentity(admission);
    settleLiveBadgePush(id, admission.replacedId === undefined || !admission.migrateSource
      ? [] : [admission.replacedId], false, false, sequence);
    const migratedSource = admission.migrateSource ? source : undefined;
    const active = frame.active ?? retained?.active ?? migratedSource?.active;
    const incoming: LiveSessionInfo = {
      id, title: frame.title ?? retained?.title ?? migratedSource?.title ?? "", task: null, dag: null, lean,
      ...(admission.durable === undefined ? {} : { durableSessionId: admission.durable }),
      ...(admission.bindingId === undefined ? {} : { bindingId: admission.bindingId }),
      ...(active === undefined ? {} : { active }),
    };
    this.accepted.set(id, acceptLeanSession(retained, incoming));
    this.disconnected.delete(id);
    this.pushed.delete(id);
    this.pushed.set(id, sequence);
    if (lean.last_activity_ms !== undefined) this.pushedReceipts.set(id, lean.last_activity_ms);
    if (frame.active !== undefined) this.activeArrivals.set(id, sequence);
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
    resetLiveBadgeState();
    this.accepted.clear();
    this.pushed.clear();
    this.pushedReceipts.clear();
    this.disconnected.clear();
    this.activeArrivals.clear();
    this.closed.clear();
    this.polled.clear();
  }
}
