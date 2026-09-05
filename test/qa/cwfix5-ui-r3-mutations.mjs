/** JSON mutations only; each normal captured positive control must pass first. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { splitReady, readable, checkCapture, catalogReady } from './cwfix5-ui-r3-capture.mjs';
import { check, titles } from './cwfix5-ui-r2-check.mjs';
const input=resolve(process.argv[2]||''), output=resolve(process.argv[3]||'');
assert.ok(output.startsWith('/tmp/cwfix5-ui-r2/capture-r3/'));await mkdir(output);
await checkCapture(input); // Whole focused positive control before any mutation.
const result=JSON.parse(await readFile(join(input,'results.json'),'utf8'));
const normal=result['split-expanded-rows'];splitReady(normal);
const proof=[];
function reject(name,mutate,pattern){const copy=structuredClone(normal);mutate(copy);assert.throws(()=>splitReady(copy),pattern);proof.push({name,rejected:true});}
for(const pane of [0,1])reject(`${pane===0?'left':'right'} row overlap`,r=>{
  const rows=r.frames.at(-1).panes[pane].rows, row=rows[1];row.top=rows[0].bottom-1;row.bottom=row.top+row.height;
},/overlapping\/invalid rows/);
reject('late geometry change',r=>{const rows=r.frames.at(-1).panes[1].rows;for(const row of rows){row.top+=1;row.bottom+=1;}assert.ok(readable(r.frames.at(-1).panes));},/late geometry change/);
reject('missing pane',r=>{r.frames.at(-1).panes.pop();},/missing pane/);
reject('single clean frame',r=>{r.frames=r.frames.slice(-1);},/consecutive window missing/);
reject('row identity change',r=>{r.frames.at(-1).panes[0].rows[0].identity='Synthetic QA turn changed';},/late geometry change/);
reject('missing observer receipts',r=>{r.resizes=[];},/observer receipts missing/);
for(const width of [320,375]){
  const normalCatalog=result[`model-${width}`];catalogReady(normalCatalog);
  const paint=structuredClone(normalCatalog);paint.paintSamples.at(-1).hash='changed';
  assert.throws(()=>catalogReady(paint),/unsettled paint/);proof.push({name:`${width} late catalog paint`,rejected:true});
  const animation=structuredClone(normalCatalog);animation.paintSamples.at(-1).running=1;
  assert.throws(()=>catalogReady(animation),/running animation/);proof.push({name:`${width} active catalog animation`,rejected:true});
}
// Historical failures stay in place; prove the old title-only verifier admitted its bad frame.
const historical=resolve('.omo/evidence/cwfix5-ui');
const old=JSON.parse(await readFile(join(historical,'qa-r2/browser/results.json'),'utf8'));
titles(old['split-expanded'],2);
assert.throws(()=>splitReady(old['split-expanded-rows']),/consecutive window missing/);
proof.push({name:'historical title-only evidence rejected',oldTitleCheckPassed:true,rejected:true});
const diagnosis=JSON.parse(await readFile(join(historical,'split-diagnosis/run/split-results.json'),'utf8'));
const overlaps=diagnosis.frames.filter(f=>f.panes.some(p=>p.rows.some((r,i)=>i&&r.top<p.rows[i-1].bottom-.5)));
assert.ok(overlaps.length>0);
for(const f of overlaps)assert.equal(readable(f.panes),false);
proof.push({name:'historical measured overlap rejected',frames:overlaps.length,rejected:true});
await assert.rejects(check(input),error => error instanceof assert.AssertionError
  && error.actual === 'subset-complete' && error.expected === 'complete');
proof.push({name:'focused evidence cannot pass full strict checker',rejected:true});
await writeFile(join(output,'proof.json'),JSON.stringify({source:input,positiveControl:'passed first',proof},null,2)+'\n');
console.log(`PASS: focused positive control; ${proof.length} negative checks rejected (including full strict subset rejection)`);
