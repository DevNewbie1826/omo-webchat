/** Built Go server + deterministic Unix RPC daemon + native Chrome loss QA.
 * QA_PLAYWRIGHT points at playwright-core/index.mjs. No product code is changed.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { observeSockets } from './heartbeat-liveness.mjs';
import { summaryInput } from './dag-summary-fixture.mjs';
const repo = resolve(import.meta.dir, '../..');
const evidence = resolve(repo, '.omo/qa/rpc-loss');
const url = 'http://127.0.0.1:25362', controlURL = 'http://127.0.0.1:25372';
const report = { startedAt: new Date().toISOString(), scenarios: [], cleanup: [] };
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(resolve(tmpdir(), 'rpc-loss-'));
const tasks = [];
let browser, context, page, observed;
const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + '\n');
function child(command, args, ready, env = process.env) {
 const p = spawn(command, args, { cwd: repo, env, stdio: ['ignore','pipe','pipe'] });
 let output = '';
 const closed = new Promise((done, fail) => { p.once('error', fail); p.once('close', (code, signal) => done({code, signal})); });
 closed.catch(() => {});
 const started = new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error(`readiness: ${command}\n${output}`)),30000);
  for (const stream of [p.stdout,p.stderr]) stream.on('data', b => { output += b; if (output.includes(ready)) { clearTimeout(timer); done(); } });
  closed.then(r => { clearTimeout(timer); fail(new Error(`early exit ${JSON.stringify(r)} ${output}`)); });
 });
 started.catch(() => {});
 const task = {p,closed,started,output:()=>output}; tasks.push(task); return task;
}
async function control(route, data) {
 const r = await fetch(controlURL + route, { method: data === undefined ? 'GET':'POST', ...(data === undefined ? {} : {body:JSON.stringify(data)}), signal:AbortSignal.timeout(20000) });
 const raw = await r.text(); assert.ok(r.ok, `${route}: ${r.status} ${raw}`); return JSON.parse(raw);
}
async function api(route, method='GET', data) {
 const r = await context.request.fetch(url+route,{method,...(data === undefined ? {} : {data})});
 const raw=await r.text();assert.ok(r.ok(),`${route}: ${r.status()} ${raw}`); return raw ? JSON.parse(raw) : null;
}
const frame = (type,id) => row => row.direction === 'received' && row.frame?.type === type && row.frame.sessionId === id;
const wait = (type,id,after=observed.mark()) => observed.wait(frame(type,id),{after,timeout:15000,label:`${type} ${id}`});
async function dom(predicate) {
 await page.evaluate(source => {
  const check = (0,eval)(`(${source})`);
  window.qaDOM = new Promise((done,fail)=>{
   const observer = new MutationObserver(test);
   const timer=setTimeout(()=>{observer.disconnect();fail(new Error('DOM deadline: '+source));},10000);
   function test(){if(check()){clearTimeout(timer);observer.disconnect();done(true);}}
   observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});test();
  }); window.qaDOM.catch(()=>{});
 },String(predicate));
}
const doneDOM=()=>page.evaluate(()=>window.qaDOM);
async function capture(name) {
 await page.screenshot({path:resolve(evidence,name+'.png'),fullPage:false});
 const ui = await page.evaluate(()=>({text:document.body.innerText, recovery:[...document.querySelectorAll('[data-recovery-phase]')].map(e=>({phase:e.dataset.recoveryPhase,role:e.getAttribute('role'),class:e.className,text:e.textContent,color:getComputedStyle(e).color})),errors:[...document.querySelectorAll('.th-chat-error')].map(e=>({text:e.textContent,role:e.getAttribute('role')}))}));
 await save(name+'-ui.json',ui); return ui;
}
async function scenario(name, run) {
 const from=observed.mark(); const before=await control('/state');
 const result={name,from,status:'FAIL'};
 try { Object.assign(result,await run(before,from));result.status='PASS'; }
 catch(error){result.error=String(error.stack??error);}
 result.ui=await capture(name); result.after=await control('/state');
 await save(name+'-requests.json',{before,after:result.after,frames:observed.timeline.filter(r=>r.sequence>from)});
 report.scenarios.push(result);await save('report.json',report);
 console.log(`${name}: ${result.status}${result.error?' '+result.error.split('\n')[0]:''}`);
}
try {
 const build=spawnSync('make',['build'],{cwd:repo,encoding:'utf8'});
 await writeFile(resolve(evidence,'make-build.log'),build.stdout+build.stderr);assert.equal(build.status,0,'make build');
 const compile=spawnSync('go',['build','-o',resolve(root,'fixture'),'test/qa/rpc-loss-fixture.go'],{cwd:repo,encoding:'utf8'});
 await writeFile(resolve(evidence,'fixture-build.log'),compile.stdout+compile.stderr);assert.equal(compile.status,0,'fixture build');
 const fixture=child(resolve(root,'fixture'),['--root',root],'RPC_LOSS_FIXTURE_READY');await fixture.started;
 const env={HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR??'/tmp',OMO_CODING_AGENT_DIR:resolve(root,'agent')};
 const app=child(resolve(repo,'bin/omo-webchat'),['--state-dir',resolve(root,'state'),'--root',root,'--password','rpc-loss-qa-only','--port','25362'],'msg=listening',env);await app.started;
 const {chromium}=await import(pathToFileURL(process.env.QA_PLAYWRIGHT??resolve(evidence,'tools/node_modules/playwright-core/index.mjs')).href);
 browser=await chromium.launch({channel:'chrome',headless:true});
 context=await browser.newContext({viewport:{width:1400,height:900}});context.setDefaultTimeout(15000);
 await context.addInitScript(()=>localStorage.setItem('th-lang','en'));
 page=await context.newPage();observed=observeSockets(page);
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.locator('#th-password').fill('rpc-loss-qa-only');
 const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
 await page.locator('.th-login button[type=submit]').click();assert.ok((await login).ok());
 const ws=await api('/api/workspaces','POST',{name:'RPC loss QA',path:resolve(root,'workspace')});
 const chats=[];
 for(const name of ['A','B']) chats.push(await api(`/api/workspaces/${ws.id}/chats`,'POST',{name:`Recovery ${name}`,provider:'omo'}));
 await page.goto('about:blank');
 await api('/api/layout','PUT',{kind:'split',id:'loss-root',dir:'h',ratio:0.5,first:{kind:'leaf',id:'loss-A',sessionId:chats[0].id},second:{kind:'leaf',id:'loss-B',sessionId:chats[1].id}});
 const initial=chats.map(c=>wait('ready',c.id));await page.goto(url,{waitUntil:'domcontentloaded'});await Promise.all(initial);
 await dom(()=>document.querySelectorAll('.th-chat-input textarea').length===2);await doneDOM();
 const state=await control('/state');
 for(const chat of chats){ const r=observed.timeline.find(row=>frame('ready',chat.id)(row));Object.assign(chat,state.sessions.find(s=>s.durableId===r.frame.piSessionId)); }
 const [a,b]=chats;
 for(const c of chats)await control('/history',{path:c.path});
 const reload=async()=>{const from=observed.mark();const hydrated=chats.map(c=>wait('state',c.id,from));await page.reload({waitUntil:'domcontentloaded'});await Promise.all(hydrated);};
 const input = c=>page.locator('.th-chat-pane').filter({has:page.locator('.th-termhead-name',{hasText:c.name})}).locator('.th-chat-input textarea');
 const paneRecovery=c=>page.locator('.th-chat-pane').filter({has:page.locator('.th-termhead-name',{hasText:c.name})}).locator('[data-recovery-phase]').evaluateAll(els=>els.map(e=>({phase:e.dataset.recoveryPhase,class:e.className,text:e.textContent})));
 const opens=(s,c)=>s.requests.filter(r=>r.type==='open_session'&&r.sessionPath===c.path).length;
 const gate= c=>control('/gate',{command:'open_session',path:c.path});
 const release=c=>control('/release',{command:'open_session',path:c.path});
 async function sendActive(c,text){
  await control('/script',{path:c.path,events:[{type:'agent_start'}]});
  const started=wait('run.started',c.id);await input(c).fill(text);await input(c).press('Enter');await started;
 }
 async function dropCycle(label, targets=chats, midflight){
 const before=await control('/state');
 for(const c of targets)await gate(c);
 const from=observed.mark();const ready=targets.map(c=>wait('ready',c.id,from));
 const hydrated=targets.map(c=>observed.wait(r=>frame('entries',c.id)(r)&&r.frame.final===true,{after:from,timeout:15000,label:`terminal recovery history ${c.id}`}));
 await control('/drop',{});
 // The fixture's request feed wakes one waiter per signal; concurrent /await
 // calls can consume each other's only signal and starve. Counts are checked
 // before each wait, so serialized awaits still observe both gated opens.
 for(const c of targets)await control('/await',{path:c.path,command:'open_session',count:opens(before,c)+1});
  const pending=await capture(label+'-pending');
  if(midflight)await midflight();
  for(const c of targets)await release(c);
  await Promise.all(ready);
  await Promise.all(hydrated);
  const after=await control('/state');
  for(const c of targets){ assert.equal(opens(after,c)-opens(before,c),1,'single recovery open per chat');const row=observed.timeline.find(r=>r.sequence>from&&frame('ready',c.id)(r));assert.equal(row.frame.piSessionId,c.durableId,'same durable identity'); }
  return {before,after,pending,from};
 }
 await scenario('S1',async()=>{
  await sendActive(a,'S1 active assistant');
  const cycle=await dropCycle('S1');
  const running=await wait('state',a.id,cycle.from);
  assert.equal(running.frame.isStreaming,true,'recovery must preserve authoritative running work');
  const continued=wait('message',a.id);
  await control('/events',{path:a.path,events:[{type:'message',message:{role:'assistant',content:'S1 assistant continuation after RPC recovery'}}]});
  await continued;
  return {recovery:'same durable active assistant, one open per chat',pending:cycle.pending};
 });
 // Independent S2 setup: refresh only before injecting its background work/loss.
 await reload();
 await scenario('S2',async()=>{
  const dag=summaryInput('complete2').dag;dag.parent_session_id=a.durableId;
  const updated=observed.wait(r=>frame('extensionEvent',a.id)(r)&&r.frame.name==='omo.dag.updated',{label:'DAG active'});
  await control('/events',{path:a.path,events:[{type:'extension_event',name:'omo.dag.updated',data:dag}]});await updated;
  await capture('S2-background-active');
  const before=await control('/state');await gate(a);
  await control('/fail-open',{path:a.path,error:'open_failed: QA paused DAG cannot resume (observed issue 8006 contract)'});
  const from=observed.mark();const failed=observed.wait(r=>frame('error',a.id)(r)&&r.frame.code==='resume_failed',{after:from,label:'S2 resume failure'});
  const open=control('/await',{path:a.path,command:'open_session',count:opens(before,a)+1});
  await control('/drop',{});await open;await capture('S2-pending');
  // Subscribe to the actual render before allowing the failure to arrive.
  await dom(()=>!!document.querySelector('[data-recovery-phase="incomplete"].th-chat-status-item--warn'));
  await release(a);const failure=await failed;
  await doneDOM();
  await capture('S2-incomplete');
  // Recovery states are per-pane: the sibling chat recovered legitimately, so
  // only the failed chat's pane must carry the incomplete warning and never a
  // success report.
  const aRecovery=await paneRecovery(a);
  await save('S2-incomplete-pane-a.json',aRecovery);
  assert.ok(aRecovery.some(r=>r.phase==='incomplete'&&r.class.includes('warn')),'paused DAG failure must have visible incomplete warning, not absent recovery state');
  assert.ok(!aRecovery.some(r=>r.phase==='recovered'),'failed chat must not show recovery success');
  return {failure:failure.frame};
 });
 // Explicit setup restores the failed session and settles S1's engine work.
 // Reload/recovery must not manufacture idle state for a still-running run.
 await reload();
 const settled=wait('run.done',a.id);
 await control('/events',{path:a.path,events:[{type:'agent_settled',reason:'end_turn'}]});
 await settled;
 await scenario('S3',async(before)=>{
  const text='S3 single mid-flight prompt';
  await control('/prompt-before-apply',{path:a.path});
  const count=before.requests.filter(r=>r.type==='prompt').length;
  const entryCount=before.sessions.find(s=>s.path===a.path).entryCount;
  const written=control('/await-prompt-before-apply',{path:a.path});
  await input(a).fill(text);await input(a).press('Enter');await written;
  await save('S3-written-before-response.json',await control('/state'));
  // Keep the accepted route's prompt held across the entire recovery replay.
  // A generic pre-route handler gate cannot prove durable application.
  await dropCycle('S3');
  const applied=control('/await-history',{path:a.path,count:entryCount+1});
  await control('/release',{command:'prompt',path:a.path});await applied;
  const durable=(await readFile(a.path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const matching=durable.filter(entry=>entry.type==='message'&&entry.message?.role==='user'&&entry.message.content===text);
  await save('S3-durable-history.json',durable);
  assert.equal(matching.length,1,'exactly one matching durable user turn');
  const after=await control('/state');
  assert.equal(after.requests.filter(r=>r.type==='prompt').length-count,1,'NO duplicate prompt RPC');
  return {promptRequestCount:1,durableMatchingTurns:matching.length};
 });
 await scenario('S4',async()=>{
  const cycles=[];
  for(let i=1;i<=3;i++){const cycle=await dropCycle(`S4-cycle-${i}`);await capture(`S4-cycle-${i}-recovered`);cycles.push({cycle:i,openDeltas:chats.map(c=>opens(cycle.after,c)-opens(cycle.before,c))});}
  return {panes:2,cycles};
 });
} catch(error){ report.error=String(error.stack??error);console.error(report.error); }
finally {
 if(observed){await save('protocol-timeline.json',observed.timeline);observed.stop();}
 if(page&&report.error)await capture('fatal');
 if(context)await context.close();if(browser){await browser.close();report.cleanup.push({browserClosed:!browser.isConnected()});}
 for(const [index,task] of tasks.reverse().entries()){
  if(task.p.exitCode===null&&task.p.signalCode===null)task.p.kill('SIGTERM');
  const result=await task.closed;await writeFile(resolve(evidence,index===0?'app.log':'fixture.log'),task.output());
  const receipt=spawnSync('/bin/kill',['-0',String(task.p.pid)],{encoding:'utf8'});
  report.cleanup.push({pid:task.p.pid,...result,killZeroStatus:receipt.status,killZeroStderr:receipt.stderr.trim()});
 }
 for(const port of [25362,25372]){await new Promise((done,fail)=>{const s=createServer();s.once('error',fail);s.listen(port,'127.0.0.1',()=>s.close(done));});report.cleanup.push({port,free:true});}
 await rm(root,{recursive:true});report.cleanup.push({temporaryRoot:root,removed:true});
 report.finishedAt=new Date().toISOString();await save('report.json',report);
}
console.log(JSON.stringify(report.scenarios.map(({name,status,error})=>({name,status,error})),null,2));
if(report.error||report.scenarios.some(s=>s.status==='FAIL'))process.exitCode=1;
