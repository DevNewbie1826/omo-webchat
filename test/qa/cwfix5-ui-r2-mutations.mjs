/** Negative validator tests against real captured geometry, not manufactured product RED. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { stable, contained, titles, check, acknowledgements } from './cwfix5-ui-r2-check.mjs';
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
await writeFile(join(output,'proof.json'),JSON.stringify({source:input,proof},null,2)+'\n');
console.log(`${proof.length} targeted validator mutations rejected; observed controls/title/geometry positive controls passed. ${output}`);
