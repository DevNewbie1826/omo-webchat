import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { I18nContext, translate, type I18nValue } from "../src/i18n";
import { ActivityShelf } from "../src/features/split/ActivityShelf";
import type {
  ActivityDagCounts,
  ActivityDagNode,
  ActivityDagRun,
  ActivityDagWave,
  ActivityState,
} from "../src/features/split/activityTypes";
import "../src/fonts/pretendard/pretendardvariable-dynamic-subset.css";
import "../src/styles/tokens.css";
import "../src/styles/global.css";
import "../src/styles/chat-pane.css";
import "../src/styles/activity-shelf.css";

/** Realistic English, repeated. The live run's prompts are 5–10K chars and
 *  unlabeled; only the strings are synthetic. Lengths and topology are the
 *  run's. */
const SENTENCE =
  "Review the cold history loader for the v4 hydration path, confirm the recovery server replays every retained frame before the client transport resumes, and keep the parse cache warm while the ws bridge drains its liveness queue without dropping acked entries. ";

function promptOf(length: number): string {
  return SENTENCE.repeat(Math.ceil(length / SENTENCE.length)).slice(0, length);
}

/** nodes[].id, nodes[].state, nodes[].dependsOn from
 *  dag_d5989db7-b0fc-4310-af0c-87cc4960095a, in run order. */
const FIXTURE: readonly {
  readonly id: string;
  readonly state: string;
  readonly dependsOn: readonly string[];
  readonly promptLength: number;
}[] = [
  { id: "contract", state: "completed", dependsOn: [], promptLength: 5_147 },
  { id: "coldhistory", state: "completed", dependsOn: [], promptLength: 6_047 },
  { id: "recovery-server", state: "completed", dependsOn: [], promptLength: 10_185 },
  { id: "hydrate-v4", state: "completed", dependsOn: ["coldhistory", "recovery-server"], promptLength: 7_076 },
  { id: "wsbridge-v4", state: "running", dependsOn: ["contract", "hydrate-v4"], promptLength: 5_995 },
  { id: "rest-history", state: "completed", dependsOn: ["coldhistory", "hydrate-v4"], promptLength: 6_159 },
  { id: "ws-liveness", state: "completed", dependsOn: [], promptLength: 5_481 },
  { id: "parse-cache", state: "completed", dependsOn: [], promptLength: 5_798 },
  { id: "client-transport", state: "completed", dependsOn: ["contract"], promptLength: 5_577 },
  { id: "client-history", state: "completed", dependsOn: ["client-transport"], promptLength: 9_569 },
  { id: "client-view", state: "completed", dependsOn: ["client-history", "parse-cache"], promptLength: 7_041 },
  { id: "docs", state: "completed", dependsOn: ["contract"], promptLength: 5_356 },
  {
    id: "verify-suites",
    state: "completed",
    dependsOn: ["wsbridge-v4", "rest-history", "ws-liveness", "client-view", "docs", "recovery-server"],
    promptLength: 5_576,
  },
  {
    id: "verify-live",
    state: "running",
    dependsOn: ["wsbridge-v4", "rest-history", "ws-liveness", "client-view", "docs", "recovery-server"],
    promptLength: 7_373,
  },
  { id: "pr", state: "pending", dependsOn: ["verify-suites", "verify-live"], promptLength: 5_302 },
  { id: "review", state: "pending", dependsOn: ["pr"], promptLength: 5_414 },
];

const WAVES: readonly ActivityDagWave[] = [
  { index: 0, nodeIds: ["contract", "coldhistory", "recovery-server", "ws-liveness", "parse-cache"] },
  { index: 1, nodeIds: ["hydrate-v4", "client-transport", "docs"] },
  { index: 2, nodeIds: ["wsbridge-v4", "rest-history", "client-history"] },
  { index: 3, nodeIds: ["client-view"] },
  { index: 4, nodeIds: ["verify-suites", "verify-live"] },
  { index: 5, nodeIds: ["pr"] },
  { index: 6, nodeIds: ["review"] },
];

function countsOf(nodes: readonly ActivityDagNode[]): ActivityDagCounts {
  const counts = {
    total: nodes.length,
    pending: 0,
    blocked: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const node of nodes) {
    if (node.state === "pending") counts.pending += 1;
    else if (node.state === "blocked") counts.blocked += 1;
    else if (node.state === "scheduled") counts.scheduled += 1;
    else if (node.state === "running") counts.running += 1;
    else if (node.state === "completed") counts.completed += 1;
    else if (node.state === "failed") counts.failed += 1;
    else if (node.state === "cancelled") counts.cancelled += 1;
    else if (node.state === "skipped") counts.skipped += 1;
  }
  return counts;
}

const nodes: readonly ActivityDagNode[] = FIXTURE.map((node) => ({
  id: node.id,
  state: node.state,
  dependsOn: node.dependsOn,
  prompt: promptOf(node.promptLength),
}));

const run: ActivityDagRun = {
  runId: "dag_d5989db7-b0fc-4310-af0c-87cc4960095a",
  runKey: "hist-ondemand-r1",
  name: "On-demand history v4 + recovery hardening",
  status: "running",
  counts: countsOf(nodes),
  nodes,
  edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))),
  waves: WAVES,
};

const activities: ActivityState = {
  tasks: new Map(),
  dags: new Map([[run.runId, run]]),
  todo: null,
  heartbeats: new Map(),
};

const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => translate("en", key, vars),
};

interface QaSnapshot {
  mountMs: number;
  titles: string[];
  maxTextLen: number;
}

declare global {
  interface Window {
    __qa?: QaSnapshot;
  }
}

const longest = nodes.reduce((best, node) => (node.prompt.length > best.prompt.length ? node : best));
document.documentElement.dataset.promptPrefix = longest.prompt.slice(0, 60);
document.documentElement.dataset.promptLength = String(longest.prompt.length);
document.documentElement.style.setProperty("--th-font-size", "13px");

function publish(): void {
  const titles = [...document.querySelectorAll("[data-node]")].map((card) =>
    [...card.querySelectorAll(".th-activity-glabel")].map((line) => line.textContent ?? "").join(""),
  );
  let maxTextLen = 0;
  for (const node of document.querySelectorAll("text")) {
    maxTextLen = Math.max(maxTextLen, (node.textContent ?? "").length);
  }
  window.__qa = { mountMs: performance.now(), titles, maxTextLen };
  document.documentElement.dataset.settled = "1";
}

function Harness() {
  useEffect(() => {
    document.querySelector<HTMLButtonElement>('[data-activity-tab="dag"]')?.click();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void document.fonts.ready.then(publish);
      });
    });
  }, []);

  return (
    <>
      <ActivityShelf activities={activities} />
      <ol data-qa-ids hidden>
        {FIXTURE.map((node) => <li key={node.id}>{node.id}</li>)}
      </ol>
    </>
  );
}

const root = document.getElementById("root");
if (root === null) {
  document.documentElement.dataset.settled = "error";
  document.documentElement.dataset.error = "missing #root";
} else {
  window.addEventListener("error", (event) => {
    document.documentElement.dataset.error = event.message;
    if (document.documentElement.dataset.settled !== "1") {
      document.documentElement.dataset.settled = "error";
    }
  });
  createRoot(root).render(
    <I18nContext.Provider value={i18n}>
      <Harness />
    </I18nContext.Provider>,
  );
}
