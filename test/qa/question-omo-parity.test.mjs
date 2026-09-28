/** bun test wrapper for the question-tool omo-parity browser scenarios
 * (test/qa/question-omo-parity.mjs — plan todo 6).
 *
 * Run: cd <repo> && QA_PLAYWRIGHT=<playwright-core index.mjs> \
 *      bun test --isolate test/qa/question-omo-parity.test.mjs
 * Never --parallel (one shared Chromium; fixed-port-adjacent fixtures).
 */
import { afterAll, expect, test } from 'bun:test';
import { QUESTION_PARITY_SCENARIOS, releaseBrowser, runScenario } from './question-omo-parity.mjs';
import { qaDriverSkipOption, resolveQaDriver } from './qa-driver.mjs';

const qaDriver = await resolveQaDriver();

test('question parity catalogue registers every planned scenario', () => {
  for (const id of ['Q1', 'Q1-phone', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10', 'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17', 'Q18', 'Q19', 'Q20', 'Q21']) {
    expect(typeof QUESTION_PARITY_SCENARIOS[id]?.run, `${id} must be registered`).toBe('function');
  }
});

for (const id of Object.keys(QUESTION_PARITY_SCENARIOS)) {
  const scenario = QUESTION_PARITY_SCENARIOS[id];
  test(`${id} ${scenario.title}`, { timeout: 120_000, ...qaDriverSkipOption(qaDriver) }, async () => {
    const { chromium } = await import(qaDriver.entry);
    const outcome = await runScenario(id, { chromium });
    expect(outcome.pass).toBe(true);
    expect(outcome.errors).toEqual([]);
  });
}

afterAll(async () => {
  await releaseBrowser();
});
