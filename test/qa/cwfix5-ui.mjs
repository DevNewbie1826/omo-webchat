/** Disposable HTTP/WS fixture serving the unmodified Vite production build.
 * Run: bun test/qa/cwfix5-ui.mjs [evidence-directory]
 * No backend process, credentials, real transcripts, or persisted user data.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export const sessionId = "qa-restored-chat";
export const model = { provider: "glm-zcode", modelId: "glm-5.3" };
export const models = Array.from({ length: 183 }, (_, i) => i === 178
  ? { ...model, name: "GLM 5.3" }
  : i === 177 ? { provider: "other-provider", modelId: "glm-5.3", name: "GLM 5.3" }
  : { provider: `catalog-${String(Math.floor(i / 20)).padStart(2, "0")}`, modelId: `model-${i}`, name: `Catalog model ${String(i).padStart(3, "0")}` });
export const goal = { status: "active", objective: Array.from({ length: 9 }, (_, i) => `Requirement ${i + 1}: preserve readable conversation and stable, usable panel controls.`).join("\n") };
export const entries = Array.from({ length: 100 }, (_, i) => ({
  id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, type: "message",
  message: { role: i % 2 ? "assistant" : "user", content: `Synthetic QA turn ${i + 1}.\n\n${"This disposable conversation checks restored layout and scrolling. ".repeat(12)}` },
}));
export const activity = { history: { task: { parent_session_id: "qa-durable", truncated_tasks: false,
  tasks: Array.from({ length: 36 }, (_, i) => ({ task_id: `qa-task-${i}`, name: `Completed layout check ${i + 1}`, status: "completed" })) }, dag: null } };
const evidence = resolve(process.argv[2] || "/tmp/cwfix5-ui-evidence");
await mkdir(evidence, { recursive: true });
const dist = resolve(evidence, "dist");
const actions = [];
const traffic = [];
const events = new EventEmitter();
let layout = { kind: "leaf", id: "qa-pane", sessionId };
const chat = { id: sessionId, name: "Restored conversation title", provider: "omo" };
const sockets = new Set();
const server = Bun.serve({
  hostname: "127.0.0.1", port: 25015,
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    traffic.push({ method: req.method, path });
    if (path === "/api/v2/ws" && server.upgrade(req)) return;
    if (path === "/api/auth/check") return new Response(null, { status: 204 });
    if (path === "/api/providers") return Response.json([{ id: "omo", label: "Chat", binary: "fixture", available: true }]);
    if (path === "/api/workspaces") return Response.json([{ id: "qa-workspace", name: "Disposable QA", path: "/qa/disposable", chats: [chat] }]);
    if (path === "/api/sessions/live") return Response.json({ sessions: [sessionId] });
    if (path === "/api/workspaces/qa-workspace/sessions") return Response.json({ items: [{ ...chat, source: "stored", recencyMs: 1788600000000 }], nextCursor: "" });
    if (path.endsWith("/goal")) return Response.json({ goal });
    if (path.endsWith("/activity")) return Response.json(activity);
    if (path === "/api/layout") {
      if (req.method === "PUT") layout = await req.json();
      return Response.json({ layout });
    }
    if (path.startsWith("/api/")) return new Response(`Unexpected fixture request: ${path}`, { status: 404 });
    const file = Bun.file(resolve(dist, path === "/" ? "index.html" : path.slice(1)));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "hello", version: 2, serverVersion: "qa" })); },
    close(ws) { sockets.delete(ws); },
    message(ws, raw) {
      const frame = JSON.parse(String(raw));
      traffic.push({ direction: "client", frame });
      const send = (body) => { traffic.push({ direction: "server", type: body.type }); ws.send(JSON.stringify({ sessionId, ...body })); };
      if (frame.type === "chat.create") {
        send({ type: "ready", resumed: true, piSessionId: "qa-durable" });
        send({ type: "state", isStreaming: false, isCompacting: false, model, thinkingLevel: "high" });
        send({ type: "models", models });
        send({ type: "commands", commands: [] });
        send({ type: "entries", entries, leafId: "entry-99", final: true });
      } else if (frame.type === "chat.stats") send({ type: "stats", cost: 0, contextUsage: { tokens: 150, contextWindow: 200000, percent: 0 } });
      else if (frame.type === "chat.models") send({ type: "models", models });
      else if (frame.type === "chat.set") {
        events.emit("model-command", frame);
        send({ type: "control.result", requestId: frame.requestId, command: "set_model", success: true });
        send({ type: "state", isStreaming: false, isCompacting: false, model: frame.model ?? model, thinkingLevel: frame.thinkingLevel ?? "high" });
      }
    },
  },
});
const browserSession = `cwfix5-ui-${process.pid}`;
async function browser(...args) {
  actions.push({ command: args });
  const result = await new Promise((ok, fail) => {
    const child = spawn("agent-browser", ["--session", browserSession, "--json", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`Browser deadline: ${args[0]}`)); }, 30000);
    child.once("error", fail);
    child.once("exit", code => { clearTimeout(timer); code === 0 ? ok({ stdout, stderr }) : fail(new Error(`${args[0]} exit ${code}: ${stdout} ${stderr}`)); });
  });
  const value = JSON.parse(result.stdout);
  actions.at(-1).result = value;
  if (!value.success) throw new Error(JSON.stringify(value));
  return value.data;
}
async function evaluate(source) { const result = await browser("eval", source); return result.result; }
async function save(name, data) { await writeFile(resolve(evidence, name), JSON.stringify(data, null, 2) + "\n"); }
let failure;
try {
  await browser("--init-script", resolve("test/qa/cwfix5-ui-ready.js"), "open", "about:blank");
  await browser("set", "viewport", "1280", "800");
  await browser("open", "http://127.0.0.1:25015");
  await evaluate("window.qaReady");
  await save("fixture-render.json", await evaluate(`({title:document.querySelector('.th-termhead-name').textContent, messages:document.querySelectorAll('.th-chat-msg').length, activity:!!document.querySelector('.th-activity-shelf'), model:document.querySelector('.th-model-picker-btn').getAttribute('aria-label'), userAgent:navigator.userAgent})`));
  await browser("screenshot", resolve(evidence, "fixture-desktop.png"));
  await browser("click", ".th-activity-shelf .th-activity-bar");
  await browser("focus", ".th-activity-resize");
  await browser("press", "End");
  await save("saved-height.json", await evaluate(`({saved:localStorage.getItem('th-activity-panel-height')})`));
  for (const order of ["activity-goal", "goal-activity", "resize-goal-activity"]) {
    if (order.startsWith("resize")) await browser("set", "viewport", "1280", "860");
    await browser("reload");
    await evaluate("window.qaReady");
    for (const panel of order.replace("resize-", "").split("-")) await browser("click", panel === "goal" ? ".th-goal-bar" : ".th-activity-shelf .th-activity-bar");
    if (order.startsWith("resize")) await browser("set", "viewport", "1280", "800");
    const frames = await evaluate(`new Promise((resolve,reject)=>{ const rows=[]; const timer=setTimeout(()=>reject(new Error('frame deadline')),10000); function sample(t){ const box=s=>document.querySelector(s)?.getBoundingClientRect().toJSON(); rows.push({t,goal:box('.th-goal-panel'),activity:box('.th-activity-panel'),transcript:box('.th-chat-scrollport'),composer:box('.th-chat-input')}); if(rows.length===120){clearTimeout(timer);resolve(rows)}else requestAnimationFrame(sample)} requestAnimationFrame(sample)})`);
    await save(`shelves-red-${order}.json`, frames);
    await browser("screenshot", resolve(evidence, `shelves-red-${order}.png`));
  }
  await evaluate(`window.qaSidebarDone = new Promise((resolve,reject)=>{const sidebar=document.querySelector('.th-sidebar');const timer=setTimeout(()=>reject(new Error('sidebar transition deadline')),5000);sidebar.addEventListener('transitionend',function done(e){if(e.target===sidebar&&e.propertyName==='width'){clearTimeout(timer);sidebar.removeEventListener('transitionend',done);resolve(true)} });}); true`);
  await browser("click", ".th-sidebar-toggle");
  await evaluate("window.qaSidebarDone");
  await save("sidebar-red.json", await evaluate(`(()=>{const title=document.querySelector('.th-termhead-name'),toggle=document.querySelector('.th-sidebar-toggle'),a=title.getBoundingClientRect(),b=toggle.getBoundingClientRect(),hit=document.elementFromPoint(a.left+1,a.top+a.height/2);return {title:a.toJSON(),toggle:b.toJSON(),overlapWidth:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)),overlapArea:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)),hit:hit.outerHTML,intercepted:toggle.contains(hit)}})()`));
  await browser("screenshot", resolve(evidence, "sidebar-red.png"));
  for (const [w,h] of [[375,812],[320,740]]) {
    await browser("set", "viewport", String(w), String(h));
    await browser("reload");
    await evaluate("window.qaReady");
    const before = await evaluate(`(()=>{const e=document.querySelector('.th-model-picker-label');return {text:e.textContent,display:getComputedStyle(e).display,box:e.getBoundingClientRect().toJSON()}})()`);
    await browser("screenshot", resolve(evidence, `model-red-${w}-closed.png`));
    await browser("click", ".th-model-picker-btn");
    const opened = await evaluate(`(()=>{const rows=[...document.querySelectorAll('[role=option]')],current=rows.find(e=>e.querySelector('strong')?.textContent==='GLM 5.3'&&e.querySelector('span')?.textContent==='glm-zcode'),list=document.querySelector('.th-model-picker-list'),popover=document.querySelector('.th-model-picker-popover');return {count:rows.length,index:rows.indexOf(current),currentSelected:current.getAttribute('aria-selected'),current:current.getBoundingClientRect().toJSON(),selected:rows.filter(e=>e.getAttribute('aria-selected')==='true').map(e=>e.textContent),list:list.getBoundingClientRect().toJSON(),scrollTop:list.scrollTop,popover:popover.getBoundingClientRect().toJSON(),focused:document.activeElement.className,viewport:{width:innerWidth,height:innerHeight}}})()`);
    await save(`model-red-${w}.json`, { before, opened });
    await browser("screenshot", resolve(evidence, `model-red-${w}-open.png`));
    await browser("press", "ArrowDown");
    await save(`model-red-${w}-navigation.json`, await evaluate(`({selected:[...document.querySelectorAll('[role=option][aria-selected=true]')].map(e=>e.textContent),trigger:document.querySelector('.th-model-picker-btn').getAttribute('aria-label')})`));
    await browser("fill", ".th-model-picker-search", "glm-zcode");
    // Subscribe to the exact wire command before explicit confirmation.
    const selected = once(events, "model-command", { signal: AbortSignal.timeout(5000) });
    await browser("press", "Enter");
    await save(`model-red-${w}-command.json`, (await selected)[0]);
  }
  if (process.env.QA_EXTENDED === "1") {
    for (const [w,h] of [[1280,300],[320,300]]) {
      await browser("set", "viewport", String(w), String(h));
      await browser("reload");
      await evaluate("window.qaReady");
      await browser("click", ".th-goal-bar");
      await browser("click", ".th-activity-shelf .th-activity-bar");
      await save(`short-${w}.json`, await evaluate(`new Promise((resolve,reject)=>{const rows=[];const timer=setTimeout(()=>reject(new Error('short frame deadline')),10000);function sample(){const box=s=>document.querySelector(s)?.getBoundingClientRect().toJSON();rows.push({goal:box('.th-goal-panel'),activity:box('.th-activity-panel'),composer:box('.th-chat-input'),transcript:box('.th-chat-scrollport'),viewport:innerHeight});if(rows.length===120){clearTimeout(timer);resolve(rows)}else requestAnimationFrame(sample)}requestAnimationFrame(sample)})`));
      await browser("screenshot", resolve(evidence, `short-${w}.png`));
    }
    await browser("set", "viewport", "1280", "800");
    const longObjective = goal.objective;
    goal.objective = "Synthetic short objective";
    await browser("reload");
    await evaluate("window.qaReady");
    await browser("click", ".th-goal-bar");
    await save("short-goal.json", await evaluate(`new Promise((resolve,reject)=>{const rows=[];const timer=setTimeout(()=>reject(new Error('goal frame deadline')),10000);function sample(){const panel=document.querySelector('.th-goal-panel');rows.push({expanded:document.querySelector('.th-goal-bar').getAttribute('aria-expanded'),height:panel?.getBoundingClientRect().height});if(rows.length===120){clearTimeout(timer);resolve(rows)}else requestAnimationFrame(sample)}requestAnimationFrame(sample)})`));
    await browser("screenshot", resolve(evidence, "short-goal.png"));
    goal.objective = longObjective;
    await browser("reload");
    await evaluate("window.qaReady");
    await evaluate(`window.qaSplit = new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(new Error('split deadline'))},5000);const observer=new MutationObserver(()=>{if(document.querySelectorAll('.th-pane-wrap').length===2){clearTimeout(timer);observer.disconnect();resolve(true)}});observer.observe(document.body,{childList:true,subtree:true})});true`);
    await browser("click", ".th-termhead-actions > button:first-child");
    await evaluate("window.qaSplit");
    for (const state of ["expanded","collapsed"]) {
      if (state === "collapsed") {
        await evaluate(`window.qaSidebarDone = new Promise((resolve,reject)=>{const sidebar=document.querySelector('.th-sidebar');const timer=setTimeout(()=>reject(new Error('sidebar deadline')),5000);sidebar.addEventListener('transitionend',function done(e){if(e.target===sidebar&&e.propertyName==='width'){clearTimeout(timer);sidebar.removeEventListener('transitionend',done);resolve(true)}})});true`);
        await browser("click", ".th-sidebar-toggle");
        await evaluate("window.qaSidebarDone");
      }
      await save(`split-${state}.json`, await evaluate(`(()=>{const toggle=document.querySelector('.th-sidebar-toggle'),b=toggle.getBoundingClientRect();return [...document.querySelectorAll('.th-termhead-name')].map(title=>{const a=title.getBoundingClientRect(),hit=document.elementFromPoint(a.left+1,a.top+a.height/2);return {title:a.toJSON(),toggle:b.toJSON(),overlapArea:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)),intercepted:toggle.contains(hit)}})})()`));
      await browser("screenshot", resolve(evidence, `split-${state}.png`));
    }
  }
  await save("browser-errors.json", await browser("errors"));
  await save("browser-console.json", await browser("console"));
} catch (error) { failure = error; await save("failure.json", { error: String(error), stack: error.stack }); }
finally {
  try { await browser("close"); } catch (error) { failure ??= error; }
  for (const ws of sockets) ws.close();
  await server.stop(true);
  await save("actions.json", actions);
  await save("traffic.json", traffic);
  await save("cleanup.json", { browserSession, browserClosed: actions.at(-1)?.result?.success === true, serverStopped: true, pendingWebSockets: server.pendingWebSockets, port: 25015, fixtureInMemoryOnly: true });
}
if (failure) throw failure;
console.log(`Captured browser evidence in ${evidence}`);
