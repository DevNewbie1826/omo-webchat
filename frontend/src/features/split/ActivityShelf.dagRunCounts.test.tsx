import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nContext } from "../../i18n";
import { parseDagDigest } from "../workspace/activityDigest";
import {
  activityState,
  makeDag,
  mountActivityShelf,
  unmountActivityShelf,
  type ActivityShelfHarness,
} from "./ActivityShelf.support";
import type { ActivityState } from "./activityTypes";
import { parseDagCounts } from "./activityParseDag";
import { applyCountAuthority } from "./taskAuthority";
import { i18n, requireElement } from "./chatPaneTestHarness";
import { ActivityShelf } from "./ActivityShelf";

/** The collapsed DAG tab renders an always-exact "running DAG runs / total
 * DAG runs" pair. Exactness ladder, in order: the server's pre-truncation
 * run-count scalars; the complete retained run list (no truncation marker);
 * nothing at all. No approximate marker may ever appear on the tab. Every
 * case mounts the shelf with the product's dagSource binding, which is the
 * binding the pane always passes. */
describe("ActivityShelf DAG tab run counts", () => {
  let harness: ActivityShelfHarness;

  beforeEach(() => {
    harness = mountActivityShelf();
  });

  afterEach(async () => {
    await unmountActivityShelf(harness);
  });

  const DAG_SOURCE = { wsId: "ws", chatId: "chat", connected: true };

  function renderShelfWithSource(activities: ActivityState): void {
    act(() => {
      harness.root.render(
        <I18nContext.Provider value={i18n}>
          <ActivityShelf activities={activities} dagSource={DAG_SOURCE} />
        </I18nContext.Provider>,
      );
    });
  }

  function dagTab(): HTMLButtonElement {
    return requireElement(
      harness.container.querySelector<HTMLButtonElement>('[data-activity-tab="dag"]'),
      "DAG tab",
    );
  }

  function count(): string | null {
    return dagTab().querySelector(".th-activity-tab-count")?.textContent ?? null;
  }

  /** The DAG tab renders exactly its label plus the exact running/total
   * pair — no other numeric or marker text can appear on the tab. */
  function exactDagSurface(expected: string | null): void {
    expect([...dagTab().querySelectorAll("span")].map(span => span.textContent))
      .toEqual(expected === null ? ["activity.dag"] : ["activity.dag", expected]);
    expect(dagTab().getAttribute("title")).toBeNull();
  }

  it("renders the exact server run-count pair under the product dagSource binding", () => {
    // The retained list disagrees with the scalars on purpose: the exact
    // pre-truncation authority wins over any retained-row reading.
    const state = applyCountAuthority(
      activityState({ dags: [makeDag()] }),
      { dagRunRunningCount: 2, dagRunTotalCount: 5 },
      1_000,
    );
    renderShelfWithSource(state);
    expect(count()).toBe("2/5");
    exactDagSurface("2/5");
  });

  it("renders the scalar pair when truncation retains zero runs", () => {
    const state = applyCountAuthority(
      activityState({ truncatedDags: true }),
      { dagRunRunningCount: 3, dagRunTotalCount: 7 },
      1_000,
    );
    renderShelfWithSource(state);
    expect(count()).toBe("3/7");
    exactDagSurface("3/7");
  });

  it("counts the complete retained run list exactly when no scalars exist", () => {
    renderShelfWithSource(activityState({
      dags: [
        makeDag({ runId: "run-live", status: "running" }),
        makeDag({ runId: "run-done", status: "completed" }),
        makeDag({ runId: "run-failed", status: "failed" }),
        makeDag({ runId: "run-cancelled", status: "cancelled" }),
      ],
      truncatedDags: false,
    }));
    expect(count()).toBe("1/4");
    exactDagSurface("1/4");
  });

  it("renders no count slot when the exact total is zero", () => {
    const scalarZero = applyCountAuthority(
      activityState({ truncatedDags: true }),
      { dagRunRunningCount: 0, dagRunTotalCount: 0 },
      1_000,
    );
    renderShelfWithSource(scalarZero);
    expect(count()).toBeNull();
    exactDagSurface(null);

    // No scalars and no retained runs is equally an empty slot.
    renderShelfWithSource(activityState({ truncatedDags: false }));
    expect(count()).toBeNull();
    exactDagSurface(null);
  });

  it("renders no count slot for a truncated run list without scalars", () => {
    renderShelfWithSource(activityState({ dags: [makeDag()], truncatedDags: true }));
    expect(count()).toBeNull();
    exactDagSurface(null);
  });

  it("fences a late stale delivery from rolling back a newer scalar", () => {
    const base = activityState({ truncatedDags: true });
    const newer = applyCountAuthority(base, { dagRunRunningCount: 4, dagRunTotalCount: 9 }, 2_000);
    renderShelfWithSource(newer);
    expect(count()).toBe("4/9");

    // A count-only frame parsed at the wire boundary carries the run pair;
    // delivered with an older admission clock it must not move the tab.
    const staleCounts = parseDagCounts({ run_running_count: 1, run_total_count: 2 });
    expect(staleCounts).toEqual({ dagRunRunningCount: 1, dagRunTotalCount: 2 });
    const stale = applyCountAuthority(newer, staleCounts!, 1_000);
    expect(stale).toBe(newer);
    renderShelfWithSource(stale);
    expect(count()).toBe("4/9");
    exactDagSurface("4/9");

    // A genuinely newer delivery still advances the same scalars.
    const advanced = applyCountAuthority(newer, { dagRunRunningCount: 5, dagRunTotalCount: 9 }, 3_000);
    renderShelfWithSource(advanced);
    expect(count()).toBe("5/9");
    exactDagSurface("5/9");
  });

  it("parses the REST digest run-count scalars for hydration", () => {
    const digest = parseDagDigest({
      runs: [],
      truncated: true,
      run_running_count: 6,
      run_total_count: 11,
    });
    expect(digest?.dagRunRunningCount).toBe(6);
    expect(digest?.dagRunTotalCount).toBe(11);
  });
});
