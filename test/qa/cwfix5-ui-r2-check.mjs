import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { splitReady, catalogReady } from './cwfix5-ui-r3-capture.mjs';

export function stable(frames, label) {
  assert.equal(frames.length, 24, `${label}: sample count`);
  const settled = frames.slice(-12);
  assert.equal(new Set(settled.map(frame => JSON.stringify(frame))).size, 1, `${label}: unsettled geometry`);
  return settled.at(-1);
}
export function contained(frame, label) {
  const column = frame['.th-chat-main'];
  assert.ok(column, `${label}: missing column`);
  for (const key of ['.th-chat-input', 'textarea', '.th-chat-send-btn']) {
    const b = frame[key];
    assert.ok(b && b.height > 0 && b.width > 0 && b.top >= column.top - .5 && b.bottom <= column.bottom + .5,
      `${label}: ${key} clipped`);
  }
}
export function titles(rows, count) {
  assert.equal(rows.length, count, 'active title count');
  assert.equal(new Set(rows.map(row => row.text)).size, count, 'distinct active titles');
  for (const row of rows) {
    assert.equal(row.overlapArea, 0, 'title/toggle intersection');
    assert.equal(row.titleHit, true, 'title-start hit belongs to title');
  }
}
export function acknowledgements(sends, traffic) {
  assert.equal(sends.length,5,'exact send count');
  assert.equal(new Set(sends.map(f=>f.requestId)).size,5,'unique correlation IDs');
  for(const send of sends) {
    const acks=traffic.filter(row=>row.direction==='server'&&row.frame.type==='ack'&&row.frame.command==='chat.send'&&row.frame.requestId===send.requestId);
    assert.equal(acks.length,1,`${send.requestId}: one correlated acknowledgement`);
    assert.equal(acks[0].frame.phase,undefined,'real bridge admission ack is unphased');
  }
}
// A scoped positive control, also required by the full fail-closed matrix.
// This does not waive native-keyboard/pan acceptance or accept failed run folders.
export function persistenceEvidence(manifest, result, cleanup, names) {
  const origin='http://127.0.0.1:25015',grip='.th-activity-resize';
  assert.equal(manifest.requestedPort,25015);assert.equal(manifest.port,25015);assert.equal(manifest.origin,origin);
  assert.ok(manifest.command.executable.endsWith('/bun'));
  assert.ok(manifest.command.argv[0].endsWith('/cwfix5-ui-r2.mjs'));
  assert.equal(manifest.command.argv[1],`/tmp/cwfix5-ui-r2/${manifest.runId}`);
  assert.equal(manifest.command.argv[2],manifest.dist);
  assert.equal(manifest.command.cwd,'/Volumes/storage/workspace/cli-webchat-cw5-ui');
  assert.ok(!manifest.command.argv.includes('--capture-r3'));
  assert.equal(cleanup.port,25015);assert.equal(cleanup.browserClosed,true);assert.equal(cleanup.serverStopped,true);assert.equal(cleanup.pendingWebSockets,0);
  assert.deepEqual(result.persistence.map(r=>r.order),['activity-goal','goal-activity']);
  for(const [index,r] of result.persistence.entries()) {
    const selectors=r.order.split('-').map(key=>key==='goal'?'.th-goal-bar':'.th-activity-shelf .th-activity-bar');
    const clicks=selectors.map(selector=>({method:'click',selector,complete:true}));
    assert.deepEqual(r.commands,[...clicks,{method:'focus',selector:grip,complete:true},{method:'press',selector:grip,key:'Home',complete:true},{method:'press',selector:grip,key:'End',complete:true},{method:'page.reload',complete:true},...clicks]);
    assert.equal(r.before.storageAtInit,index===0?null:'480');
    assert.equal(r.before.navigation,'navigate');assert.equal(r.end.navigation,'navigate');assert.equal(r.restored.navigation,'reload');
    assert.ok(r.before.documentId);assert.equal(r.end.documentId,r.before.documentId);
    assert.ok(r.restored.documentId&&r.restored.documentId!==r.end.documentId);
    assert.equal(r.restored.storageAtInit,'480');
    for(const [phase,value] of [['before','120'],['end','480'],['restored','480']]) {
      const row=r[phase];assert.equal(row.origin,origin);assert.equal(row.port,25015);assert.deepEqual(row.viewport,{width:1280,height:800});
      assert.equal(row.stored,value);assert.equal(row.preference,value);
      assert.ok(row.events.every(event=>event.trusted===true));
      assert.deepEqual(row.events.filter(event=>event.type==='click').map(event=>event.selector),selectors);
      const key=phase==='end'?r.order:`${r.order}-${phase}`;
      assert.equal(r.screenshots[phase],`${key}.png`);assert.ok(names.includes(r.screenshots[phase]));
      const frame=stable(result[key],key);contained(frame,key);
      assert.ok(frame['.th-chat-scrollport'].height>=119.9);
      assert.ok(frame['.th-goal-panel'].bottom<=frame['.th-activity-panel'].top);
      assert.ok(frame['.th-activity-panel'].bottom<=frame['.th-chat-input'].top);
    }
    assert.equal(r.before.focused,true);assert.equal(r.end.focused,true);
    assert.ok(r.before.events.some(event=>event.type==='focusin'&&event.selector===grip));
    assert.deepEqual(r.end.events.filter(event=>event.type==='keydown').map(({selector,key})=>({selector,key})),[{selector:grip,key:'Home'},{selector:grip,key:'End'}]);
    assert.deepEqual(r.restored.events.filter(event=>event.type==='keydown'),[]);
    assert.equal(result[`${r.order}-before`].at(-1)['.th-activity-panel'].height,120);
    assert.equal(result[`${r.order}-restored`].at(-1)['.th-activity-panel'].height,result[r.order].at(-1)['.th-activity-panel'].height);
    assert.equal(r.endWrites.length,1);
    const write=r.endWrites[0];assert.equal(write.event,'domStorageItemUpdated');assert.equal(write.key,'th-activity-panel-height');assert.equal(write.oldValue,'120');assert.equal(write.newValue,'480');
    assert.equal(write.storageId.securityOrigin,origin);assert.equal(write.storageId.isLocalStorage,true);
    assert.deepEqual(r.reloadWrites,[]);
  }
}
export async function check(directory) {
  const names = await readdir(directory);
  assert.ok(!names.some(name => /failure|failed/i.test(name)), 'failed/mixed run directory');
  const read = async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const manifest = await read('manifest.json');
  assert.equal(manifest.status, 'complete');
  assert.ok(manifest.runId && manifest.assets.length >= 3);
  const result = await read('results.json');
  persistenceEvidence(manifest,result,await read('cleanup.json'),names);
  for(const r of result.persistence)for(const name of Object.values(r.screenshots))assert.equal((await readFile(resolve(directory,name))).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  for (const order of ['activity-goal', 'goal-activity', 'resize-goal-activity']) {
    const frame = stable(result[order], order);
    contained(frame, order);
    assert.ok(frame['.th-chat-scrollport'].height >= 119.9);
    assert.ok(frame['.th-goal-panel'].bottom <= frame['.th-activity-panel'].top);
    assert.ok(frame['.th-activity-panel'].bottom <= frame['.th-chat-input'].top);
  }
  for (const order of ['goal', 'activity']) for (const floor of [48,49,50,51]) {
    for (const phase of ['plain','banner','removed']) {
      const key = `floor-${order}-${floor}-${phase}`;
      const frame = stable(result[key], key);
      assert.equal(frame['.th-activity-panel'], null, key);
      assert.equal(frame['.th-goal-panel'], null, key);
    }
  }
  for (const key of ['short-1280','short-320','short-dynamic','short-recovery','restore-short','restore-grown','growth-home','growth-up','short-goal']) {
    const frame = stable(result[key], key);
    contained(frame,key);
  }
  assert.equal(result['growth-home'].at(-1)['.th-activity-panel'].height,120);
  assert.equal(result['growth-up'].at(-1)['.th-activity-panel'].height,144);
  assert.equal(result.savedAfterRestore,'480');
  assert.ok(result['restore-grown'].at(-1)['.th-activity-panel'].height > 180);
  assert.ok(result['short-goal'].at(-1)['.th-goal-panel'].height > 0);
  assert.ok(result['short-dynamic'].at(-1)['.th-chat-main-content'].scrollHeight > result['short-dynamic'].at(-1)['.th-chat-main-content'].height);
  assert.equal(result.recoveredDraftLines,8);
  assert.deepEqual(result.reachableControls,['queue-clear','banner-dismiss','stop']);
  for (const state of ['expanded','collapsed']) {
    titles(result[`single-${state}`],1);
    titles(result[`split-${state}`],2);
    splitReady(result[`split-${state}-rows`]);
  }
  assert.deepEqual(result.splitIndependent,[true,true]);
  splitReady(result['split-independent-rows']);
  assert.equal(result.emptyMessages,0);
  assert.equal(result.emptyGoals,0);
  const unavailable=[];
  for (const width of [375,320]) {
    const r = result[`model-${width}`];
    catalogReady(r);
    assert.equal(r.initialInputFocus,false);
    assert.equal(r.initialSelected,'glm-zcode');
    assert.equal(r.navigationSelected,r.initialSelected);
    assert.equal(r.currentVisible,true);
    assert.deepEqual(r.traversal,{close:true,thinking:true,search:true,reverse:true});
    assert.equal(r.escapeRestored,true);
    assert.equal(r.closeRestored,true);
    assert.equal(r.selectedProvider,'other-provider');
    assert.equal(r.selectedModel,'Alternate QA model');
    assert.deepEqual(r.catalog.map(row=>row.phase),['equivalent-search','reordered-thinking','equivalent-thinking']);
    for(const row of r.catalog){
      assert.equal(row.before.query,'Catalog model');
      assert.equal(row.before.focus,row.phase==='equivalent-search'?'search':'thinking');
      assert.ok(row.before.active);
      assert.deepEqual(row.after,row.before,`${row.phase}: catalog replacement changed query/focus/identity`);
    }
    assert.equal(r.commands.length,1);
    assert.deepEqual(r.commands[0].model,{provider:'other-provider',modelId:'alternate-qa'});
    assert.ok(r.viewport.after.height < r.viewport.before.height);
    if (!r.viewport.visualOnly || !(r.viewport.pan.offsetTop > 0 || r.viewport.pan.offsetLeft > 0)) unavailable.push(width);
    assert.equal(r.touch,true);
    assert.equal(r.viewport.contained,true);
  }
  assert.deepEqual(result.queueRestored,['queue-a','queue-b','queue-c']);
  assert.deepEqual(result.queueReordered,['queue-b','queue-a','queue-c']);
  assert.deepEqual(result.queueRemoved,['queue-b','queue-a']);
  assert.deepEqual(result.queueFlushed,['queue-a']);
  assert.equal(result.steerPending,true);
  assert.equal(result.correlatedMessages,1);
  assert.deepEqual(result.skills,{live:1,restored:1});
  assert.equal(result.adoptedRows,1);
  const traffic = await read('traffic.json');
  const commands = traffic.filter(row => row.direction === 'client').map(row => row.frame);
  assert.equal(commands.filter(f=>f.type==='chat.set' && f.model).length,2);
  for (const type of ['chat.queue.move','chat.queue.remove','chat.queue.clear','chat.abort']) assert.equal(commands.filter(f=>f.type===type).length,1,`exact ${type} count`);
  const queued=traffic.filter(row=>row.direction==='server'&&row.frame.type==='queue').flatMap(row=>row.frame.items);
  const move=commands.find(f=>f.type==='chat.queue.move');
  assert.equal(move.toIndex,0);assert.ok(queued.some(item=>item.id===move.itemId&&item.text==='queue-b'));
  const remove=commands.find(f=>f.type==='chat.queue.remove');assert.ok(queued.some(item=>item.id===remove.itemId&&item.text==='queue-c'));
  assert.equal(commands.find(f=>f.type==='chat.queue.clear').scope,'all');
  const creates=traffic.filter(row=>row.method==='POST'&&row.path.endsWith('/chats'));
  assert.equal(creates.length,1);assert.deepEqual(creates[0].body,{name:'',provider:'omo'});
  const opens=traffic.filter(row=>row.method==='POST'&&row.path.endsWith('/sessions/open'));
  assert.equal(opens.length,1);assert.deepEqual(opens[0].body,{id:'qa-wish-source',resumeIdentity:'/qa/disposable/wish-session.jsonl'});
  acknowledgements(commands.filter(f=>f.type==='chat.send'), traffic);
  assert.deepEqual(await read('errors.json'),[]);
  const cleanup=await read('cleanup.json');
  assert.equal(cleanup.browserClosed,true); assert.equal(cleanup.serverStopped,true); assert.equal(cleanup.pendingWebSockets,0);
  assert.deepEqual(unavailable,[], 'BLOCKED: visual-only viewport shrink and nonzero pan unavailable; viewport resize alone is not keyboard/pan evidence');
  return manifest.runId;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`GREEN ${await check(resolve(process.argv[2]))}: complete R2 browser matrix (frontend fixture channel only)`);
}
