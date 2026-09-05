/** Machine-only RED evidence validation; intentionally fails on a repaired UI. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = process.argv[2] || "/tmp/cwfix5-ui-evidence";
async function read(name) { return JSON.parse(await readFile(resolve(directory, name), "utf8")); }
const saved = await read("saved-height.json");
assert.equal(saved.saved, "480");
const frames = await read("shelves-red-resize-goal-activity.json");
assert.equal(frames.length, 120);
const geometry = frames.map(f => [f.goal.height, f.activity.height, f.transcript.height]);
for (let i = 2; i < geometry.length; i++) assert.deepEqual(geometry[i], geometry[i - 2]);
assert.notDeepEqual(geometry[0], geometry[1]);
assert.ok(Math.min(...geometry.map(row => row[2])) < 120);
const sidebar = await read("sidebar-red.json");
assert.ok(sidebar.overlapArea > 0);
assert.equal(sidebar.intercepted, true);
for (const width of [375, 320]) {
  const { before, opened } = await read(`model-red-${width}.json`);
  assert.equal(before.display, "none");
  assert.equal(before.box.height, 0);
  assert.equal(opened.count, 183);
  assert.equal(opened.index, 178);
  assert.equal(opened.currentSelected, "false");
  assert.ok(opened.current.top > opened.list.bottom);
  assert.equal(opened.scrollTop, 0);
  assert.equal(opened.selected.length, 1);
  const command = await read(`model-red-${width}-command.json`);
  assert.equal(command.type, "chat.set");
  assert.deepEqual(command.model, { provider: "glm-zcode", modelId: "glm-5.3" });
}
const traffic = await read("traffic.json");
assert.equal(traffic.filter(row => row.frame?.type === "chat.set").length, 2);
assert.deepEqual((await read("browser-errors.json")).errors, []);
assert.deepEqual((await read("browser-console.json")).messages, []);
const cleanup = await read("cleanup.json");
assert.equal(cleanup.browserClosed, true);
assert.equal(cleanup.serverStopped, true);
assert.equal(cleanup.pendingWebSockets, 0);
console.log("RED confirmed: shelf two-cycle, desktop title occlusion, narrow model invisibility/false selection; fixture and cleanup checks passed.");
