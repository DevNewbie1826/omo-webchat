import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { titles, contained } from './cwfix5-ui-r2-check.mjs';

// Shared predicate runs unchanged in the browser and the offline checker.
export function readable(panes) {
  return panes.length === 2 && new Set(panes.map(p => p.title)).size === 2 && panes.every(p =>
    p.title && !p.loading && p.rows.length > 1 && new Set(p.rows.map(r => r.identity)).size === p.rows.length &&
    p.rows.every((r, i) => r.identity && Number.isInteger(r.index) && r.height > 0 && r.width > 0 &&
      Math.abs(r.bottom - r.top - r.height) < .01 && (!i || (r.index > p.rows[i-1].index && r.top >= p.rows[i-1].bottom - .5))));
}
export function splitReady(record) {
  assert.ok(record?.frames.length >= 24, 'split: consecutive window missing');
  const tail = record.frames.slice(-24);
  for (const frame of tail) {
    assert.ok(readable(frame.panes), 'split: missing pane or overlapping/invalid rows');
    for (const pane of frame.panes) contained(pane.controls, 'split composer');
  }
  assert.equal(new Set(tail.map(f => JSON.stringify(f.panes))).size, 1, 'split: late geometry change');
  assert.ok(record.resizes.length && record.rendered.length === 2, 'split: observer receipts missing');
}
export function installRowObserver() {
  const observed = new WeakSet();
  const probe = window.__qaRows = { frames: [], resizes: [], rendered: [] };
  const ro = new ResizeObserver(entries => probe.resizes.push({time:performance.now(), count:entries.length}));
  const rect = el => el?.getBoundingClientRect().toJSON() ?? null;
  probe.sample = () => [...document.querySelectorAll('.th-chat-pane')].map(p => ({
    title:p.querySelector('.th-termhead-name')?.textContent,
    loading:!!p.querySelector('.th-chat-loading'),
    controls:Object.fromEntries(['.th-chat-main','.th-chat-input','textarea','.th-chat-send-btn'].map(s=>[s,rect(p.querySelector(s))])),
    rows:[...p.querySelectorAll('.th-chat-row')].map(e=>({index:Number(e.dataset.index),identity:e.textContent.match(/Synthetic QA turn \d+/)?.[0],...rect(e)})).sort((a,b)=>a.index-b.index)
  }));
  const mo = new MutationObserver(() => {
    for (const el of document.querySelectorAll('.th-chat-row')) if (!observed.has(el)) {observed.add(el);ro.observe(el);}
    const panes = probe.sample();
    if (panes.length === 2 && panes.every(p=>p.rows.length && !p.loading)) probe.rendered = panes.map(p=>({title:p.title,time:performance.now()}));
  });
  mo.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  const start = performance.now();
  function sample() {
    probe.frames.push({time:performance.now(),panes:probe.sample()});
    if (performance.now()-start < 6000) probe.raf = requestAnimationFrame(sample);
  }
  probe.raf = requestAnimationFrame(sample);
  probe.stop = () => {cancelAnimationFrame(probe.raf);mo.disconnect();ro.disconnect();};
}
export async function settledRows(page) {
  const record = await page.evaluate(source => new Promise((resolve,reject) => {
    const valid = (0,eval)(`(${source})`), probe = window.__qaRows;
    let previous, consecutive=0, raf;
    const timer=setTimeout(()=>{cancelAnimationFrame(raf);reject(Error('both-pane row stability deadline'));},6000);
    function sample() {
      const panes=probe.sample(), key=JSON.stringify(panes);
      probe.frames.push({time:performance.now(),panes});
      consecutive=valid(panes) ? (key===previous ? consecutive+1 : 1) : 0;
      previous=key;
      if(consecutive>=24){clearTimeout(timer);resolve({frames:probe.frames,resizes:probe.resizes,rendered:probe.rendered});}
      else raf=requestAnimationFrame(sample);
    }
    // Stop the diagnostic frame stream, but keep subscriptions through later actions.
    cancelAnimationFrame(probe.raf);sample();
  }), readable.toString());
  splitReady(record);
  return record;
}
export function histories(events, action) {
  const receipts=[];
  const waiting=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{events.off('frame',listener);reject(Error('both histories deadline'));},6000);
    function listener(row){
      if(row.direction==='server' && row.frame.type==='entries' && row.frame.final && ['qa-restored','qa-second'].includes(row.frame.sessionId)) {
        receipts.push({sessionId:row.frame.sessionId,entries:row.frame.entries.length,final:true});
        if(new Set(receipts.map(r=>r.sessionId)).size===2){clearTimeout(timer);events.off('frame',listener);resolve(receipts);}
      }
    }
    events.on('frame',listener);
  });
  return Promise.all([waiting,action()]).then(([receipts])=>receipts);
}
export async function settledCatalog(page, screenshot) {
  // Native tap feedback is compositor-owned, absent from document.getAnimations().
  // Observe actual painted PNG equality as well as DOM animation state; do not restyle it.
  const samples=[];let previous,consecutive=0;
  const deadline=Date.now()+6000;
  while(Date.now()<deadline){
    const animation=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cancelAnimationFrame(raf);reject(Error('catalog animation frame deadline'));},6000);
      const raf=requestAnimationFrame(()=>{clearTimeout(timer);resolve({time:performance.now(),running:document.getAnimations().filter(a=>a.playState==='running').length});});
    }));
    const buffer=await screenshot();
    const hash=createHash('sha256').update(buffer).digest('hex');
    samples.push({...animation,hash});
    consecutive=animation.running===0 ? (hash===previous ? consecutive+1 : 1) : 0;previous=hash;
    if(consecutive>=4)return {samples,buffer};
  }
  throw Error('catalog painted-frame stability deadline');
}
export function catalogReady(r) {
  assert.equal(r.trigger.tapHighlight,'rgba(51, 181, 229, 0.4)');assert.equal(r.trigger.rect.height,44);
  const tail=r.paintSamples.slice(-4);assert.equal(tail.length,4);assert.equal(new Set(tail.map(s=>s.hash)).size,1, 'catalog: unsettled paint');assert.ok(tail.every(s=>s.running===0), 'catalog: running animation');
}
export async function checkCapture(directory) {
  const read=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
  const manifest=await read('manifest.json'), result=await read('results.json');
  assert.equal(manifest.scope,'R3-capture-only');assert.equal(manifest.status,'subset-complete');
  assert.ok(!(await readdir(directory)).some(n=>/failure|failed/i.test(n)), 'failed focused run');
  assert.ok(manifest.assets.length>=3);
  for(const asset of manifest.assets)assert.equal(createHash('sha256').update(await readFile(join(manifest.dist,asset.name))).digest('hex'),asset.sha256,'current built asset identity');
  assert.deepEqual(result.splitHistories.map(r=>r.sessionId).sort(),['qa-restored','qa-second']);
  assert.ok(result.splitHistories.every(r=>r.final && r.entries===100));
  for(const state of ['expanded','collapsed','independent']){splitReady(result[`split-${state}-rows`]);titles(result[`split-${state}`],2);}
  assert.deepEqual(result.splitIndependent,[true,true]);
  for(const width of [320,375]){
    const r=result[`model-${width}`];
    catalogReady(r);
    assert.equal(createHash('sha256').update(await readFile(join(directory,`model-${width}-catalog.png`))).digest('hex'),r.paintSamples.at(-1).hash,'settled PNG matches observed paint');
    assert.ok((await readFile(join(directory,`model-${width}-native-feedback.png`))).length>0,'retain native feedback');
  }
  assert.deepEqual(await read('errors.json'),[]);
  const cleanup=await read('cleanup.json');assert.equal(cleanup.browserClosed,true);assert.equal(cleanup.serverStopped,true);assert.equal(cleanup.pendingWebSockets,0);
  return manifest.runId;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(`PASS R3 capture subset ONLY: ${await checkCapture(resolve(process.argv[2]))}; native keyboard/pan and global QA remain pending`);
