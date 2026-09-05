/** Full application, disposable HTTP/WS frontend channel. Backend claims require r2-backend.mjs.
 * PATH=/Users/mirage/.bun/bin:$PATH QA_PLAYWRIGHT=/absolute/playwright/index.mjs bun test/qa/cwfix5-ui-r2.mjs /tmp/cwfix5-ui-r2/UNUSED-RUN /absolute/dist
 * Full runs bind exactly 127.0.0.1:25015 (occupied port fails; never kills/falls back). --capture-r3 uses port 0.
 * Never reuses a run directory. No external engine or user session is contacted.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { check, stable, titles } from './cwfix5-ui-r2-check.mjs';
import { installRowObserver, settledRows, histories, settledCatalog, checkCapture } from './cwfix5-ui-r3-capture.mjs';
const focused=process.argv.includes('--capture-r3');
const directory=resolve(process.argv[2]||'');
assert.ok(directory.startsWith('/tmp/cwfix5-ui-r2/'),'fresh run must be under /tmp/cwfix5-ui-r2');
await mkdir(directory); // EEXIST is a hard failure, including an unfinished prior run.
const dist=resolve(process.argv[3]||'frontend/dist');
assert.ok(process.env.QA_PLAYWRIGHT,'QA_PLAYWRIGHT must identify installed Playwright module');
const {chromium}=await import(process.env.QA_PLAYWRIGHT);
const save=(name,value)=>writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n');
const assets=[];
for(const name of ['index.html',...(await readdir(join(dist,'assets'))).filter(n=>/^index-.*\.(js|css)$/.test(n)).map(n=>`assets/${n}`)]) assets.push({name,sha256:createHash('sha256').update(await readFile(join(dist,name))).digest('hex')});
const manifest={runId:directory.split('/').at(-1),status:'running',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),assets,dist,started:new Date().toISOString()};
if(focused)manifest.scope='R3-capture-only';
await save('manifest.json',manifest);
const initial={provider:'glm-zcode',modelId:'glm-5.3'};
const alternative={provider:'other-provider',modelId:'alternate-qa'};
const models=Array.from({length:183},(_,i)=>i===178?{...initial,name:'GLM 5.3'}:i===177?{...alternative,name:'Alternate QA model'}:{provider:`catalog-${Math.floor(i/20)}`,modelId:`model-${i}`,name:`Catalog model ${i}`});
const longGoal={status:'active',objective:Array.from({length:9},(_,i)=>`Requirement ${i+1}: preserve readable conversation and stable usable controls.`).join('\n')};
const activity={history:{task:{parent_session_id:'qa-durable',truncated_tasks:false,tasks:Array.from({length:36},(_,i)=>({task_id:`qa-task-${i}`,name:`Completed layout check ${i}`,status:'completed'}))},dag:null}};
const history=Array.from({length:100},(_,i)=>({id:`entry-${i}`,parentId:i?`entry-${i-1}`:null,type:'message',message:{role:i%2?'assistant':'user',content:`Synthetic QA turn ${i}.\n\n${'Disposable layout conversation. '.repeat(30)}`}}));
function newChat(id,name,empty=false){return {id,name,provider:'omo',model:{...initial},goal:empty?null:{...longGoal},entries:empty?[]:structuredClone(history),queue:[],revision:0,running:false};}
const chats=new Map([['qa-restored',newChat('qa-restored','Restored conversation title')],['qa-second',newChat('qa-second','Independent second conversation')]]);
let layout={kind:'leaf',id:'qa-pane',sessionId:'qa-restored'};
let adopted=false;
const wish={id:'qa-wish-source',name:'Disposable /wish adoption',source:'discovered',resumeIdentity:'/qa/disposable/wish-session.jsonl',recencyMs:1788600000000};
const traffic=[],actions=[],errors=[],results={},sockets=new Set(),events=new EventEmitter();
function record(direction,frame){traffic.push({direction,frame:structuredClone(frame)});events.emit('frame',{direction,frame});}
function send(ws,id,body){const frame={sessionId:id,...body};record('server',frame);ws.send(JSON.stringify(frame));}
function publish(id,body){for(const ws of sockets)if(ws.data.ids.has(id))send(ws,id,body);}
function queue(chat){return {type:'queue',revision:++chat.revision,items:chat.queue,engine:{pendingMessageCount:0,ordered:[]}};}
function state(chat){return {type:'state',isStreaming:chat.running,isCompacting:false,model:chat.model,thinkingLevel:'high'};}
function ack(ws,id,frame){send(ws,id,{type:'ack',command:frame.type,requestId:frame.requestId});}
function echo(chat,text){const message={role:'user',content:text};chat.entries.push({id:`sent-${chat.entries.length}`,type:'message',message});publish(chat.id,{type:'message',message});}
const requestedPort=focused?0:25015;
const server=Bun.serve({hostname:'127.0.0.1',port:requestedPort,
 async fetch(req,server){
  const path=new URL(req.url).pathname;
  if(path==='/api/v2/ws'&&server.upgrade(req,{data:{ids:new Set()}}))return;
  traffic.push({method:req.method,path});
  if(path==='/api/auth/check')return new Response(null,{status:204});
  if(path==='/api/providers')return Response.json([{id:'omo',label:'Chat',binary:'fixture',available:true}]);
  const metadata=chat=>({id:chat.id,name:chat.name,provider:'omo'});
  if(path==='/api/workspaces')return Response.json([{id:'qa-workspace',name:'Disposable QA',path:'/qa/disposable',chats:[...chats.values()].map(metadata)}]);
  if(path==='/api/sessions/live')return Response.json({sessions:[...chats.keys()]});
  if(path==='/api/workspaces/qa-workspace/sessions')return Response.json({items:[...[...chats.values()].map(c=>({...metadata(c),source:'stored',recencyMs:1788600000000})),...(!adopted?[wish]:[])],nextCursor:''});
  if(path==='/api/workspaces/qa-workspace/chats'&&req.method==='POST'){
   const body=await req.json();const chat=newChat('qa-empty',body.name||'New empty conversation',true);chats.set(chat.id,chat);traffic.at(-1).body=body;return Response.json(metadata(chat));
  }
  if(path==='/api/workspaces/qa-workspace/sessions/open'&&req.method==='POST'){
   const body=await req.json();traffic.at(-1).body=body;adopted=true;const chat=newChat('qa-adopted',wish.name,true);chat.entries=[{id:'wish-entry',type:'message',message:{role:'user',content:'/wish disposable fixture objective'}}];chats.set(chat.id,chat);return Response.json(metadata(chat));
  }
  if(path.endsWith('/goal')){const chat=chats.get(path.split('/').at(-2));return Response.json({goal:chat?.goal??null});}
  if(path.endsWith('/activity'))return Response.json(['qa-restored','qa-second'].includes(path.split('/').at(-2))?activity:{history:{task:null,dag:null}});
  if(path==='/api/layout'){if(req.method==='PUT')layout=await req.json();return Response.json({layout});}
  if(path.startsWith('/api/')){errors.push(`Unhandled HTTP ${req.method} ${path}`);return new Response('Unhandled fixture request',{status:404});}
  const file=Bun.file(resolve(dist,path==='/'?'index.html':path.slice(1)));return await file.exists()?new Response(file):new Response('Not found',{status:404});
 },websocket:{open(ws){sockets.add(ws);send(ws,undefined,{type:'hello',version:2,serverVersion:'disposable-r2'});},close(ws){sockets.delete(ws);},message(ws,raw){
  const frame=JSON.parse(String(raw));record('client',frame);const id=frame.sessionId||frame.chatId;const chat=chats.get(id);
  if(frame.type==='chat.create'){
   assert.ok(chat,`unknown chat ${id}`);ws.data.ids.add(id);send(ws,id,{type:'ready',resumed:chat.entries.length>0,piSessionId:`durable-${id}`});send(ws,id,state(chat));send(ws,id,{type:'models',models});send(ws,id,{type:'commands',commands:[]});send(ws,id,{type:'entries',entries:chat.entries,leafId:chat.entries.at(-1)?.id,final:true});send(ws,id,queue(chat));
  }else if(frame.type==='chat.stats')send(ws,id,{type:'stats',cost:0,contextUsage:{percent:0,tokens:150,contextWindow:200000}});
  else if(frame.type==='chat.models')send(ws,id,{type:'models',models});
  else if(frame.type==='chat.set'){if(frame.model)chat.model=frame.model;send(ws,id,{type:'control.result',requestId:frame.requestId,command:frame.model?'set_model':'set_thinking_level',success:true});send(ws,id,state(chat));}
  else if(frame.type==='chat.send'){
   ack(ws,id,frame);
   if(frame.run.kind==='steer'){/* A real bridge emits ONE unphased admission ack; the echo is released by the scenario. */}
   else if(chat.running){chat.queue.push({id:`queue-${chat.revision}`,text:frame.run.message,hasImage:false,createdAt:chat.revision+1,requestId:frame.requestId});send(ws,id,queue(chat));}
   else{chat.running=true;send(ws,id,{type:'run.started'});echo(chat,frame.run.message);}
  }else if(frame.type==='chat.queue.move'){
   const index=chat.queue.findIndex(q=>q.id===frame.itemId);assert.ok(index>=0);chat.queue.splice(frame.toIndex,0,...chat.queue.splice(index,1));ack(ws,id,frame);send(ws,id,queue(chat));
  }else if(frame.type==='chat.queue.remove'){assert.ok(chat.queue.some(q=>q.id===frame.itemId));chat.queue=chat.queue.filter(q=>q.id!==frame.itemId);ack(ws,id,frame);send(ws,id,queue(chat));}
  else if(frame.type==='chat.queue.clear'){chat.queue=[];ack(ws,id,frame);send(ws,id,queue(chat));}
  else if(frame.type==='chat.abort'){chat.running=false;send(ws,id,{type:'run.done',reason:'aborted'});}
  else if(!['hello','sessions.subscribe','chat.close','ping'].includes(frame.type))errors.push(`Unhandled client frame ${frame.type}`);
 }} });
const fixturePort=server.port;
const origin=`http://127.0.0.1:${fixturePort}`;
Object.assign(manifest,{requestedPort,origin,port:fixturePort,command:{executable:process.execPath,argv:process.argv.slice(1),cwd:process.cwd()}});
await save('manifest.json',manifest);
const browser=await chromium.launch({channel:'chrome',headless:true});
let context=await browser.newContext({viewport:{width:1280,height:800},...(focused?{storageState:{cookies:[],origins:[{origin,localStorage:[{name:'th-activity-panel-height',value:'480'}]}]}}:{})});
let traceIndex=0;
await context.tracing.start({screenshots:true,snapshots:true,sources:true});
async function closeContext(){await context.tracing.stop({path:join(directory,`trace-${traceIndex++}.zip`)});await context.close();}
async function startContext(options){context=await browser.newContext(options);await context.tracing.start({screenshots:true,snapshots:true,sources:true});page=await context.newPage();configure();}
let page=await context.newPage();
function configure(){page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));}
configure();
async function action(label,fn){actions.push({label});const value=await fn();actions.at(-1).complete=true;return value;}
// Mutation subscription is installed BEFORE each action. No polling or timing grace period.
async function expectDOM(expression,fn){
 const key=`wait-${actions.push({expression})}`;
 await page.evaluate(({key,expression})=>{window.__qaWaits??={};window.__qaWaits[key]=new Promise((resolve,reject)=>{const observer=new MutationObserver(check);const timer=setTimeout(()=>{observer.disconnect();reject(new Error(`DOM deadline: ${expression}`));},6000);function check(){if(Function(`return (${expression})`)()){observer.disconnect();clearTimeout(timer);resolve(true);}}observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});check();});},{key,expression});
 await fn();await page.evaluate(key=>window.__qaWaits[key],key);
}
function wire(type,fn){const waiting=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{events.off('frame',listener);reject(new Error(`wire deadline ${type}`));},6000);function listener(row){if(row.direction==='client'&&row.frame.type===type){clearTimeout(timer);events.off('frame',listener);resolve(row.frame);}}events.on('frame',listener);});return Promise.all([waiting,fn()]).then(([frame])=>frame);}
async function load(){await page.addInitScript(()=>{localStorage.setItem('th-lang','en');window.__qaHydrated=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(new Error('hydrate deadline'));},10000);const observer=new MutationObserver(check);function check(){if(document.querySelector('.th-model-picker-btn')&&document.querySelector('textarea:not([disabled])')){observer.disconnect();clearTimeout(timer);resolve(true);}}observer.observe(document,{childList:true,subtree:true,attributes:true});check();});});await page.goto(origin);await page.evaluate(()=>window.__qaHydrated);}
async function geometry(){return page.evaluate(()=>new Promise((resolve,reject)=>{const rows=[];const timer=setTimeout(()=>reject(new Error('geometry deadline')),6000);function sample(){const frame={};for(const selector of ['.th-termhead','.th-chat-main','.th-chat-main-content','.th-chat-input','textarea','.th-chat-send-btn','.th-chat-scrollport','.th-goal-panel','.th-activity-panel','.th-queue','.th-send-error-banner']){const el=document.querySelector(selector);const b=el?.getBoundingClientRect();frame[selector]=b?{top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height,scrollHeight:el.scrollHeight}:null;}rows.push(frame);if(rows.length===24){clearTimeout(timer);resolve(rows);}else requestAnimationFrame(sample);}requestAnimationFrame(sample);}));}
async function capture(key){results[key]=await geometry();stable(results[key],key);await page.screenshot({path:join(directory,`${key}.png`)});await save('results.json',results);return results[key].at(-1);}
async function native(commands,method,selector,key){const receipt={method,...(selector?{selector}:{}),...(key?{key}:{})};commands.push(receipt);if(method==='page.reload')await page.reload();else await page.locator(selector)[method](...(key?[key]:[]));receipt.complete=true;}
async function shelves(order='goal-activity',commands=[]){for(const key of order.split('-'))await native(commands,'click',key==='goal'?'.th-goal-bar':'.th-activity-shelf .th-activity-bar');}
async function titleCapture(key,count){if(count===2)results[`${key}-rows`]=await settledRows(page);results[key]=await page.evaluate(()=>{const toggle=document.querySelector('.th-sidebar-toggle'),b=toggle.getBoundingClientRect();return [...document.querySelectorAll('.th-termhead-name')].map(title=>{const a=title.getBoundingClientRect(),hit=document.elementFromPoint(a.left+1,a.top+a.height/2);return {text:title.textContent,title:a.toJSON(),toggle:b.toJSON(),overlapArea:Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)),titleHit:title===hit||title.contains(hit)};});});titles(results[key],count);await page.screenshot({path:join(directory,`${key}.png`)});}
async function toggleSidebar(){await page.evaluate(()=>{const el=document.querySelector('.th-sidebar');window.__qaSidebar=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('sidebar transition deadline')),6000);el.addEventListener('transitionend',function done(e){if(e.target===el&&e.propertyName==='width'){clearTimeout(timer);el.removeEventListener('transitionend',done);resolve(true);}});});});await page.locator('.th-sidebar-toggle').click();await page.evaluate(()=>window.__qaSidebar);}
let failure;
try{
 if(!focused){
 // Read-only document/native-event and CDP storage observers: no preference seed,
 // storage shim, or reload-time repair can stand in for the application's write.
 await page.addInitScript(()=>{
  window.__qaPersistence={documentId:crypto.randomUUID(),storageAtInit:localStorage.getItem('th-activity-panel-height'),events:[]};
  for(const type of ['click','focusin','keydown'])document.addEventListener(type,event=>{
   const selector=['.th-goal-bar','.th-activity-shelf .th-activity-bar','.th-activity-resize'].find(s=>event.target.closest?.(s));
   if(selector)window.__qaPersistence.events.push({type,selector,trusted:event.isTrusted,...(type==='keydown'?{key:event.key}:{})});
  },true);
 });
 const storage=await context.newCDPSession(page),storageEvents=[];
 for(const event of ['domStorageItemAdded','domStorageItemUpdated','domStorageItemRemoved','domStorageItemsCleared'])storage.on(`DOMStorage.${event}`,row=>{
  if(row.storageId.securityOrigin===origin&&row.storageId.isLocalStorage&&(row.key==='th-activity-panel-height'||event==='domStorageItemsCleared'))storageEvents.push({event,...row});
 });
 await storage.send('DOMStorage.enable');
 const snapshot=()=>page.evaluate(()=>({origin:location.origin,port:Number(location.port),viewport:{width:innerWidth,height:innerHeight},stored:localStorage.getItem('th-activity-panel-height'),preference:document.querySelector('.th-activity-resize')?.getAttribute('aria-valuenow'),focused:document.activeElement?.matches('.th-activity-resize'),navigation:performance.getEntriesByType('navigation')[0].type,...window.__qaPersistence}));
 const storageBarrier=()=>storage.send('DOMStorage.getDOMStorageItems',{storageId:{securityOrigin:origin,isLocalStorage:true}});
 await action('render restored application',load);
 await page.screenshot({path:join(directory,'render.png')});
 for(const order of ['activity-goal','goal-activity','resize-goal-activity']){
  if(order.startsWith('resize'))await page.setViewportSize({width:1280,height:860});
  await load();
  if(order.startsWith('resize')){await shelves('goal-activity');await page.setViewportSize({width:1280,height:800});await capture(order);continue;}
  const r=(results.persistence??=[])[results.persistence.length]={order,commands:[]};
  await shelves(order,r.commands);
  await native(r.commands,'focus','.th-activity-resize');
  await expectDOM("document.querySelector('.th-activity-resize')?.getAttribute('aria-valuenow')==='120'",()=>native(r.commands,'press','.th-activity-resize','Home'));
  await capture(`${order}-before`);r.before=await snapshot();await storageBarrier();const endStart=storageEvents.length;
  await expectDOM("document.querySelector('.th-activity-resize')?.getAttribute('aria-valuenow')==='480' && localStorage.getItem('th-activity-panel-height')==='480'",()=>native(r.commands,'press','.th-activity-resize','End'));
  await capture(order);r.end=await snapshot();await storageBarrier();r.endWrites=storageEvents.slice(endStart);const reloadStart=storageEvents.length;
  await native(r.commands,'page.reload');await page.evaluate(()=>window.__qaHydrated);
  await shelves(order,r.commands);await capture(`${order}-restored`);r.restored=await snapshot();await storageBarrier();r.reloadWrites=storageEvents.slice(reloadStart);
  r.screenshots={before:`${order}-before.png`,end:`${order}.png`,restored:`${order}-restored.png`};
 }
 await titleCapture('single-expanded',1);await toggleSidebar();await titleCapture('single-collapsed',1);await toggleSidebar();
 // Tiny restore retains the requested preference on this mount, not just storage.
 await page.setViewportSize({width:1280,height:300});await load();await shelves();await capture('restore-short');
 await page.setViewportSize({width:1280,height:800});await capture('restore-grown');results.savedAfterRestore=await page.evaluate(()=>localStorage.getItem('th-activity-panel-height'));
 chats.get('qa-restored').goal={status:'active',objective:'Small intrinsic goal'};
 await page.setViewportSize({width:1280,height:1000});await load();await shelves();
 await page.locator('.th-activity-resize').press('Home');await capture('growth-home');await page.locator('.th-activity-resize').press('ArrowUp');await capture('growth-up');
 assert.equal(results['growth-up'].at(-1)['.th-activity-panel'].height,144);
 // Restore the original 480 floor/short/split precondition by a real gesture,
 // rather than the former reload-time storage seed.
 await page.setViewportSize({width:1280,height:800});
 await expectDOM("document.querySelector('.th-activity-resize')?.getAttribute('aria-valuenow')==='480'",()=>page.locator('.th-activity-resize').press('End'));
 for(const order of ['goal','activity']){
  await page.setViewportSize({width:1280,height:800});await load();await shelves(order==='goal'?'goal-activity':'activity-goal');
  for(const floor of [48,49,50,51]){
   await page.evaluate(floor=>{const column=document.querySelector('.th-chat-main');let fixed=0;const outer=el=>{const s=getComputedStyle(el);return el.getBoundingClientRect().height+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0);};for(const el of column.querySelectorAll('.th-chat-input,.th-chat-status,.th-activity-bar-row,.th-activity-resize'))fixed+=outer(el);for(const el of column.querySelectorAll('.th-goal-shelf,.th-activity-shelf')){const s=getComputedStyle(el);fixed+=(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0);}column.style.flex='none';column.style.height=`${fixed+120+floor-4}px`;},floor);
   await capture(`floor-${order}-${floor}-plain`);
   await expectDOM("document.querySelector('.th-send-error-banner')",async()=>publish('qa-restored',{type:'error',code:'send_failed',message:'Disposable floor band'}));await capture(`floor-${order}-${floor}-banner`);
   await expectDOM("!document.querySelector('.th-send-error-banner')",()=>page.locator('.th-send-error-banner button').click());await capture(`floor-${order}-${floor}-removed`);
  }
 }
 for(const width of [1280,320]){await page.setViewportSize({width,height:300});await load();await shelves();await capture(`short-${width}`);}
 await page.locator('textarea').fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
 const restored=chats.get('qa-restored');restored.queue=Array.from({length:10},(_,i)=>({id:`short-${i}`,text:`Dynamic queued ${i}`,hasImage:false,createdAt:i+1}));
 await expectDOM("document.querySelector('.th-queue-header')",async()=>publish(restored.id,queue(restored)));await page.locator('.th-queue-header').click();
 await expectDOM("document.querySelector('.th-send-error-banner')",async()=>publish(restored.id,{type:'error',code:'send_failed',message:'Disposable dynamic recovery'}));await capture('short-dynamic');
 results.reachableControls=[];
 await wire('chat.queue.clear',()=>page.locator('.th-queue-clear').click());results.reachableControls.push('queue-clear');
 await page.locator('.th-send-error-banner button').click();results.reachableControls.push('banner-dismiss');
 await expectDOM("document.querySelector('.th-chat-send-btn').classList.contains('th-btn--danger')",async()=>{restored.running=true;publish(restored.id,{type:'run.started'});});
 await wire('chat.abort',()=>page.locator('.th-chat-send-btn').click());results.reachableControls.push('stop');
 await page.setViewportSize({width:320,height:800});await capture('short-recovery');results.recoveredDraftLines=(await page.locator('textarea').inputValue()).split('\n').length;
 await page.setViewportSize({width:1280,height:800});await load();await page.locator('.th-goal-bar').click();await capture('short-goal');
 }
 layout={kind:'split',id:'qa-split',dir:'h',ratio:.5,first:{kind:'leaf',id:'qa-pane',sessionId:'qa-restored'},second:{kind:'leaf',id:'qa-pane-two',sessionId:'qa-second'}};
 await page.addInitScript(installRowObserver);
 results.splitHistories=await histories(events,load);
 results.splitEarly=await page.evaluate(()=>window.__qaRows.frames);
 await page.screenshot({path:join(directory,'split-early.png')});
 await titleCapture('split-expanded',2);await toggleSidebar();await titleCapture('split-collapsed',2);await toggleSidebar();
 const panes=page.locator('.th-chat-pane');await panes.nth(0).locator('.th-goal-bar').click();await panes.nth(1).locator('.th-activity-shelf .th-activity-bar').click();
 results.splitIndependent=[await panes.nth(0).locator('.th-goal-panel').count()===1&&await panes.nth(0).locator('.th-activity-panel').count()===0,await panes.nth(1).locator('.th-activity-panel').count()===1&&await panes.nth(1).locator('.th-goal-panel').count()===0];
 await titleCapture('split-independent',2);
 await page.evaluate(()=>window.__qaRows.stop());
 layout={kind:'leaf',id:'qa-pane',sessionId:'qa-restored'};
 const restored=chats.get('qa-restored');
 for(const width of [375,320]){
  await closeContext();await startContext({viewport:{width,height:width===320?740:812},hasTouch:true,isMobile:true});restored.model={...initial};await load();
  const r=results[`model-${width}`]={commands:[],touch:await page.evaluate(()=>navigator.maxTouchPoints>0)};
  const trigger=page.locator('.th-model-picker-btn');
  r.trigger=await trigger.evaluate(el=>({rect:el.getBoundingClientRect().toJSON(),tapHighlight:getComputedStyle(el).webkitTapHighlightColor}));
  await trigger.tap();await page.screenshot({path:join(directory,`model-${width}-native-feedback.png`)});r.initialInputFocus=await page.evaluate(()=>document.activeElement.tagName==='INPUT');
  r.initialSelected=await page.locator('[role=option][aria-selected=true] > span').textContent();
  r.currentVisible=await page.locator('[role=option][aria-selected=true]').evaluate(el=>{const b=el.getBoundingClientRect(),list=el.closest('.th-model-picker-list').getBoundingClientRect();return b.top>=list.top&&b.bottom<=list.bottom;});
  await page.keyboard.press('ArrowDown');r.navigationSelected=await page.locator('[role=option][aria-selected=true] > span').textContent();
  r.traversal={close:false,thinking:false,search:false,reverse:false};
  await page.keyboard.press('Tab');r.traversal.close=await page.evaluate(()=>document.activeElement.matches('.th-model-picker-current button'));
  for(let i=0;i<12&&!r.traversal.search;i++){await page.keyboard.press('Tab');const cls=await page.evaluate(()=>document.activeElement.className);r.traversal.thinking||=cls.includes('th-thinking-level');r.traversal.search=cls.includes('th-model-picker-search');}
  await page.keyboard.press('Shift+Tab');r.traversal.reverse=await page.evaluate(()=>document.activeElement.matches('.th-thinking-level'));
  await page.keyboard.press('Escape');r.escapeRestored=await page.evaluate(()=>document.activeElement.matches('.th-model-picker-btn'));
  await trigger.tap();await page.locator('.th-model-picker-current button').click();r.closeRestored=await page.evaluate(()=>document.activeElement.matches('.th-model-picker-btn'));
  await trigger.tap();
  // Catalog frames traverse the real application transport. A following state
  // frame supplies an observable ordered barrier even for equivalent DOM rows.
  const catalogSnapshot=()=>page.evaluate(()=>{const search=document.querySelector('.th-model-picker-search');const active=document.getElementById(search.getAttribute('aria-activedescendant'));return {query:search.value,focus:document.activeElement===search?'search':document.activeElement.matches('.th-thinking-level')?'thinking':'other',active:active?[active.querySelector('span').textContent,active.querySelector('strong').textContent]:null,current:document.querySelector('.th-model-picker-label').textContent};});
  await page.locator('.th-model-picker-search').fill('Catalog model');await page.keyboard.press('ArrowDown');
  r.catalog=[];
  for(const [phase,catalog,thinkingLevel] of [['equivalent-search',structuredClone(models),'low'],['reordered-thinking',structuredClone(models).reverse(),'high'],['equivalent-thinking',structuredClone(models).reverse(),'low']]){
   if(phase==='reordered-thinking')await page.locator('.th-thinking-level').first().focus();
   const before=await catalogSnapshot();
   await expectDOM(`document.querySelector('.th-model-picker-thinking')?.textContent===${JSON.stringify(thinkingLevel)}`,async()=>{publish(restored.id,{type:'models',models:catalog});publish(restored.id,{...state(restored),thinkingLevel});});
   const after=await catalogSnapshot();assert.deepEqual(after,before,`${phase}: query/focus/active identity retained`);r.catalog.push({phase,before,after});
  }
  await page.screenshot({path:join(directory,`model-${width}-catalog-feedback.png`)});
  // Catalog retention already left focus on thinking; observe native feedback settling separately.
  const painted=await settledCatalog(page,()=>page.screenshot());r.paintSamples=painted.samples;
  await writeFile(join(directory,`model-${width}-catalog.png`),painted.buffer);
  if(focused)continue;
  await page.locator('.th-model-picker-search').fill('Alternate QA model');
  await expectDOM("document.querySelector('.th-model-picker-label').textContent==='Alternate QA model'",async()=>{r.commands.push(await wire('chat.set',()=>page.locator('[role=option]').click()));});await trigger.tap();
  r.selectedProvider=await page.locator('[role=option][aria-selected=true] > span').textContent();r.selectedModel=await page.locator('[role=option][aria-selected=true] > strong').textContent();
  // The shipped maximum-scale=1 meta blocks CDP zoom (retained failed probe).
  // Exercise native available resize/touch, but never label this an OS keyboard:
  // final acceptance requires visual-only shrink/pan and fails closed if absent.
  const cdp=await context.newCDPSession(page);r.viewport={channel:'layout-and-visual-viewport resize; native touch gesture',visualOnly:false,before:await page.evaluate(()=>({height:visualViewport.height,width:visualViewport.width,scale:visualViewport.scale,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft,layoutHeight:innerHeight}))};
  await page.evaluate(()=>{window.__qaVV=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('visualViewport resize deadline')),6000);visualViewport.addEventListener('resize',()=>{clearTimeout(timer);resolve(true);},{once:true});});});
  await page.setViewportSize({width,height:420});await page.evaluate(()=>window.__qaVV);
  r.viewport.after=await page.evaluate(()=>({height:visualViewport.height,width:visualViewport.width,scale:visualViewport.scale,offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft}));
  await geometry();r.viewport.contained=await page.locator('.th-model-picker-popover').evaluate(el=>{const b=el.getBoundingClientRect(),v=visualViewport;return b.left>=v.offsetLeft-.5&&b.top>=v.offsetTop-.5&&b.right<=v.offsetLeft+v.width+.5&&b.bottom<=v.offsetTop+v.height+.5;});
  r.viewport.box=await page.locator('.th-model-picker-popover').boundingBox();
  await page.screenshot({path:join(directory,`model-${width}-visual-viewport.png`)});
  // Gesture completion is the CDP response; geometry sampling records actual pan,
  // including a zero offset on a Chromium configuration that cannot pan here.
  await cdp.send('Input.synthesizeScrollGesture',{x:Math.floor(width/2),y:300,yDistance:-100,xDistance:-35,gestureSourceType:'touch',speed:800});
  await geometry();r.viewport.pan=await page.evaluate(()=>({offsetTop:visualViewport.offsetTop,offsetLeft:visualViewport.offsetLeft,width:visualViewport.width,height:visualViewport.height}));
  await page.screenshot({path:join(directory,`model-${width}-pan.png`)});
  await page.keyboard.press('Escape');
 }
 if(!focused){
 await closeContext();await startContext({viewport:{width:1280,height:800}});await load();
 // Remaining S2-S6 real browser flow follows authoritative wire state, not DOM injection.
 await page.locator('.th-tree-workspace > .th-tree-node').hover();
 const newLayoutSaved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/layout'&&response.request().method()==='PUT');
 await expectDOM("document.querySelector('.th-termhead-name')?.textContent==='New empty conversation' && document.querySelectorAll('.th-chat-msg').length===0",()=>action('new empty conversation',()=>page.getByRole('button',{name:'Add chat session',exact:true}).click()));results.emptyMessages=await page.locator('.th-chat-msg').count();
 const empty=chats.get('qa-empty');assert.ok(empty,'new-chat HTTP request must create actual fixture chat');
 results.emptyGoals=await page.locator('.th-goal-bar').count();await page.screenshot({path:join(directory,'new-empty.png')});
 async function submit(text,key='Enter'){await page.locator('textarea').fill(text);return wire('chat.send',()=>page.locator('textarea').press(key));}
 await expectDOM("document.querySelector('.th-chat-send-btn.th-btn--danger') && [...document.querySelectorAll('.th-chat-msg')].some(e=>e.textContent.includes('correlated fixture prompt'))",()=>submit('correlated fixture prompt'));
 for(const text of ['queue-a','queue-b','queue-c'])await submit(text);
 assert.equal((await newLayoutSaved).status(),200);
 await load();await page.locator('.th-queue-header').click();results.queueRestored=await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents();
 await expectDOM("document.querySelector('.th-queue-row--waiting .th-queue-text')?.textContent==='queue-b'",()=>wire('chat.queue.move',()=>page.locator('.th-queue-row--waiting').nth(1).locator('.th-queue-btn').first().click()));results.queueReordered=await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents();
 await expectDOM("document.querySelectorAll('.th-queue-row--waiting').length===2",()=>wire('chat.queue.remove',()=>page.locator('.th-queue-btn--remove').nth(2).click()));results.queueRemoved=await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents();
 await expectDOM("document.querySelector('.th-chat-status-item--steer')",()=>submit('steer fixture prompt','Control+Enter'));results.steerPending=await page.locator('.th-chat-status-item--steer').count()>0;
 await page.screenshot({path:join(directory,'steer-pending.png')});
 await expectDOM("document.querySelectorAll('.th-queue-row--waiting').length===1 && !document.querySelector('.th-chat-status-item--steer')",async()=>{echo(empty,'steer fixture prompt');empty.running=false;publish(empty.id,{type:'run.done',reason:'end_turn'});const head=empty.queue.shift();echo(empty,head.text);publish(empty.id,queue(empty));});results.queueFlushed=await page.locator('.th-queue-row--waiting .th-queue-text').allTextContents();
 results.correlatedMessages=await page.locator('.th-chat-msg').filter({hasText:'correlated fixture prompt'}).count();
 const tool={type:'tool',toolCallId:'qa-skill-read',toolName:'read',phase:'start',args:{path:'/qa/disposable/skills/qa-layout/SKILL.md'}};
 await expectDOM("document.querySelector('.th-tool-name')",async()=>publish(empty.id,tool));publish(empty.id,{...tool,phase:'end',result:{content:[{text:'Disposable skill manifest'}]},isError:false});results.skills={live:await page.locator('.th-tool-name').filter({hasText:'Read skill: qa-layout'}).count()};await page.screenshot({path:join(directory,'skill-live.png')});
 empty.entries.push({id:'qa-skill',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:tool.toolCallId,name:'read',arguments:tool.args},{type:'toolResult',text:'Disposable skill manifest'}]}});await load();results.skills.restored=await page.locator('.th-tool-name').filter({hasText:'Read skill: qa-layout'}).count();await page.screenshot({path:join(directory,'skill-restored.png')});
 await expectDOM("document.querySelector('.th-termhead-name')?.textContent==='Disposable /wish adoption'",()=>page.getByText(wish.name,{exact:true}).click());
 results.adoptedRows=await page.locator('.th-sidebar').getByText(wish.name,{exact:true}).count();await page.screenshot({path:join(directory,'wish-adopted.png')});
 }
 await save('results.json',results);
}catch(error){failure=error;await save('failure.json',{error:String(error),stack:error.stack});await page.screenshot({path:join(directory,'failure.png')});}
finally{
 await closeContext();await browser.close();for(const ws of sockets)ws.close();await server.stop(true);
 await save('results.json',results);await save('traffic.json',traffic);await save('actions.json',actions);await save('errors.json',errors);await save('cleanup.json',{browserClosed:true,serverStopped:true,pendingWebSockets:server.pendingWebSockets,port:fixturePort});
 manifest.status=failure?'failed':focused?'subset-complete':'complete';manifest.finished=new Date().toISOString();await save('manifest.json',manifest);
}
if(failure)throw failure;
try { await (focused?checkCapture:check)(directory); }
catch(error){manifest.status='failed';await save('manifest.json',manifest);await save('failure.json',{error:String(error),stack:error.stack});throw error;}
console.log(`${focused?'R3 capture subset ONLY; native keyboard/pan and global prerequisites PENDING':'R2 browser matrix complete'}: ${directory}`);
