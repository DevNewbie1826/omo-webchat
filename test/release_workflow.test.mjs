import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = (name) => Bun.YAML.parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const release = workflow('release.yaml');
const packages = workflow('package-ci.yaml');
const native = workflow('native-check.yaml');
const stepsWith = (job, action) => (job.steps ?? []).filter((s) => s.uses?.startsWith(`${action}@`));
const runs = (job) => (job.steps ?? []).map((s) => s.run ?? '').join('\n');
const targets = [
  { runner: 'macos-15-intel', os: 'darwin', arch: 'x64' },
  { runner: 'macos-15', os: 'darwin', arch: 'arm64' },
  { runner: 'ubuntu-24.04', os: 'linux', arch: 'x64' },
  { runner: 'ubuntu-24.04-arm', os: 'linux', arch: 'arm64' },
  { runner: 'windows-2025', os: 'win32', arch: 'x64' },
  { runner: 'windows-11-arm', os: 'win32', arch: 'arm64' },
];
// Evaluate the workflows' actual JS/GitHub expression subset, including
// GitHub's implicit success gate and its hyphenated input/property names.
function evaluate(expression, { github = {}, vars = {}, inputs = {}, needs = {}, matrix = {} } = {}, successful = true) {
  const source = (expression?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? 'true')
    .replace(/\.([a-zA-Z_][\w]*(?:-[\w]+)+)/g, "['$1']");
  const explicitStatus = /\b(?:success|always|failure|cancelled)\(/.test(source);
  return (explicitStatus || successful) && Function('github', 'vars', 'inputs', 'needs', 'matrix', 'startsWith', 'success', 'always', `return (${source});`)(
    github, vars, inputs, needs, matrix, (value, prefix) => value.startsWith(prefix), () => successful, () => true);
}
function enabled(job, results, context = {}) {
  const needs = Object.fromEntries((job.needs ?? []).map((name) => [name, { result: results[name] }]));
  return Boolean(evaluate(job.if, { ...context, needs }, Object.values(needs).every(({ result }) => result === 'success')));
}
const render = (script, context) => script.replace(/\$\{\{.*?\}\}/g, (expression) => String(evaluate(expression, context)));

test('release publication is downstream of local validation, npm, then all six public consumers', () => {
  expect(release.on).toEqual({ push: { tags: ['v*'] } });
  expect(release.concurrency['cancel-in-progress']).toBe(false);
  expect(release.jobs.validate.uses).toBe('./.github/workflows/package-ci.yaml');
  expect(release.jobs.publish.needs).toEqual(['validate']);
  expect(release.jobs['public-native'].needs).toEqual(['validate', 'publish']);
  expect(release.jobs['github-release'].needs).toEqual(['validate', 'public-native']);
  expect(release.jobs['public-native'].uses).toBe('./.github/workflows/native-check.yaml');
  expect(release.jobs['public-native'].with).toEqual({
    'artifact-id': '${{ needs.validate.outputs.artifact-id }}',
    'run-id': '${{ github.run_id }}',
    'source-commit': '${{ needs.validate.outputs.source-commit }}',
    'source-ref': '${{ github.ref }}',
    'public-registry': true,
  });
  expect(release.jobs.publish.environment).toBe('npm-release');
  expect(runs(release.jobs.publish)).toContain('npm/release.mjs verify --manifest release-artifacts/manifest.json');
  expect(runs(release.jobs.publish)).toContain('npm/release.mjs publish --manifest release-artifacts/manifest.json --tag "$TAG" --provenance');
  expect(runs(release.jobs.publish)).not.toContain('npm/github-release.mjs');
  expect(runs(release.jobs['github-release'])).toContain('npm/github-release.mjs --manifest release-artifacts/manifest.json');
  expect(runs(release.jobs['github-release'])).not.toContain('npm/release.mjs publish');
});

test('PRs and absent/disabled bootstrap publication still validate, but cannot reach either publication surface', () => {
  for (const ref of ['refs/pull/123/merge', 'refs/heads/main', 'refs/tags/v0.1.0-rc.1', 'refs/tags/v0.1.0']) {
    for (const value of [undefined, '', 'false', 'true']) {
      const context = { github: { ref }, vars: { RELEASE_PUBLISH_ENABLED: value } };
      expect(enabled(release.jobs.validate, {}, context)).toBe(true);
      expect(enabled(packages.jobs.native, { build: 'success' }, context)).toBe(true);
      const results = { validate: 'success' };
      const shouldPublish = ref.startsWith('refs/tags/v') && value === 'true';
      expect(enabled(release.jobs.publish, results, context)).toBe(shouldPublish);
      results.publish = shouldPublish ? 'success' : 'skipped';
      expect(enabled(release.jobs['public-native'], results, context)).toBe(shouldPublish);
      results['public-native'] = shouldPublish ? 'success' : 'skipped';
      expect(enabled(release.jobs['github-release'], results, context)).toBe(shouldPublish);
    }
  }
  expect(packages.on.pull_request).toBeNull();
  expect(packages.jobs.gate.needs).toEqual(['build', 'native']);
  for (const output of ['artifact-id', 'source-commit']) {
    expect(packages.on.workflow_call.outputs[output].value).toBe(`\${{ jobs.gate.outputs.${output} }}`);
    expect(packages.jobs.gate.outputs[output]).toBe(`\${{ needs.build.outputs.${output} }}`);
  }
});

test('each failed, cancelled or skipped native target blocks the appropriate publication gate', () => {
  const context = { github: { ref: 'refs/tags/v0.1.0' }, vars: { RELEASE_PUBLISH_ENABLED: 'true' } };
  for (const target of native.jobs.native.strategy.matrix.include) {
    for (const status of ['failure', 'cancelled', 'skipped']) {
      const matrix = targets.map((row) => row.runner === target.runner ? status : 'success');
      const nativeResult = matrix.every((result) => result === 'success') ? 'success' : status;
      expect(enabled(packages.jobs.gate, { build: 'success', native: nativeResult })).toBe(false);
      expect(enabled(release.jobs.publish, { validate: nativeResult }, context)).toBe(false);
      expect(enabled(release.jobs['public-native'], { validate: nativeResult, publish: 'skipped' }, context)).toBe(false);
      expect(enabled(release.jobs['github-release'], { validate: 'success', 'public-native': nativeResult }, context)).toBe(false);
    }
  }
  for (const status of ['failure', 'cancelled', 'skipped']) {
    expect(enabled(packages.jobs.gate, { build: status, native: 'success' })).toBe(false);
    expect(enabled(release.jobs['public-native'], { validate: 'success', publish: status }, context)).toBe(false);
  }
  expect(enabled(packages.jobs.gate, { build: 'success', native: 'success' })).toBe(true);
  for (const flow of [packages, release, native]) for (const job of Object.values(flow.jobs)) {
    expect(job['continue-on-error']).toBeUndefined();
    for (const step of job.steps ?? []) expect(step['continue-on-error']).toBeUndefined();
  }
  expect(native.jobs.native.if).toBeUndefined();
  expect(native.jobs.native.strategy['fail-fast']).toBe(false);
  for (const step of native.jobs.native.steps) {
    expect(step.if).toBe(step.uses === 'actions/upload-artifact@v4' ? 'always()' : undefined);
  }
});

test('only the original build packs, and failed-publication retries download its exact artifact ID', () => {
  expect(packages.jobs.build.needs).toEqual(['contracts']);
  expect(packages.jobs.native.needs).toEqual(['build']);
  expect(packages.jobs.native.uses).toBe('./.github/workflows/native-check.yaml');
  expect(packages.jobs.native.with).toEqual({
    'artifact-id': '${{ needs.build.outputs.artifact-id }}',
    'run-id': '${{ github.run_id }}',
    'source-commit': '${{ needs.build.outputs.source-commit }}',
    'source-ref': '${{ github.ref }}',
  });
  const [build] = stepsWith(packages.jobs.build, 'goreleaser/goreleaser-action');
  expect(evaluate(build.with.args, { github: { ref: 'refs/tags/v0.1.0' } })).toBe('release --clean --skip=publish');
  expect(evaluate(build.with.args, { github: { ref: 'refs/pull/1/merge' } })).toBe('release --clean --skip=publish --snapshot');
  expect(runs(packages.jobs.build).match(/npm\/release\.mjs pack --out/g)).toHaveLength(1);
  expect(runs(packages.jobs.build)).toContain('cp -R frontend/dist release-artifacts/frontend-dist');
  const [upload] = stepsWith(packages.jobs.build, 'actions/upload-artifact');
  expect(upload.with.path).toBe('release-artifacts/');
  expect(upload.with['if-no-files-found']).toBe('error');
  expect(packages.jobs.build.outputs['artifact-id']).toBe('${{ steps.artifacts.outputs.artifact-id }}');
  expect(upload.id).toBe('artifacts');
  for (const job of [release.jobs.publish, release.jobs['github-release']]) {
    const [download] = stepsWith(job, 'actions/download-artifact');
    expect(download.with['artifact-ids']).toBe('${{ needs.validate.outputs.artifact-id }}');
    expect(download.with['run-id']).toBeUndefined(); // Includes rerun-failed-jobs, never a new build selection.
    expect(download.with.name).toBeUndefined();
    expect(stepsWith(job, 'actions/checkout')[0].with.ref).toBe('${{ needs.validate.outputs.source-commit }}');
    expect(runs(job)).not.toMatch(/goreleaser|\bpack\s+--out|dist-tag|--dry-run/);
  }
});

test('manual verification is a read-only exact-input route and always selects the public registry', () => {
  expect(Object.keys(native.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  expect(Object.keys(native.jobs)).toEqual(['native']);
  expect(Object.keys(native.on.workflow_dispatch.inputs).sort()).toEqual(['artifact-id', 'run-id', 'source-commit', 'source-ref']);
  for (const key of ['artifact-id', 'run-id', 'source-commit', 'source-ref']) {
    for (const event of ['workflow_call', 'workflow_dispatch']) {
      const input = native.on[event].inputs[key];
      expect(input.type).toBe('string');
      expect(input.required).toBe(true);
      expect(input.default).toBeUndefined();
    }
  }
  expect(native.on.workflow_call.inputs['public-registry'].type).toBe('boolean');
  expect(native.on.workflow_call.inputs['public-registry'].default).toBe(false);
  const job = native.jobs.native;
  const [download] = stepsWith(job, 'actions/download-artifact');
  expect(download.with).toEqual({
    'artifact-ids': '${{ inputs.artifact-id }}', 'run-id': '${{ inputs.run-id }}',
    'github-token': '${{ secrets.GITHUB_TOKEN }}', path: 'release-artifacts', 'merge-multiple': true,
  });
  expect(stepsWith(job, 'actions/checkout')[0].with).toEqual({ ref: '${{ inputs.source-commit }}', 'fetch-depth': 0, 'persist-credentials': false });
  const modeSteps = job.steps.filter((step) => step.env?.PUBLIC_REGISTRY);
  expect(modeSteps).toHaveLength(2);
  for (const step of modeSteps) {
    for (const event_name of ['push', 'pull_request', 'workflow_dispatch']) {
      for (const publicRegistry of [false, true]) {
        expect(evaluate(step.env.PUBLIC_REGISTRY, { github: { event_name }, inputs: { 'public-registry': publicRegistry } }))
          .toBe(event_name === 'workflow_dispatch' || publicRegistry);
      }
    }
  }
  expect(runs(job)).not.toMatch(/npm\/release\.mjs (pack|publish)|npm\/github-release|goreleaser|npm (ci|run build)|go build.*cmd\/server/);
  expect(stepsWith(job, 'goreleaser/goreleaser-action')).toHaveLength(0);
  const verify = job.steps.findIndex((step) => step.run === 'node npm/release.mjs verify --manifest release-artifacts/manifest.json');
  const fixture = job.steps.findIndex((step) => step.run?.includes('go build'));
  const smoke = job.steps.findIndex((step) => step.run?.includes('bun test/npm_native_smoke.mjs'));
  expect(verify).toBeGreaterThan(job.steps.indexOf(download));
  expect(fixture).toBeGreaterThan(verify);
  expect(smoke).toBeGreaterThan(fixture);
  expect(runs(job)).toContain('test ! -e frontend/dist\ncp -R release-artifacts/frontend-dist frontend/dist');
});

test('writes are isolated to the two publication jobs; actions read is restricted to native retrieval callers', () => {
  expect(release.permissions).toEqual({ contents: 'read' });
  expect(packages.permissions).toEqual({ contents: 'read' });
  expect(native.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(release.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  expect(release.jobs['github-release'].permissions).toEqual({ contents: 'write' });
  for (const job of [release.jobs.validate, release.jobs['public-native'], packages.jobs.native]) {
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read' });
  }
  for (const job of [packages.jobs.contracts, packages.jobs.build, packages.jobs.gate, native.jobs.native]) expect(job.permissions).toBeUndefined();
  for (const flow of [packages, native]) for (const job of Object.values(flow.jobs)) {
    expect(runs(job)).not.toMatch(/npm\/release\.mjs publish|npm\/github-release\.mjs|NPM_TOKEN|NODE_AUTH_TOKEN/);
  }
  for (const flow of [packages, native, release]) {
    expect(flow.env?.GITHUB_SHA).toBeUndefined();
    expect(flow.env?.GITHUB_REF).toBeUndefined();
    for (const job of Object.values(flow.jobs)) {
      expect(job.env?.GITHUB_SHA).toBeUndefined();
      expect(job.env?.GITHUB_REF).toBeUndefined();
      expect(runs(job)).not.toMatch(/(?:export\s+|env\s+(?:-u\s+)?)GITHUB_(?:SHA|REF)|delete\s+.*GITHUB_(?:SHA|REF)/);
      for (const step of job.steps ?? []) {
        expect(step.env?.GITHUB_SHA).toBeUndefined();
        expect(step.env?.GITHUB_REF).toBeUndefined();
      }
    }
  }
});

test('one six-native matrix uses pinned real drivers, fixture and collision-free local/public receipts', () => {
  const job = native.jobs.native;
  expect(job['runs-on']).toBe('${{ matrix.runner }}');
  expect(job.strategy.matrix.include).toEqual(targets);
  expect(packages.jobs.native.strategy).toBeUndefined();
  expect(release.jobs['public-native'].strategy).toBeUndefined();
  expect(runs(job)).toContain('a.equal(process.platform,process.env.EXPECTED_OS)');
  expect(runs(job)).toContain('a.equal(process.arch,process.env.EXPECTED_ARCH)');
  expect(runs(job)).toContain('./test/nativefixture');
  expect(stepsWith(job, 'actions/setup-node')[0].with.architecture).toBe('${{ matrix.arch }}');
  const names = new Set();
  for (const matrix of targets) for (const publicRegistry of [false, true]) {
    const [receipt] = stepsWith(job, 'actions/upload-artifact');
    expect(receipt.if).toBe('always()');
    const name = render(receipt.with.name, { matrix, github: { event_name: 'push', run_id: 123, run_attempt: 2 }, inputs: { 'public-registry': publicRegistry } });
    expect(names.has(name)).toBe(false);
    names.add(name);
  }
  for (const flow of [packages, native, release]) for (const candidate of Object.values(flow.jobs)) {
    for (const step of stepsWith(candidate, 'actions/setup-node')) expect(step.with['node-version']).toBe('24.15.0');
    for (const step of stepsWith(candidate, 'oven-sh/setup-bun')) expect(step.with['bun-version']).toBe('1.4.2');
    if (stepsWith(candidate, 'actions/setup-node').length) expect(runs(candidate)).toContain('npm install --global npm@11.12.1');
  }
});

const binding = stepsWith(native.jobs.native, 'actions/github-script')[0];
const runBinding = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'process', 'context', 'github', binding.with.script);
test('successful six-native gate emits a receipt bound to run, exact build artifact and gate attempt', () => {
  const gate = packages.jobs.gate;
  const [upload] = stepsWith(gate, 'actions/upload-artifact');
  expect(upload).toBeDefined();
  const cwd = mkdtempSync(path.join(tmpdir(), 'omo-workflow-receipt-'));
  try {
    const names = new Set();
    for (const runId of [100, 101]) for (const artifactId of [321, 322]) for (const attempt of [1, 2]) {
      const context = {
        github: { run_id: runId, run_attempt: attempt },
        needs: { build: { outputs: { 'artifact-id': String(artifactId), 'source-commit': 'a'.repeat(40) } } },
      };
      const name = render(upload.with.name, context);
      expect(name).toBe(`release-validation-${runId}-${artifactId}-${attempt}`);
      expect(names.has(name)).toBe(false);
      names.add(name);
      const step = gate.steps.find((s) => s.run && s.env?.ARTIFACT_ID);
      const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, render(value, context)]));
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', render(step.run, context)], {
        cwd, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const receipt = Object.fromEntries(readFileSync(path.join(cwd, upload.with.path), 'utf8').trim().split('\n').map((line) => line.split('=')));
      expect(receipt).toEqual({ 'artifact-id': String(artifactId), 'source-commit': 'a'.repeat(40) });
    }
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.if).toBeUndefined(); // A failed gate must not leave an authorizing receipt.
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function bindingFixture() {
  const sha = 'a'.repeat(40);
  const context = { sha, ref: 'refs/tags/v0.1.0-rc.1', repo: { owner: 'owner', repo: 'repo' }, runId: 100 };
  const inputs = { 'artifact-id': '321', 'run-id': '100', 'source-commit': sha, 'source-ref': context.ref, 'public-registry': true };
  const env = Object.fromEntries(Object.entries(binding.env).map(([key, value]) => [key, String(evaluate(value, { github: { event_name: 'push' }, inputs }))]));
  const run = { head_sha: sha, path: '.github/workflows/release.yaml', event: 'push' };
  const artifact = { id: 321, expired: false, workflow_run: { id: 100 }, name: 'release-packages-100-1' };
  const receipt = { id: 654, expired: false, workflow_run: { id: 100 }, name: 'release-validation-100-321-1' };
  const receipts = [receipt];
  const jobs = [{ name: 'validate / gate', conclusion: 'success' }];
  const jobsByAttempt = { 1: jobs };
  const github = { rest: { actions: {
    async getWorkflowRun({ run_id }) { return { data: run_id === 100 ? run : undefined }; },
    async getArtifact({ artifact_id }) { return { data: artifact_id === 321 ? artifact : undefined }; },
    async listWorkflowRunArtifacts({ run_id }) { return run_id === 100 ? receipts : []; },
    async listJobsForWorkflowRunAttempt({ run_id, attempt_number }) { return run_id === 100 ? jobsByAttempt[attempt_number] ?? [] : []; },
  } }, paginate: (method, params) => method(params) };
  return { context, env, run, artifact, receipt, receipts, jobs, jobsByAttempt, invoke: () => runBinding(createRequire(import.meta.url), { env }, context, github) };
}

test('actual artifact-binding script accepts original public/RC reuse and same-run PR inputs', async () => {
  const fixture = bindingFixture();
  fixture.context.runId = 200; // New dispatch run, old artifact run remains 100.
  await fixture.invoke();
  const local = bindingFixture();
  local.env.PUBLIC_REGISTRY = 'false';
  local.context.ref = local.env.SOURCE_REF = 'refs/pull/123/merge';
  local.receipts.length = local.jobs.length = 0; // Local prevalidation cannot require its future gate.
  await local.invoke();
});

test('actual binding accepts attempt1 bytes validated by a successful exact-artifact gate in attempt2', async () => {
  const fixture = bindingFixture();
  fixture.jobs[0].conclusion = 'failure';
  fixture.receipt.name = 'release-validation-100-321-2';
  fixture.jobsByAttempt[2] = [{ name: 'validate / gate', conclusion: 'success' }];
  await fixture.invoke();
});

test('actual binding selects successful exact-artifact evidence rather than the latest gate', async () => {
  const fixture = bindingFixture();
  fixture.receipt.name = 'release-validation-100-321-2';
  fixture.jobsByAttempt[2] = [{ name: 'validate / gate', conclusion: 'failure' }];
  fixture.receipts.push({ ...fixture.receipt, id: 655, name: 'release-validation-100-321-1' });
  await fixture.invoke();
});

test.each([
  ['no receipt', (f) => { f.receipts.length = 0; }],
  ['different artifact receipt after rebuild', (f) => { f.receipt.name = 'release-validation-100-322-1'; }],
  ['different run in receipt name', (f) => { f.receipt.name = 'release-validation-101-321-1'; }],
  ['different receipt workflow run', (f) => { f.receipt.workflow_run.id = 101; }],
  ['expired receipt', (f) => { f.receipt.expired = true; }],
  ['unrelated old successful gate', (f) => {
    f.receipt.name = 'release-validation-100-321-2';
    f.jobsByAttempt[2] = [{ name: 'validate / gate', conclusion: 'failure' }];
  }],
  ['receipt attempt without a gate', (f) => { f.receipt.name = 'release-validation-100-321-2'; }],
  ['zero receipt attempt', (f) => { f.receipt.name = 'release-validation-100-321-0'; }],
  ['unsafe receipt attempt', (f) => { f.receipt.name = 'release-validation-100-321-9007199254740992'; }],
  ['receipt name suffix', (f) => { f.receipt.name += '-extra'; }],
])('actual binding rejects %s despite an original successful gate', async (_name, mutate) => {
  const fixture = bindingFixture();
  mutate(fixture);
  await expect(fixture.invoke()).rejects.toThrow();
});

test('actual binding rejects unrelated refs/commits/runs, expired or substituted artifacts and invalid identities', async () => {
  const mutations = [
    (f) => { f.context.sha = 'b'.repeat(40); },
    (f) => { f.context.ref = 'refs/heads/main'; },
    (f) => { f.env.SOURCE_COMMIT = 'a'.repeat(7); },
    (f) => { f.env.ARTIFACT_ID = '321,322'; },
    (f) => { f.env.ORIGINAL_RUN_ID = 'latest'; },
    (f) => { f.env.ARTIFACT_ID = '9007199254740992'; },
    (f) => { f.env.SOURCE_REF = f.context.ref = 'refs/heads/main'; },
    (f) => { f.run.head_sha = 'b'.repeat(40); },
    (f) => { f.run.path = '.github/workflows/package-ci.yaml'; },
    (f) => { f.run.event = 'pull_request'; },
    (f) => { f.artifact.id = 322; },
    (f) => { f.artifact.workflow_run.id = 101; },
    (f) => { f.artifact.expired = true; },
    (f) => { f.artifact.name = 'release-packages-101-1'; },
    (f) => { f.artifact.name = 'publication-100-1'; },
    (f) => { f.jobs.length = 0; },
    (f) => { f.jobs[0].name = 'unrelated gate'; },
    ...['failure', 'skipped', 'cancelled'].map((status) => (f) => { f.jobs[0].conclusion = status; }),
    (f) => { f.env.PUBLIC_REGISTRY = 'false'; f.context.runId = 101; },
  ];
  for (const mutate of mutations) {
    const fixture = bindingFixture();
    mutate(fixture);
    await expect(fixture.invoke()).rejects.toThrow();
  }
});

test('actual smoke shell passes the public URL only in public mode and propagates CLI failures', () => {
  const step = native.jobs.native.steps.find((s) => s.run?.includes('bun test/npm_native_smoke.mjs'));
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'omo-workflow-argv-')));
  try {
    for (const matrix of targets) for (const publicRegistry of [false, true]) for (const exit of [0, 7]) {
      // A shell function captures the command boundary, not the smoke behavior.
      // It also proves pipefail cannot turn a failing consumer into a green job.
      const script = `bun() { printf '%s\\n' "$@"; return "$SMOKE_EXIT"; };\n${render(step.run, { matrix })}`;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PUBLIC_REGISTRY: String(publicRegistry), SMOKE_EXIT: String(exit) },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(exit);
      expect(result.stdout.trim().split('\n')).toEqual([
        'test/npm_native_smoke.mjs', '--manifest', 'release-artifacts/manifest.json',
        '--fixture', `${cwd}/native-fixture${matrix.os === 'win32' ? '.exe' : ''}`,
        ...(publicRegistry ? ['--registry', 'https://registry.npmjs.org'] : []),
      ]);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the wired verifier executable rejects manifest/source and tag/version mismatch before any consumer', () => {
  const step = native.jobs.native.steps.find((s) => s.run?.startsWith('node npm/release.mjs verify'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'omo-workflow-binding-'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  try {
    const manifest = path.join(cwd, 'manifest.json');
    const argv = step.run.split(' ').slice(1);
    argv[0] = path.join(root, argv[0]);
    argv[3] = manifest;
    for (const [sourceCommit, ref, diagnostic] of [
      ['0'.repeat(40), 'refs/heads/main', 'sourceCommit differs from checked-out source'],
      [commit, 'refs/tags/v9.9.9', 'Tag/version mismatch'],
    ]) {
      writeFileSync(manifest, JSON.stringify({ version: '0.1.0-rc.1', sourceCommit }));
      const result = spawnSync(Bun.which('node'), argv, {
        cwd, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GITHUB_SHA: commit, GITHUB_REF: ref },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
