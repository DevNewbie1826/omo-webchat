/** Combined QA entry point: built App only; observable events, no polling/sleeps. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startFixture } from "./pane-workspace-ui.mjs";
import { sessionAndShellScenarios } from "./pane-workspace-sessions.mjs";
import { composerAndPersistenceScenarios } from "./pane-workspace-composer.mjs";
import { sessionContinuityScenarios } from "./pane-workspace-continuity.mjs";
export async function run(evidence) {
  await mkdir(evidence, { recursive: true });
  const fixture = startFixture({ port: 0 }), results = [], errors = [], screenshots = [];
  const save = (name, value) => writeFile(resolve(evidence, name), JSON.stringify(value, null, 2) + "\n");
  let browser, view, page;
  const cleanup = { url: fixture.url };
  try {
    // Built-in default first: real WebKit runtime, disposable data store.
    view = new Bun.WebView({ width: 1440, height: 900 });
    await view.navigate(fixture.url);
    const rendered = await view.evaluate(`new Promise((done, fail) => {
      const timer = setTimeout(() => { observer.disconnect(); fail(new Error('App readiness deadline')); }, 8000);
      const observer = new MutationObserver(check);
      function check() { if(document.querySelector('.th-model-picker-btn') && document.querySelector('.th-picker-pane-item')) {
        observer.disconnect(); clearTimeout(timer); done({title:document.querySelector('.th-termhead-name').textContent,
          userAgent:navigator.userAgent, panes:document.querySelectorAll('.th-pane-wrap').length}); } }
      observer.observe(document, {subtree:true,childList:true});check();
    })`);
    assert.equal(rendered.title, "Stored A"); assert.equal(rendered.panes, 2);
    await Bun.write(resolve(evidence, "webview-desktop.png"), await view.screenshot());
    screenshots.push("webview-desktop.png"); results.push({ scenario: "built-in-webview-actual-app", pass: true, ...rendered });
    await view.close(); view = undefined; cleanup.webViewClosed = true;
    // Chrome supplies deterministic keyboard, drag and upload automation using the existing driver.
    const { chromium } = await import(process.env.QA_PLAYWRIGHT);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    async function reset(seed = {}, viewport = { width: 1440, height: 900 }) {
      if (page) await page.close();
      fixture.reset(seed);
      page = await browser.newPage({ viewport }); page.setDefaultTimeout(8000);
      page.on("pageerror", error => errors.push(String(error)));
      await page.addInitScript(lang => {
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          set onmessage(handler) {
            super.onmessage = handler ? event => {
              handler.call(this, event);
              window.dispatchEvent(new CustomEvent('qa:wire', { detail: JSON.parse(event.data) }));
            } : null;
          }
        };
        localStorage.setItem("th-lang", lang); localStorage.setItem("th-ws-expanded", '["ws"]');
        window.qaSignal = predicate => new Promise((done, fail) => {
          const timer = setTimeout(() => { mo.disconnect(); ro.disconnect(); fail(new Error("DOM/geometry deadline")); }, 8000);
          const mo = new MutationObserver(check), ro = new ResizeObserver(check);
          function check() { if (predicate()) { clearTimeout(timer); mo.disconnect(); ro.disconnect(); done(true); } }
          mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          ro.observe(document.documentElement); check();
        });
      }, seed.lang ?? "en");
      await page.goto(fixture.url);
      await page.evaluate(() => window.qaSignal(() => !!document.querySelector('.th-tree-activation')));
      return page;
    }
    const arm = predicate => page.evaluate(source => { window.qaPending = window.qaSignal(new Function(`return (${source})`)()); }, String(predicate));
    const done = () => page.evaluate(() => window.qaPending);
    const shot = async name => { await page.screenshot({ path: resolve(evidence, name) }); screenshots.push(name); };
    async function scenario(name, action) {
      try { const detail = await action(); results.push({ scenario: name, pass: true, detail }); }
      catch (error) { results.push({ scenario: name, pass: false, error: String(error), stack: error.stack }); }
    }
    const armWire = command => page.evaluate(command => {
      window.qaWire = new Promise((done, fail) => {
        const timer = setTimeout(() => { window.removeEventListener('qa:wire', listener); fail(new Error('Wire ack deadline')); }, 8000);
        function listener(event) { if (event.detail.type === 'ack' && event.detail.command === command) {
          clearTimeout(timer); window.removeEventListener('qa:wire', listener); done(event.detail);
        } }
        window.addEventListener('qa:wire', listener);
      });
    }, command);
    const wireDone = () => page.evaluate(() => window.qaWire);
    const context = { fixture, reset, arm, done, armWire, wireDone, shot, scenario, save, get page() { return page; } };
    await sessionAndShellScenarios(context);
    await sessionContinuityScenarios(context);
    await composerAndPersistenceScenarios(context);
    assert.deepEqual(errors, []); assert.deepEqual(fixture.unexpected, []);
  } catch (error) { results.push({ scenario: "runner", pass: false, error: String(error), stack: error.stack }); }
  finally {
    if (view) { await view.close(); cleanup.webViewClosed = true; }
    if (browser) { await browser.close(); cleanup.chromeClosed = true; }
    Object.assign(cleanup, await fixture.stop());
    await save("browser-regression.json", results); await save("screenshots.json", screenshots);
    await save("traffic.json", { requests: fixture.requests, frames: fixture.frames, unexpected: fixture.unexpected });
    await save("errors.json", errors); await save("cleanup.json", cleanup);
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.pass)) process.exitCode = 1;
}
