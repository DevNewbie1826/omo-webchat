/** Validate the same real-browser observations as RED, with repaired behavior. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = process.argv[2] || "/tmp/cwfix5-ui-evidence/green";
async function read(name) { return JSON.parse(await readFile(resolve(directory, name), "utf8")); }
assert.equal((await read("saved-height.json")).saved, "480");
for (const order of ["resize-goal-activity", "activity-goal", "goal-activity"]) {
  const frames = await read(`shelves-red-${order}.json`);
  assert.equal(frames.length, 120);
  const geometry = frames.map(f => [f.goal?.height, f.activity?.height, f.transcript.height]);
  for (const row of geometry) assert.deepEqual(row, geometry[0]);
  for (const frame of frames) {
    assert.ok(frame.transcript.height >= 119.9);
    assert.ok(frame.goal && frame.activity);
    assert.ok(frame.goal.bottom <= frame.activity.top);
    assert.ok(frame.activity.bottom <= frame.composer.top);
    assert.ok(frame.composer.bottom <= 800);
  }
}
const sidebar = await read("sidebar-red.json");
assert.equal(sidebar.overlapArea, 0);
assert.equal(sidebar.intercepted, false);
for (const width of [375, 320]) {
  const { before, opened: o } = await read(`model-red-${width}.json`);
  assert.ok(before.box.height > 0 && before.box.width > 0);
  assert.equal(o.currentSelected, "true");
  assert.equal(o.selected.length, 1);
  assert.ok(o.selected[0].includes("glm-zcode"));
  assert.ok(o.current.top >= o.list.top && o.current.bottom <= o.list.bottom);
  assert.ok(!o.focused.includes("search"));
  assert.ok(o.popover.left >= 0 && o.popover.right <= width);
  assert.ok(o.popover.top >= 0 && o.popover.bottom <= o.viewport.height);
  const navigation = await read(`model-red-${width}-navigation.json`);
  assert.deepEqual(navigation.selected, o.selected);
  const command = await read(`model-red-${width}-command.json`);
  assert.equal(command.type, "chat.set");
  assert.deepEqual(command.model, { provider: "glm-zcode", modelId: "glm-5.3" });
}
for (const width of [1280, 320]) {
  const frames = await read(`short-${width}.json`);
  assert.equal(frames.length, 120);
  for (const frame of frames) {
    assert.equal(frame.goal, undefined);
    assert.equal(frame.activity, undefined);
    assert.ok(frame.transcript.height >= 0);
    assert.ok(frame.composer.top >= frame.transcript.bottom);
    assert.ok(frame.composer.bottom <= frame.viewport);
  }
}
const shortGoal = await read("short-goal.json");
assert.equal(shortGoal.length, 120);
for (const frame of shortGoal) { assert.equal(frame.expanded, "true"); assert.ok(frame.height > 0); }
for (const state of ["collapsed", "expanded"]) {
  const titles = await read(`split-${state}.json`);
  assert.ok(titles.length > 0);
  for (const title of titles) { assert.equal(title.overlapArea, 0); assert.equal(title.intercepted, false); }
}
assert.equal((await read("traffic.json")).filter(row => row.frame?.type === "chat.set").length, 2);
assert.deepEqual((await read("browser-errors.json")).errors, []);
assert.deepEqual((await read("browser-console.json")).messages, []);
const cleanup = await read("cleanup.json");
assert.equal(cleanup.browserClosed, true);
assert.equal(cleanup.serverStopped, true);
assert.equal(cleanup.pendingWebSockets, 0);
console.log("GREEN: stable shelves in both orders/resize, unobstructed single/split titles, named mobile model with truthful selection and no search autofocus, short-height composer contained; cleanup passed.");
