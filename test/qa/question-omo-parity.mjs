/** Browser QA for the omo question-tool parity flow (plan todo 6,
 * .omo/plans/question-tool-omo-parity.md "Success criteria" catalogue).
 *
 * Drives the REAL built SPA (frontend/dist) through the pane-workspace-ui
 * fixture (actual HTTP/WS) with Chromium from test/qa/qa-driver.mjs, dark +
 * ko, and asserts both the captured WS frames and the DOM for every Q*
 * scenario: Q1, Q1-phone, Q2..Q15 (the L* rows are the live real-omo recipe,
 * node 7 — not this file).
 *
 * CLI: QA_PLAYWRIGHT=<playwright-core index.mjs> \
 *      bun test/qa/question-omo-parity.mjs [Q1,Q2|all] [evidenceDir]
 * Suite: bun test --isolate test/qa/question-omo-parity.test.mjs (never
 * --parallel; one shared browser, one context per scenario).
 *
 * Time discipline: every wait is a DOM/frame signal. The only fixed waits
 * live in Q7 where the 1000ms draft throttle itself is the behaviour under
 * test (input cadence + one post-send observation window), as the plan's Q7
 * row prescribes ("frames at ~1s and ~2s, none after Send").
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SESSION = 'stored-a';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const PHONE_VIEWPORT = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_EVIDENCE = resolve(import.meta.dir, '../../.omo/evidence/question-omo-parity');

/** Shared chromium (one browser per process, machine-friendly). */
let sharedBrowser = null;
export async function acquireBrowser(chromium) {
  if (sharedBrowser === null) sharedBrowser = await chromium.launch({ executablePath: CHROME, headless: true });
  return sharedBrowser;
}
export async function releaseBrowser() {
  if (sharedBrowser === null) return { browserClosed: false };
  const browser = sharedBrowser;
  sharedBrowser = null;
  await browser.close();
  return { browserClosed: true };
}

const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const outgoing = (fixture, match) => fixture.frames.filter(match);

/** ko strings the scenarios assert (i18n/locales/ko.json via useT). */
const KO = {
  replyLabel: header => `↳ ${header}에 답하기`,
  sending: '보내는 중...',
  unconfirmed: '전달을 확인하지 못했어요. 다시 보내 주세요.',
  resend: '다시 보내기',
  noLongerPending: '그 질문은 이미 끝났어요',
  pendingCount: count => `질문 ${count}개 대기 중`,
  next: '다음 질문',
  sendAsMessage: '일반 메시지로 보내기',
  toolWait: '답을 기다림',
  noAnswer: '(답 없음)',
  alreadyResolved: '이 질문은 이미 답했거나 닫혔어요.',
  closedWhileDisconnected: '연결이 끊긴 사이 이 질문이 끝났어요. 답이 전달되지 않았을 수 있어요.',
  submit: '보내기',
};

/** Scenario chrome: one fixture + one context + one page per scenario. */
async function boot({ chromium, scenario, evidenceDir, viewport, touch = false, seed = {} }) {
  const { startFixture } = await import('./pane-workspace-ui.mjs');
  // controlled: true keeps sends held (frames still captured) and answers
  // pings with pong, so fixture.unexpected stays meaningful.
  const fixture = startFixture({ port: 0, layout: 'single', controlled: true, ...seed });
  const browser = await acquireBrowser(chromium);
  const context = await browser.newContext({
    viewport, hasTouch: touch, isMobile: touch, locale: 'ko-KR', colorScheme: 'dark',
  });
  await context.addInitScript(() => {
    localStorage.setItem('th-theme', 'dark');
    localStorage.setItem('th-lang', 'ko');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const kit = {
    scenario, evidenceDir, fixture, context, page, errors,
    async goto(target = page) {
      const created = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === SESSION);
      await target.goto(fixture.url);
      await created;
      await domOn(target, `() => !!document.querySelector('.th-chat-pane .th-chat-input textarea')`);
    },
    deliver(frame) { fixture.deliver(SESSION, frame); },
    async deliverAndWait(frame, predicate, timeout) {
      kit.deliver(frame);
      await domOn(page, predicate, timeout);
    },
    shot(name, target = page) {
      return target.screenshot({ path: join(evidenceDir, 'qa', `${scenario}-${name}.png`) });
    },
  };
  return kit;
}

async function domOn(target, predicate, timeout = 20_000) {
  await target.waitForFunction(predicate, undefined, { timeout });
}

const composer = kit => kit.page.locator('.th-chat-pane .th-chat-input textarea');
const windowSubmit = kit => kit.page.locator('.th-question-window .th-btn--primary');
const replies = kit => outgoing(kit.fixture, frame => frame.type === 'approval.respond');
const progresses = kit => outgoing(kit.fixture, frame => frame.type === 'approval.progress');

/** A question frame as the Go dispatch now maps the engine request. */
const question = (id, extra = {}) => ({
  type: 'approval', id, method: 'question', title: extra.title ?? 'QA 질문',
  ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
  ...(extra.nonBlocking !== undefined ? { nonBlocking: extra.nonBlocking } : {}),
  ...(extra.delivery !== undefined ? { delivery: extra.delivery } : {}),
  ...(extra.deliveryError !== undefined ? { deliveryError: extra.deliveryError } : {}),
  ...(extra.submittedAnswer !== undefined ? { submittedAnswer: extra.submittedAnswer } : {}),
  questions: extra.questions ?? [{
    header: 'QA1', question: '하나 고르세요', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  }],
});
const resolved = (id, outcome = 'answered') => ({ type: 'approval.resolved', id, outcome });

// ---------------------------------------------------------------------------
// Scenarios (plan "Success criteria" catalogue, in order).
// ---------------------------------------------------------------------------

/** Q1 non-blocking: composer typing answers; label visible before Enter. */
async function q1(kit, { viewport = DESKTOP_VIEWPORT, touch = false } = {}) {
  const { page, fixture } = kit;
  await kit.deliverAndWait(question('q-nb', { nonBlocking: true, requestId: 'req-nb' }),
    `() => !!document.querySelector('.th-question-band')`);
  await composer(kit).click();
  await page.keyboard.type('hello', { delay: 20 });
  await domOn(page, `() => (document.querySelector('.th-chat-reply-label-text')?.textContent ?? '').includes(${JSON.stringify(KO.replyLabel('QA1'))})`);
  await kit.shot('reply-label');
  const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.comment === 'hello');
  if (touch) await page.tap('.th-chat-send-btn');
  else await page.keyboard.press('Enter');
  const frame = await responded;
  assert.equal(frame.sessionId, SESSION);
  assert.equal(frame.id, 'q-nb');
  assert.ok(deep(frame.answers ?? {}, {}), `answers must be empty, got ${JSON.stringify(frame.answers)}`);
  assert.ok(outgoing(fixture, f => f.type === 'chat.send').length === 0, 'no chat.send while answering');
  await kit.shot('after-answer');
}

const scenarios = {};

scenarios['Q1'] = {
  title: 'non-blocking question: composer types the answer, Enter sends approval.respond only',
  viewport: DESKTOP_VIEWPORT,
  run: q1,
};

scenarios['Q1-phone'] = {
  title: 'non-blocking question on a 390x844 touch phone: the send button answers',
  viewport: PHONE_VIEWPORT,
  touch: true,
  run: kit => q1(kit, { viewport: PHONE_VIEWPORT, touch: true }),
};

scenarios['Q2'] = {
  title: 'slash/bang text and Alt+Enter always send as chat.send, never as an answer',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    await kit.deliverAndWait(question('q-esc', { nonBlocking: true, requestId: 'req-esc' }),
      `() => !!document.querySelector('.th-question-band')`);
    for (const [text, key] of [['/help', 'Enter'], ['!ls', 'Enter'], ['hi', 'Alt+Enter']]) {
      await composer(kit).click();
      await page.keyboard.type(text, { delay: 15 });
      if (text === 'hi') {
        // 'hi' legitimately routes the composer to the question (IS-4);
        // Alt+Enter is the bypass that must still send it as a message.
        await domOn(page, `() => !!document.querySelector('.th-chat-reply-label')`);
      } else {
        assert.ok(await page.locator('.th-chat-reply-label').count() === 0,
          `${text} must never route the composer to the question`);
      }
      const sent = fixture.wait('frame', frame => frame.type === 'chat.send' && frame.run?.message === text);
      await page.keyboard.press(key);
      await sent;
      // The plan's Q2 only demands the chat.send path (never an answer);
      // the mid-run steer branch is Q4's job.
    }
    assert.ok(replies(kit).length === 0, 'no approval.respond for / ! or Alt+Enter text');
    await kit.shot('escape-hatches');
  },
};

scenarios['Q3'] = {
  title: 'digit 2 in the empty composer opens the window with option 2 picked',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page } = kit;
    await kit.deliverAndWait(question('q-digit', { nonBlocking: true, requestId: 'req-digit' }),
      `() => !!document.querySelector('.th-question-band')`);
    await composer(kit).click();
    await page.keyboard.press('2');
    await domOn(page, `() => !!document.querySelector('.th-question-window')`);
    const pressed = await page.locator('.th-question-window button[aria-pressed="true"]').allTextContents();
    assert.deepEqual(pressed.filter(text => text.trim().length > 0), ['B']);
    assert.equal(await composer(kit).inputValue(), '', 'the digit never inserts into the composer');
    await kit.shot('digit-shortcut');
  },
};

scenarios['Q4'] = {
  title: 'blocking question while running: no Stop, Esc never aborts, steer sends a message, Enter answers',
  viewport: DESKTOP_VIEWPORT,
  seed: { running: [SESSION] },
  async run(kit) {
    const { page, fixture } = kit;
    await kit.deliverAndWait(question('q-block4', { requestId: 'req-block4' }),
      `() => !!document.querySelector('.th-question-window')`);
    assert.ok(await page.locator('.th-chat-send-btn.th-btn--danger').count() === 0,
      'the send slot must not show Stop while a blocking question is pending');
    const steer = page.locator('.th-chat-steer-btn');
    assert.ok((await steer.textContent()).includes(KO.sendAsMessage), 'steer button is the send-as-message control');
    // Collapse the modal window (IS-3: the blocking window keeps the
    // composer as its answer surface while collapsed).
    await page.locator('.th-modal-backdrop').click({ position: { x: 8, y: 8 } });
    await domOn(page, `() => !document.querySelector('.th-question-window')`);
    await composer(kit).click();
    await page.keyboard.press('Escape');
    await page.keyboard.type('그냥 메시지', { delay: 15 });
    // The steer frame's arrival proves the Escape keydown was processed.
    const steered = fixture.wait('frame', frame => frame.type === 'chat.send' && frame.run?.kind === 'steer');
    await steer.click();
    const steeredFrame = await steered;
    assert.equal(steeredFrame.run.message, '그냥 메시지');
    assert.ok(outgoing(fixture, frame => frame.type === 'chat.abort').length === 0,
      'Esc in the composer must not abort while a blocking question is pending');
    await composer(kit).click();
    await page.keyboard.type('찬성', { delay: 15 });
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.comment === '찬성');
    await page.keyboard.press('Enter');
    assert.equal((await responded).id, 'q-block4');
    await kit.shot('blocking-no-abort');
  },
};

scenarios['Q5'] = {
  title: 'delivery: sending disables inputs, failed restores the draft, resolved closes with no error',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    const base = question('q-deliv', { requestId: 'req-deliv' });
    await kit.deliverAndWait(base, `() => !!document.querySelector('.th-question-window')`);
    await page.locator('.th-question-window').getByRole('button', { name: 'A', exact: true }).click();
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'q-deliv');
    await windowSubmit(kit).click();
    const sent = await responded;
    assert.ok(deep(sent.answers, { q1: { selected: ['A'] } }), `unexpected answers ${JSON.stringify(sent.answers)}`);
    await domOn(page, `() => !!document.querySelector('.th-question-window .th-question-delivery--sending')`);
    assert.ok((await page.locator('.th-question-window .th-question-delivery--sending').textContent()).includes(KO.sending));
    assert.ok(await windowSubmit(kit).isDisabled(), 'Send is disabled while delivering');
    await kit.shot('sending');
    const failed = { ...base, delivery: 'failed', deliveryError: 'unconfirmed',
      submittedAnswer: { answers: { q1: { selected: ['A'] } } } };
    await kit.deliverAndWait(failed, `() => !!document.querySelector('.th-question-window .th-question-delivery--failed')`);
    assert.ok((await page.locator('.th-question-window .th-question-delivery-error').textContent()).includes(KO.unconfirmed));
    const pressed = await page.locator('.th-question-window button[aria-pressed="true"]').allTextContents();
    assert.deepEqual(pressed.filter(text => text.trim().length > 0), ['A'], 'the draft survives the failed delivery');
    assert.equal(replies(kit).length, 1, 'a second click sends nothing');
    await kit.deliverAndWait(resolved('q-deliv'), `() => !document.querySelector('.th-question-window') && !document.querySelector('.th-question-band')`);
    assert.ok(await page.locator('.th-send-error-banner').count() === 0, 'no error banner on a clean resolve');
    // The closed notice intentionally appears when a FAILED question ends
    // without a resend ("answered or closed elsewhere") — that behaviour is
    // asserted positively in Q14; the plan's Q5 demands only the clean close.
    await kit.shot('resolved');
  },
};

scenarios['Q6'] = {
  title: 'two pending questions: count, next control, resolving the first shows the second',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page } = kit;
    await kit.deliverAndWait(question('q6a', { requestId: 'req-q6a', title: '첫 질문' }),
      `() => !!document.querySelector('.th-question-window')`);
    await kit.deliverAndWait(question('q6b', { requestId: 'req-q6b', title: '두 번째 질문' }),
      `() => (document.querySelector('.th-question-pending-count')?.textContent ?? '').includes(${JSON.stringify(KO.pendingCount(2))})`);
    await kit.shot('two-pending');
    await page.locator('.th-question-window .th-question-pending-next').click();
    await domOn(page, `() => (document.querySelector('.th-question-window-title')?.textContent ?? '').includes('두 번째 질문')`);
    await kit.deliverAndWait(resolved('q6a'),
      `() => (document.querySelector('.th-question-window-title')?.textContent ?? '').includes('두 번째 질문') && !document.querySelector('.th-question-pending-count')`);
    await kit.deliverAndWait(resolved('q6b'), `() => !document.querySelector('.th-question-window') && !document.querySelector('.th-question-band')`);
    await kit.shot('resolved-in-order');
  },
};

scenarios['Q7'] = {
  title: 'draft progress is throttled like omo: frames at ~1s/~2s with the latest text, none after Send',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    await kit.deliverAndWait(question('q-prog', { requestId: 'req-prog' }),
      `() => !!document.querySelector('.th-question-window')`);
    // Input cadence 300ms (9 chars over ~2.7s) against the 1000ms throttle:
    // time itself is the behaviour under test here (plan Q7).
    const comment = page.locator('.th-question-window .th-approval-question-comment');
    const second = fixture.wait('frame', frame => frame.type === 'approval.progress'
      && typeof frame.comment === 'string' && frame.comment.length >= 6);
    for (const char of 'drafttext') {
      await comment.pressSequentially(char, { delay: 0 });
      await page.waitForTimeout(300);
    }
    await second;
    let observed = progresses(kit).filter(frame => frame.id === 'q-prog');
    assert.equal(observed.length, 2, `expected exactly 2 throttled frames, got ${JSON.stringify(observed.map(f => f.comment))}`);
    assert.ok(observed.every(frame => 'drafttext'.startsWith(frame.comment) && frame.comment.length > 0),
      `each frame carries a latest draft prefix: ${JSON.stringify(observed.map(f => f.comment))}`);
    assert.ok(observed[1].comment.length > observed[0].comment.length, 'the later frame carries the later draft');
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'q-prog');
    await windowSubmit(kit).click();
    await responded;
    // Observation window: an uncancelled 1000ms timer would fire here.
    await page.waitForTimeout(1300);
    observed = progresses(kit).filter(frame => frame.id === 'q-prog');
    assert.equal(observed.length, 2, `no progress after Send: ${JSON.stringify(observed.map(f => f.comment))}`);
    await kit.deliverAndWait(resolved('q-prog'), `() => !document.querySelector('.th-question-window')`);
    assert.equal(progresses(kit).filter(frame => frame.id === 'q-prog').length, 2);
    await kit.shot('throttle');
  },
};

scenarios['Q8'] = {
  title: 'answer frames render as chips (plain, timeout body, steer), never as user bubbles',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page } = kit;
    const args = { questions: [{ header: 'QA1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] }], waitForAnswer: true };
    await kit.deliverAndWait({ type: 'tool', toolCallId: 'toolu_q8', toolName: 'ask_user_question', phase: 'start', args },
      `() => !!document.querySelector(".th-tool[data-tool-call-id='toolu_q8']")`);
    await kit.deliverAndWait({
      type: 'message',
      message: { role: 'user', blocks: [{ kind: 'text', text: '[Answer to question toolu_q8]\nQA1: A' }] },
    }, `() => !!document.querySelector('.th-ask-answer')`);
    assert.ok((await page.locator('.th-ask-answer').first().textContent()).includes('↳ QA1: A'));
    assert.ok(await page.locator('.th-chat-msg--user', { hasText: 'Answer to question' }).count() === 0,
      'the answer frame must not render as the user bubble');
    await kit.deliverAndWait({ type: 'tool', toolCallId: 'toolu_q8t', toolName: 'ask_user_question', phase: 'start', args },
      `() => !!document.querySelector(".th-tool[data-tool-call-id='toolu_q8t']")`);
    await kit.deliverAndWait({
      type: 'message',
      message: { role: 'user', blocks: [{ kind: 'text', text: '[Answer to question toolu_q8t]\nThe user did not answer the question before the deadline.' }] },
    }, `() => document.querySelectorAll('.th-ask-answer').length >= 2`);
    assert.ok((await page.locator('.th-ask-answer').nth(1).textContent()).includes(`↳ QA1: ${KO.noAnswer}`),
      'a timeout body renders the localized no-answer row');
    await kit.deliverAndWait({
      type: 'message',
      message: { role: 'user', customType: 'steer', blocks: [{ kind: 'text', text: '[Answer to question toolu_q8]\nQA1: A (steer)' }] },
    }, `() => document.querySelectorAll('.th-ask-answer').length >= 3`);
    assert.ok(await page.locator('.th-chat-steer-text', { hasText: 'Answer to question' }).count() === 0,
      'the steer-delivered answer frame must not render as a steer bubble');
    const chip = page.locator('.th-ask-answer').nth(2);
    await chip.locator('.th-ask-answer-toggle').click();
    await domOn(page, `() => !!document.querySelector('.th-ask-answer-body')`);
    assert.ok((await page.locator('.th-ask-answer-body').last().textContent()).includes('QA1: A (steer)'),
      'expanding shows the full verbatim body');
    await kit.shot('answer-chips');
  },
};

scenarios['Q9'] = {
  title: 'the question ending mid-reply leaves the text with the no-longer-pending notice',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page } = kit;
    await kit.deliverAndWait(question('q9', { nonBlocking: true, requestId: 'req-q9' }),
      `() => !!document.querySelector('.th-question-band')`);
    await composer(kit).click();
    await page.keyboard.type('임시 답변', { delay: 15 });
    await domOn(page, `() => !!document.querySelector('.th-chat-reply-label')`);
    await kit.deliverAndWait(resolved('q9'),
      `() => !document.querySelector('.th-chat-reply-label') && !!document.querySelector('.th-chat-reply-ended')`);
    assert.ok((await page.locator('.th-chat-reply-ended').textContent()).includes(KO.noLongerPending));
    assert.equal(await composer(kit).inputValue(), '임시 답변', 'the text is kept');
    await kit.shot('no-longer-pending');
  },
};

scenarios['Q10'] = {
  title: 'without a pending question Stop and Esc abort exactly as before; select approvals still answer',
  viewport: DESKTOP_VIEWPORT,
  seed: { running: [SESSION] },
  async run(kit) {
    const { page, fixture } = kit;
    assert.ok(await page.locator('.th-chat-send-btn.th-btn--danger').count() === 1, 'Stop renders while running');
    const aborted = fixture.wait('frame', frame => frame.type === 'chat.abort');
    await composer(kit).click();
    await page.keyboard.press('Escape');
    await aborted;
    await kit.deliverAndWait({ type: 'approval', id: 'ap-sel', method: 'select', title: '하나 선택', options: ['첫째', '둘째'] },
      `() => !!document.querySelector('.th-modal-overlay')`);
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'ap-sel');
    await page.locator('.th-modal-overlay').getByRole('button', { name: '둘째', exact: true }).click();
    assert.equal((await responded).value, '둘째');
    await domOn(page, `() => !document.querySelector('.th-modal-overlay') && !document.querySelector('.th-question-band')`);
    await kit.shot('approvals-unchanged');
  },
};

scenarios['Q11'] = {
  title: 'the ask_user_question tool row shows headers + wait while running and the result summary when done',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page } = kit;
    const args = { questions: [{ header: 'QA1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] }], waitForAnswer: true };
    const head = `.th-tool[data-tool-call-id='toolu_q11'] .th-tool-head`;
    await kit.deliverAndWait({ type: 'tool', toolCallId: 'toolu_q11', toolName: 'ask_user_question', phase: 'start', args },
      `() => !!document.querySelector(${JSON.stringify(head)})`);
    assert.ok((await page.locator(head).textContent()).includes('[QA1]'));
    assert.ok((await page.locator(head).textContent()).includes(KO.toolWait));
    await kit.shot('tool-running');
    await kit.deliverAndWait({
      type: 'tool', toolCallId: 'toolu_q11', toolName: 'ask_user_question', phase: 'end', args, isError: false,
      result: { content: [{ text: 'QA1: A' }], details: { status: 'answered', answers: { pick: 'A' }, unanswered: [] } },
    }, `() => (document.querySelector(${JSON.stringify(head)})?.textContent ?? '').includes('answered; 1 answered; 0 unanswered')`);
    await kit.shot('tool-done');
  },
};

scenarios['Q12'] = {
  title: 'a free-text-only answer sends and reports {selected:[], text} on the wire',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    await kit.deliverAndWait(question('q-free', { requestId: 'req-free' }),
      `() => !!document.querySelector('.th-question-window')`);
    const progressed = fixture.wait('frame', frame => frame.type === 'approval.progress'
      && frame.answers?.q1?.text === '직접 쓴 답');
    await page.locator('.th-question-window .th-approval-question-text').pressSequentially('직접 쓴 답', { delay: 20 });
    const progressFrame = await progressed;
    assert.ok(deep(progressFrame.answers, { q1: { selected: [], text: '직접 쓴 답' } }),
      `progress must normalize the empty selection: ${JSON.stringify(progressFrame.answers)}`);
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'q-free');
    await windowSubmit(kit).click();
    assert.ok(deep((await responded).answers, { q1: { selected: [], text: '직접 쓴 답' } }),
      'the response must normalize the empty selection exactly like the progress');
    await kit.shot('free-text');
  },
};

scenarios['Q13'] = {
  title: 'a lost composer answer restores after failure and reload, and resend writes exactly once',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    const base = question('q-loss', { nonBlocking: true, requestId: 'req-loss' });
    const failed = { ...base, delivery: 'failed', deliveryError: 'unconfirmed',
      submittedAnswer: { answers: {}, comment: 'from composer' } };
    await kit.deliverAndWait(base, `() => !!document.querySelector('.th-question-band')`);
    await composer(kit).click();
    await page.keyboard.type('from composer', { delay: 15 });
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.comment === 'from composer');
    await page.keyboard.press('Enter');
    await responded;
    await kit.deliverAndWait(failed, `() => !!document.querySelector('.th-question-band .th-question-delivery--failed')`);
    await page.locator('.th-question-band-open').click();
    await domOn(page, `() => !!document.querySelector('.th-question-window .th-question-delivery--failed')`);
    assert.equal(await page.locator('.th-question-window .th-approval-question-comment').inputValue(), 'from composer',
      'the submitted comment is restored into the draft');
    assert.ok((await page.locator('.th-question-delivery-resend').first().textContent()).includes(KO.resend));
    await kit.shot('failed-restored');
    fixture.setAttachReplay(SESSION, [failed, { type: 'questions.snapshot', ids: ['req-loss'] }]);
    const reattached = fixture.wait('frame', frame => frame.type === 'chat.create' && frame.chatId === SESSION);
    await page.reload();
    await reattached;
    await domOn(page, `() => !!document.querySelector('.th-question-band .th-question-delivery--failed')`);
    await page.locator('.th-question-band-open').click();
    await domOn(page, `() => !!document.querySelector('.th-question-window .th-question-delivery--failed')`);
    assert.equal(await page.locator('.th-question-window .th-approval-question-comment').inputValue(), 'from composer',
      'the failed state and comment survive the reload');
    await kit.shot('after-reload');
    assert.equal(replies(kit).filter(frame => frame.comment === 'from composer').length, 1, 'one write before the resend');
    const resent = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.comment === 'from composer');
    await page.locator('.th-question-window .th-question-delivery-resend').click();
    await resent;
    assert.equal(replies(kit).filter(frame => frame.comment === 'from composer').length, 2, 'the resend writes exactly once more');
    await kit.deliverAndWait(resolved('q-loss'), `() => !document.querySelector('.th-question-window') && !document.querySelector('.th-question-band')`);
  },
};

scenarios['Q14'] = {
  title: 'an id re-issue keeps one question with its draft; a failed question ending elsewhere shows its notice',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture } = kit;
    const base = {
      type: 'approval', id: 'q-a', method: 'question', title: '재발급 질문', requestId: 'req-r',
      questions: [{ header: 'QA1', question: '직접 답하기', options: [{ label: 'A' }, { label: 'B' }] }],
    };
    await kit.deliverAndWait(base, `() => !!document.querySelector('.th-question-window')`);
    await page.locator('.th-question-window .th-approval-question-text').pressSequentially('직접 답', { delay: 20 });
    const responded = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'q-a');
    await windowSubmit(kit).click();
    await responded;
    const reissued = { ...base, id: 'q-b', delivery: 'failed', deliveryError: 'unconfirmed',
      submittedAnswer: { answers: { q1: { selected: [], text: '직접 답' } } } };
    await kit.deliverAndWait(reissued, `() => !!document.querySelector('.th-question-window .th-question-delivery--failed')`);
    assert.ok(await page.locator('.th-question-window').count() === 1, 'the re-issue replaces, it never duplicates');
    assert.ok(await page.locator('.th-question-pending-count').count() === 0, 'exactly one question stays pending');
    assert.equal(await page.locator('.th-question-window .th-approval-question-text').inputValue(), '직접 답',
      'the typed draft survives the id re-issue');
    await kit.shot('reissued');
    const other = { type: 'approval', id: 'q-other', method: 'question', title: '다른 질문', requestId: 'req-other',
      questions: [{ header: 'QA2', question: '고르기', options: [{ label: 'X' }] }] };
    await kit.deliverAndWait(other, `() => (document.querySelector('.th-question-pending-count')?.textContent ?? '').includes(${JSON.stringify(KO.pendingCount(2))})`);
    await kit.deliverAndWait({ ...other, delivery: 'failed', deliveryError: 'unconfirmed' },
      `() => !!document.querySelector('.th-question-window .th-question-delivery--failed')`);
    await kit.deliverAndWait(resolved('q-other', 'closed_while_disconnected'),
      `() => !!document.querySelector('.th-question-closed-notice')`);
    assert.ok((await page.locator('.th-question-closed-notice').textContent()).includes(KO.alreadyResolved));
    const resent = fixture.wait('frame', frame => frame.type === 'approval.respond' && frame.id === 'q-b');
    await page.locator('.th-question-window .th-question-delivery-resend').click();
    const resentFrame = await resent;
    assert.ok(deep(resentFrame.answers, { q1: { selected: [], text: '직접 답' } }),
      `the resend carries the submitted answer under the NEW id: ${JSON.stringify(resentFrame)}`);
    await kit.shot('closed-notice');
  },
};

scenarios['Q15'] = {
  title: 'a question that ended while disconnected leaves reply mode, keeps text, and journals the loss',
  viewport: DESKTOP_VIEWPORT,
  async run(kit) {
    const { page, fixture, context } = kit;
    await kit.deliverAndWait(question('q-15', { nonBlocking: true, requestId: 'req-q15' }),
      `() => !!document.querySelector('.th-question-band')`);
    await composer(kit).click();
    await page.keyboard.type('남아 있는 텍스트', { delay: 15 });
    await domOn(page, `() => !!document.querySelector('.th-chat-reply-label')`);
    fixture.setAttachReplay(SESSION, [
      { type: 'questions.snapshot', ids: [] },
      { type: 'notice', kind: 'question_closed_while_disconnected',
        payload: { requestId: 'req-q15', id: 'q-15', headers: ['QA1'], hadSubmittedAnswer: false } },
    ]);
    fixture.disconnect(SESSION);
    await domOn(page, `() => !document.querySelector('.th-chat-reply-label') && !!document.querySelector('.th-chat-reply-ended')`, 30_000);
    assert.ok((await page.locator('.th-chat-reply-ended').textContent()).includes(KO.noLongerPending));
    assert.equal(await composer(kit).inputValue(), '남아 있는 텍스트', 'the composer text is kept');
    const noticeText = await page.locator('.th-notice-status--warning .th-notice-status-text').first().textContent();
    assert.ok(noticeText.includes(KO.closedWhileDisconnected) && noticeText.includes('[QA1]'),
      `the journaled notice renders with its headers: ${noticeText}`);
    await kit.shot('ended-while-away');
    const second = await context.newPage();
    try {
      await kit.goto(second);
      await domOn(second, `() => !!document.querySelector('.th-notice-status--warning .th-notice-status-text')`, 30_000);
      const secondText = await second.locator('.th-notice-status--warning .th-notice-status-text').first().textContent();
      assert.ok(secondText.includes(KO.closedWhileDisconnected), 'a fresh tab replays the journaled notice too');
      await kit.shot('second-tab', second);
    } finally {
      await second.close();
    }
  },
};

export const QUESTION_PARITY_SCENARIOS = scenarios;

/** Run one scenario end to end; resolves {pass, ...facts} or throws. */
export async function runScenario(id, { chromium, evidenceDir = DEFAULT_EVIDENCE } = {}) {
  const scenario = scenarios[id];
  if (scenario === undefined) throw new Error(`unknown question parity scenario ${id}`);
  if (chromium === undefined) throw new Error('runScenario needs {chromium} (from the qa driver entry)');
  await mkdir(join(evidenceDir, 'qa'), { recursive: true });
  const startedAt = Date.now();
  const kit = await boot({
    chromium, scenario: id, evidenceDir,
    viewport: scenario.viewport ?? DESKTOP_VIEWPORT, touch: scenario.touch ?? false, seed: scenario.seed ?? {},
  });
  let receipts;
  try {
    await kit.goto();
    await scenario.run(kit);
    if (kit.errors.length > 0) throw new Error(`page errors: ${kit.errors.join(' | ')}`);
    if (kit.fixture.unexpected.length > 0) {
      throw new Error(`unexpected fixture traffic: ${JSON.stringify(kit.fixture.unexpected)}`);
    }
    return {
      scenario: id, pass: true, ms: Date.now() - startedAt,
      frames: {
        approvalRespond: replies(kit).length,
        approvalProgress: progresses(kit).length,
        chatSend: outgoing(kit.fixture, frame => frame.type === 'chat.send').length,
        chatAbort: outgoing(kit.fixture, frame => frame.type === 'chat.abort').length,
      },
      errors: kit.errors,
    };
  } finally {
    receipts = { contextClosed: true, ...(await kit.context.close().then(() => undefined, () => undefined)),
      ...(await kit.fixture.stop()) };
  }
}

/** CLI entry: bun test/qa/question-omo-parity.mjs [Q1,Q2|all] [evidenceDir]. */
export async function runFromCli(argv, chromium) {
  const requested = (argv[0] ?? 'all') === 'all' ? Object.keys(scenarios) : argv[0].split(',');
  const evidenceDir = argv[1] ? resolve(argv[1]) : DEFAULT_EVIDENCE;
  const results = [];
  for (const id of requested) {
    try {
      results.push(await runScenario(id, { chromium, evidenceDir }));
      console.log(`PASS ${id}`);
    } catch (error) {
      results.push({ scenario: id, pass: false, error: String(error?.message ?? error) });
      console.log(`FAIL ${id}: ${error?.message ?? error}`);
    }
  }
  await releaseBrowser();
  console.log(JSON.stringify(results, null, 2));
  return results;
}

if (import.meta.main) {
  const { resolveQaDriver } = await import('./qa-driver.mjs');
  const driver = await resolveQaDriver();
  if (driver.status === 'unavailable') throw new Error(driver.reason);
  const { chromium } = await import(driver.entry);
  const results = await runFromCli(process.argv.slice(2), chromium);
  if (results.some(result => !result.pass)) process.exitCode = 1;
}
