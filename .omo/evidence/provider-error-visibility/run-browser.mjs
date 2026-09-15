import { chromium } from '/tmp/qa3-playwright/node_modules/playwright-core/index.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, rm, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const temporary=resolve(dir,'temporary');
const save=(name,value)=>writeFile(resolve(dir,name),JSON.stringify(value,null,2)+'\n');
const receipt={contextsClosed:0,serverPid:null,killZeroFails:false,portEmpty:false,tempGone:false,chromePids:[],chromePidsGone:false};
const verdict=[];
let server,context;
const errors=[];
const scope='Real Google Chrome; built production parser -> useChatFrameState -> ChatTranscript, with injected server-contract frames. No Go dispatch or real provider exercised.';
const frame=(type,fields={})=>({type,sessionId:'qa-session',...fields});
const message=(text,extra={},ts=1000)=>frame('message',{message:{role:'assistant',blocks:text?[{kind:'text',text}]:[],ts,...extra}});
const notice=(kind,payload,at)=>frame('notice',{kind,payload,at:new Date(at).toISOString(),nid:kind});
function check(ok,description){if(!ok)throw new Error(description);}
async function snapshot(page){return page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},errorRows:[...document.querySelectorAll('.th-chat-error')].map(e=>e.textContent),noticeRows:[...document.querySelectorAll('.th-notice-status-text,.th-chat-notice-content')].map(e=>e.textContent),transcript:document.querySelector('.th-chat-body')?.innerText,assistantRows:[...document.querySelectorAll('.th-chat-row--assistant')].map(e=>e.textContent),ordered:[...document.querySelectorAll('.th-chat-turn-error,.th-notice-status-text')].map(e=>e.textContent)}));}
async function deliver(page,raw){return page.evaluate(async raw=>{const parsed=window.qaDeliver(raw);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return parsed;},raw);}
async function fresh(){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:18219/');await page.evaluate(()=>new Promise((resolve,reject)=>{if(window.qaReady)return resolve();const timer=setTimeout(()=>reject(new Error('QA readiness timeout')),10000);window.addEventListener('qa-ready',()=>{clearTimeout(timer);resolve();},{once:true});}));return page;}
async function record(name,page,sent,observed,pass,what,found){await page.screenshot({path:resolve(dir,name+'.png')});await save(name+'.json',{scenario:name,scope,sent,observed,pass,browser:await page.evaluate(()=>navigator.userAgent)});verdict.push([name,what,found,pass?'PASS':'FAIL']);await page.close();}
try{
  check(!spawnSync('lsof',['-nP','-iTCP:18219']).stdout.toString().trim(),'Port already in use');
  server=spawn('bun',[resolve(dir,'server.mjs')],{cwd:dir,stdio:['ignore','pipe','pipe']});receipt.serverPid=server.pid;
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server readiness timeout')),15000);server.stdout.once('data',data=>{clearTimeout(timer);check(JSON.parse(data).ready,'server ready');resolve();});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code));});});
  context=await chromium.launchPersistentContext(resolve(temporary,'chrome-profile'),{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,viewport:{width:390,height:844},args:['--no-first-run']});
  receipt.chromePids=spawnSync('ps',['-axo','pid=,command=']).stdout.toString().split('\n').filter(line=>line.includes(resolve(temporary,'chrome-profile'))).map(line=>Number(line.trim().split(/\s+/)[0]));
  let page=await fresh();
  const failure='Provider quota exhausted: requested 8192 tokens; remaining 0.';
  let sent=[frame('run.started'),message('',{errorMessage:failure,stopReason:'error'}),frame('run.done',{reason:'stop'})];
  for(const raw of sent)await deliver(page,raw);
  let observed=await snapshot(page);observed.textSent=failure;observed.textFound=observed.errorRows[0];
  await record('failure-visible',page,sent,observed,observed.textFound===failure,'errorMessage + stopReason:error','Exact failure text in error row');

  page=await fresh();const initial='Provider overloaded: first attempt failed.';const retry='Retrying request (attempt 1 of 1).';const ended='Retry failed: no attempts remain.';const final='Provider overloaded: final attempt failed.';
  sent=[frame('run.started'),message('',{errorMessage:initial,stopReason:'error'},1000),notice('auto_retry_start',{message:retry,attempt:1,maxAttempts:1},2000),notice('auto_retry_end',{message:ended,success:false},3000),message('',{errorMessage:final,stopReason:'error'},4000),frame('run.done',{reason:'stop'})];
  const stages=[];for(const raw of sent){await deliver(page,raw);stages.push({sent:raw,dom:await snapshot(page)});}
  observed=await snapshot(page);observed.stages=stages;
  await record('retry-sequence',page,sent,observed,JSON.stringify(observed.ordered)===JSON.stringify([initial,retry,ended,final]),'Failure; auto_retry_start; auto_retry_end(success:false); final failure','Failure -> retrying -> retry failed -> final failure, in order');

  page=await fresh();const continuation='Continuation failed: provider connection closed.';sent=[notice('continuation_error',{message:continuation},1000)];await deliver(page,sent[0]);observed=await snapshot(page);
  await record('continuation-error',page,sent,observed,observed.noticeRows.some(text=>text.includes(continuation)),'continuation_error with message','Transcript notice carries exact message');

  page=await fresh();const cancelled=[frame('run.started'),message('Partial answer before user cancellation.',{stopReason:'aborted'}),frame('run.done',{reason:'aborted'})];for(const raw of cancelled)await deliver(page,raw);const cancelledDom=await snapshot(page);
  const toolOnly=[frame('run.started'),frame('tool',{phase:'start',toolCallId:'qa-tool',toolName:'bash',args:{command:'printf tool-output'}}),frame('tool',{phase:'end',toolCallId:'qa-tool',toolName:'bash',isError:false,result:{content:[{text:'tool-output'}]}}),message('',{stopReason:'toolUse'},2000),frame('run.done',{reason:'stop'})];for(const raw of toolOnly)await deliver(page,raw);const toolDom=await snapshot(page);
  observed={cancelled:{rowCount:cancelledDom.errorRows.length,dom:cancelledDom},toolOnly:{rowCount:toolDom.errorRows.length,dom:toolDom},rowCount:toolDom.errorRows.length};
  await record('no-false-alarm',page,[...cancelled,...toolOnly],observed,cancelledDom.errorRows.length===0&&toolDom.errorRows.length===0&&toolDom.transcript.includes('tool-output'),'User-cancelled stopReason:aborted; successful tool-only turn','Cancellation: 0 error rows; tool-only: 0 error rows');

  page=await fresh();sent=[frame('run.started'),message('Ordinary legacy answer.'),message('',{},2000),frame('run.done',{reason:'stop'})];for(const raw of sent)await deliver(page,raw);observed=await snapshot(page);observed.emptyAssistantRows=observed.assistantRows.filter(text=>!text.trim()).length;
  await record('backward-compat',page,sent,observed,observed.errorRows.length===0&&observed.emptyAssistantRows===0&&observed.assistantRows.length===1&&observed.transcript.includes('Ordinary legacy answer.'),'Text completion and empty completion without either new field','Original answer; 0 error rows; 0 empty placeholders');
  await save('browser-errors.json',errors);
  check(errors.length===0,'Browser errors: '+errors.join('; '));
}finally{
  if(context){await context.close();receipt.contextsClosed++;}
  receipt.chromePidsGone=receipt.chromePids.every(pid=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}});
  if(server){const exited=once(server,'exit');server.kill('SIGTERM');await exited;try{process.kill(server.pid,0);}catch(e){if(e.code==='ESRCH')receipt.killZeroFails=true;else throw e;}}
  receipt.portEmpty=!spawnSync('lsof',['-nP','-iTCP:18219']).stdout.toString().trim();
  await rm(temporary,{recursive:true,force:true});try{await access(temporary);}catch(e){if(e.code==='ENOENT')receipt.tempGone=true;else throw e;}
  await save('cleanup.json',receipt);console.log('CLEANUP RECEIPT '+JSON.stringify(receipt));
  const table='| Scenario | What was sent | What was observed | Result |\n|---|---|---|---|\n'+verdict.map(row=>'| '+row.join(' | ')+' |').join('\n')+'\n';
  await writeFile(resolve(dir,'verdict.md'),table);console.log(table);
}
check(verdict.length===5&&verdict.every(row=>row[3]==='PASS'),'Scenario verification failed');
check(receipt.killZeroFails&&receipt.portEmpty&&receipt.tempGone&&receipt.chromePidsGone,'Cleanup verification failed');
