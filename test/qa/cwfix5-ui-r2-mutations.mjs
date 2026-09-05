/** Negative validator tests against real captured geometry, not manufactured product RED. */
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { stable, contained, titles, check, acknowledgements, persistenceEvidence } from './cwfix5-ui-r2-check.mjs';
const input=resolve(process.argv[2]||'');const output=resolve(process.argv[3]||'');
assert.ok(output.startsWith('/tmp/cwfix5-ui-r2/'));await mkdir(output);
const results=JSON.parse(await readFile(join(input,'results.json'),'utf8'));
const proof=[];
function reject(name,fn,pattern){assert.throws(fn,pattern);proof.push({name,rejected:true});}
for(const key of ['short-320','short-1280','short-goal']){
 stable(results[key],key);const mutated=structuredClone(results[key]);mutated.at(-1)['.th-chat-input'].top+=3;
 reject(`${key} alternating geometry`,()=>stable(mutated,key),/unsettled geometry/);
}
const short=stable(results['short-dynamic'],'short-dynamic');contained(short,'short-dynamic');
const clipped=structuredClone(short);clipped['.th-chat-send-btn'].bottom=clipped['.th-chat-main'].bottom+20;
reject('clipped send control',()=>contained(clipped,'clipped'),/clipped/);
const split=results['split-expanded'];titles(split,2);
reject('one-title split',()=>titles(split.slice(0,1),2),/active title count/);
const intercepted=structuredClone(split);intercepted[0].titleHit=false;
reject('title hit intercepted',()=>titles(intercepted,2),/hit belongs to title/);
const traffic=JSON.parse(await readFile(join(input,'traffic.json'),'utf8'));
const sends=traffic.filter(row=>row.direction==='client'&&row.frame.type==='chat.send').map(row=>row.frame);
acknowledgements(sends,traffic);
const duplicate=structuredClone(traffic);duplicate.push(duplicate.find(row=>row.direction==='server'&&row.frame.type==='ack'&&row.frame.command==='chat.send'));
reject('duplicate send acknowledgement',()=>acknowledgements(sends,duplicate),/one correlated acknowledgement/);
const wrongID=structuredClone(traffic);wrongID.find(row=>row.direction==='server'&&row.frame.type==='ack'&&row.frame.command==='chat.send').frame.requestId='wrong-correlation';
reject('wrong acknowledgement correlation',()=>acknowledgements(sends,wrongID),/one correlated acknowledgement/);
await mkdir(join(output,'mixed'));await writeFile(join(output,'mixed','failure.json'),'{}');
await assert.rejects(check(join(output,'mixed')),/failed\/mixed/);proof.push({name:'mixed success/failure directory',rejected:true});
const evidence={manifest:JSON.parse(await readFile(join(input,'manifest.json'),'utf8')),result:results,cleanup:JSON.parse(await readFile(join(input,'cleanup.json'),'utf8')),names:await readdir(input)};
const fidelity=({manifest,result,cleanup,names})=>persistenceEvidence(manifest,result,cleanup,names);
fidelity(evidence); // Actual browser data passes this scope, NOT the native capability gate.
const fields=[
 ['manifest.requestedPort',0],['manifest.port',25016],['manifest.origin','http://127.0.0.1:25016'],
 ['manifest.command.executable','/bin/node'],['manifest.command.argv',[]],['manifest.command.cwd','/tmp'],
 ['cleanup.port',25016],['cleanup.browserClosed',false],['cleanup.serverStopped',false],['cleanup.pendingWebSockets',1],
 ['result.persistence',[]],
];
for(const i of [0,1]) {
 const root=`result.persistence.${i}`;
 fields.push([`${root}.order`,'wrong'],[`${root}.commands`,[]],[`${root}.commands.0.selector`,'.th-activity-bar'],[`${root}.commands.2.method`,'click'],[`${root}.commands.4.key`,'Home'],[`${root}.commands.4.complete`,false],[`${root}.commands.5.method`,'page.goto'],[`${root}.before.storageAtInit`,'120'],[`${root}.before.focused`,false],[`${root}.end.focused`,false],[`${root}.end.documentId`,'wrong'],[`${root}.restored.documentId`,results.persistence[i].end.documentId],[`${root}.restored.storageAtInit`,'120'],[`${root}.endWrites`,[]],[`${root}.endWrites.0.oldValue`,'480'],[`${root}.endWrites.0.newValue`,'120'],[`${root}.endWrites.0.key`,'other-key'],[`${root}.endWrites.0.storageId.securityOrigin`,'http://127.0.0.1:25016'],[`${root}.reloadWrites`,results.persistence[i].endWrites]);
 for(const phase of ['before','end','restored'])fields.push(
  [`${root}.${phase}.origin`,'http://127.0.0.1:25016'],[`${root}.${phase}.port`,25016],[`${root}.${phase}.viewport.height`,860],
  [`${root}.${phase}.stored`,'144'],[`${root}.${phase}.preference`,'144'],[`${root}.${phase}.navigation`,'back_forward'],
  [`${root}.${phase}.events`,[]],[`${root}.${phase}.events.0.trusted`,false],[`${root}.screenshots.${phase}`,'other.png'],
 );
}
for(const [path,wrong] of fields)for(const mode of ['missing','wrong']) {
 const copy=structuredClone(evidence),parts=path.split('.'),key=parts.pop();let target=copy;
 for(const part of parts)target=target[part];
 if(mode==='missing')delete target[key];else target[key]=wrong;
 // Machine fields only: no dependency on English assertion messages.
 reject(`${mode} ${path}`,()=>fidelity(copy));
}
const noScreenshot=structuredClone(evidence);noScreenshot.names=noScreenshot.names.filter(n=>n!=='activity-goal-restored.png');reject('missing restored PNG',()=>fidelity(noScreenshot));
const unstable=structuredClone(evidence);unstable.result['goal-activity-restored'].at(-1)['.th-activity-panel'].height+=1;reject('unstable restored geometry',()=>fidelity(unstable));
await writeFile(join(output,'proof.json'),JSON.stringify({source:input,persistencePositiveControl:true,proof},null,2)+'\n');
console.log(`${proof.length} targeted validator mutations rejected; observed controls/title/geometry positive controls passed. ${output}`);
