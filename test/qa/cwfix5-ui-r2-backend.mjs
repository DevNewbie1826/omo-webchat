/** Real Go HTTP/WS bridge, disk store and RPC socket regressions.
 * The public RPC peer is the existing deterministic omorpctest daemon, NOT a paid model.
 * This verifies webchat's production backend across that boundary, not live engine internals.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const directory=resolve(process.argv[2]||'');
assert.ok(directory.startsWith('/tmp/cwfix5-ui-r2/'));
await mkdir(directory);
const groups=[
 {pkg:'./internal/sendqueue',tests:['TestStoreRestartRoundTrip','TestRemoveMoveClear','TestDispatchStateSurvivesRestartUntilAccepted']},
 {pkg:'./internal/wsbridge',tests:['TestSendDuringRunQueuesAndSettleFlushesOneHead','TestQueueCommandsAndEngineMirror','TestAcceptedDispatchReconcilesAfterProcessRestartWithoutResend','TestIdleBacklogOrdersRestoredHeadBeforeNewPrompt','TestChatSendAdmissionAckAndDetachedFailuresCarryRequestID','TestSuccessfulSteerAndIdenticalFollowUpEmitCompletedAcks','TestSessionSendAckIsNotMappedToSecondClientFrame']},
 {pkg:'./internal/api',tests:['TestAdoptionHTTPToBridgePreservesOriginalThroughCompletedTurn','TestAdoptWorkspaceSessionIsIdempotentAndCatalogSuppressesSource','TestAdoptExistingChatReturnsProvenanceDestinationAfterTurnAppend']},
];
const results=[];
for(const {pkg,tests} of groups){
 const args=['test','-json','-count=1','-timeout=90s',pkg,'-run',`^(${tests.join('|')})$`];
 const result=await new Promise((resolve,reject)=>{
  const child=spawn('go',args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${pkg} process deadline`));},120000);
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
 const name=pkg.split('/').at(-1);await writeFile(join(directory,`${name}.jsonl`),result.stdout);await writeFile(join(directory,`${name}.stderr`),result.stderr);
 const events=result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 results.push({pkg,args,code:result.code,tests:tests.map(test=>({name:test,passed:events.some(e=>e.Test===test&&e.Action==='pass')}))});
 await writeFile(join(directory,'results.json'),JSON.stringify(results,null,2)+'\n');
 assert.equal(result.code,0,`${pkg}: ${result.stderr}\n${result.stdout}`);
 assert.ok(!events.some(e=>e.Action==='skip'||e.Action==='fail'),`${pkg}: skipped/failed test is not GREEN`);
 for(const test of tests)assert.ok(events.some(e=>e.Test===test&&e.Action==='pass'),`missing passing test ${test}`);
}
console.log(`PASS: production Go bridge/store/adoption/RPC boundary; deterministic public peer, no paid prompts. ${directory}`);
