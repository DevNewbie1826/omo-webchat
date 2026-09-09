import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const release = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yaml', import.meta.url), 'utf8'));
const packages = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/package-ci.yaml', import.meta.url), 'utf8'));
const stepsWith = (job, action) => job.steps.filter((s) => s.uses?.startsWith(`${action}@`));
const runs = (job) => job.steps.map((s) => s.run ?? '').join('\n');
// These workflows use the common JS/GitHub expression subset. Evaluate the
// actual machine-consumed condition, including GitHub's implicit success gate.
function evaluate(expression, ref, enabled, success = true) {
  const source = expression?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? 'true';
  return success && Function('github', 'vars', 'startsWith', `return (${source});`)(
    { ref }, { RELEASE_PUBLISH_ENABLED: enabled }, (value, prefix) => value.startsWith(prefix));
}

test('release publication is downstream of immutable pack and six-native validation, never GoReleaser publication', () => {
  expect(release.permissions).toEqual({ contents: 'read' });
  expect(release.jobs.validate.uses).toBe('./.github/workflows/package-ci.yaml');
  const publish = release.jobs.publish;
  expect(publish.needs).toEqual(['validate']);
  expect(publish.if).toBe("startsWith(github.ref, 'refs/tags/v') && vars.RELEASE_PUBLISH_ENABLED == 'true'");
  expect(publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  expect(stepsWith(publish, 'goreleaser/goreleaser-action')).toHaveLength(0);
  const [download] = stepsWith(publish, 'actions/download-artifact');
  expect(download.with['artifact-ids']).toBe('${{ needs.validate.outputs.artifact-id }}');
  expect(download.with['run-id']).toBeUndefined(); // Same successful run, including rerun-failed-jobs.
  expect(download.with.name).toBeUndefined();
  expect(stepsWith(publish, 'actions/checkout')[0].with.ref).toBe('${{ needs.validate.outputs.source-commit }}');
  expect(runs(publish)).toContain('npm/release.mjs verify --manifest release-artifacts/manifest.json');
  expect(runs(publish)).toContain('npm/release.mjs publish --manifest release-artifacts/manifest.json --tag "$TAG" --provenance');
  expect(runs(publish)).toContain('npm/github-release.mjs --manifest release-artifacts/manifest.json');
  const npmIndex = publish.steps.findIndex((s) => s.run?.includes('npm/release.mjs publish'));
  const githubIndex = publish.steps.findIndex((s) => s.run?.includes('npm/github-release.mjs'));
  expect(githubIndex).toBeGreaterThan(npmIndex);
  expect(publish.steps[githubIndex].if).toBeUndefined();
  expect(runs(publish)).not.toMatch(/goreleaser|\bpack\s+--out|dist-tag|--dry-run/);
  expect(release.on).toEqual({ push: { tags: ['v*'] } });
  expect(release.concurrency['cancel-in-progress']).toBe(false);
});

test('PRs, disabled bootstrap tags and failed native dependencies cannot publish', () => {
  for (const ref of ['refs/pull/123/merge', 'refs/heads/main', 'refs/tags/v0.1.0-rc.1', 'refs/tags/v0.1.0']) {
    for (const enabled of [undefined, '', 'false', 'true']) {
      for (const success of [false, true]) {
        expect(Boolean(evaluate(release.jobs.publish.if, ref, enabled, success))).toBe(success && ref.startsWith('refs/tags/v') && enabled === 'true');
      }
    }
  }
  expect(packages.jobs.gate.needs).toEqual(['build', 'native']);
  expect(packages.jobs.gate.if).toBeUndefined();
  expect(packages.jobs.native['continue-on-error']).toBeUndefined();
  expect(packages.jobs.native.strategy['fail-fast']).toBe(false);
  expect(packages.on.workflow_call.outputs['artifact-id'].value).toBe('${{ jobs.gate.outputs.artifact-id }}');
  expect(packages.jobs.gate.outputs['artifact-id']).toBe('${{ needs.build.outputs.artifact-id }}');
});

test('build packs exactly once without publication and preserves source/artifact identity', () => {
  expect(packages.permissions).toEqual({ contents: 'read' });
  expect(packages.on.pull_request).toBeNull();
  expect(packages.jobs.build.needs).toEqual(['contracts']);
  expect(packages.jobs.native.needs).toEqual(['build']);
  const [build] = stepsWith(packages.jobs.build, 'goreleaser/goreleaser-action');
  expect(evaluate(build.with.args, 'refs/tags/v0.1.0')).toBe('release --clean --skip=publish');
  expect(evaluate(build.with.args, 'refs/pull/1/merge')).toBe('release --clean --skip=publish --snapshot');
  expect(runs(packages.jobs.build).match(/npm\/release\.mjs pack --out/g)).toHaveLength(1);
  expect(runs(packages.jobs.build)).toContain('cp -R frontend/dist release-artifacts/frontend-dist');
  const [upload] = stepsWith(packages.jobs.build, 'actions/upload-artifact');
  expect(upload.with.path).toBe('release-artifacts/');
  expect(upload.with['if-no-files-found']).toBe('error');
  expect(packages.jobs.build.outputs['artifact-id']).toBe('${{ steps.artifacts.outputs.artifact-id }}');
  expect(upload.id).toBe('artifacts');
  expect(stepsWith(packages.jobs.native, 'actions/download-artifact')[0].with['artifact-ids']).toBe('${{ needs.build.outputs.artifact-id }}');
  expect(stepsWith(packages.jobs.native, 'actions/checkout')[0].with.ref).toBe('${{ needs.build.outputs.source-commit }}');
  for (const job of Object.values(packages.jobs)) {
    expect(job.permissions).toBeUndefined();
    expect(runs(job)).not.toMatch(/npm\/release\.mjs publish|npm\/github-release\.mjs|NPM_TOKEN|NODE_AUTH_TOKEN/);
    for (const step of job.steps) expect(step['continue-on-error']).toBeUndefined();
  }
});

test('all six native OS/architectures consume the same artifacts using pinned drivers and real fixture', () => {
  const job = packages.jobs.native;
  expect(job['runs-on']).toBe('${{ matrix.runner }}');
  expect(job.strategy.matrix.include).toEqual([
    { runner: 'macos-15-intel', os: 'darwin', arch: 'x64' },
    { runner: 'macos-15', os: 'darwin', arch: 'arm64' },
    { runner: 'ubuntu-24.04', os: 'linux', arch: 'x64' },
    { runner: 'ubuntu-24.04-arm', os: 'linux', arch: 'arm64' },
    { runner: 'windows-2025', os: 'win32', arch: 'x64' },
    { runner: 'windows-11-arm', os: 'win32', arch: 'arm64' },
  ]);
  expect(runs(job)).toContain('a.equal(process.platform,process.env.EXPECTED_OS)');
  expect(runs(job)).toContain('a.equal(process.arch,process.env.EXPECTED_ARCH)');
  expect(runs(job)).toContain('cp -R release-artifacts/frontend-dist frontend/dist');
  expect(runs(job)).toContain('go build -o native-fixture');
  expect(runs(job)).toContain('./test/nativefixture');
  expect(runs(job)).toContain('bun test/npm_native_smoke.mjs --manifest release-artifacts/manifest.json --fixture');
  expect(runs(job)).not.toContain('--registry');
  expect(stepsWith(job, 'actions/setup-node')[0].with.architecture).toBe('${{ matrix.arch }}');
  expect(job.steps.some((s) => s.if === 'always()' && s.uses === 'actions/upload-artifact@v4')).toBe(true);
  for (const candidate of [...Object.values(packages.jobs), release.jobs.publish]) {
    for (const step of stepsWith(candidate, 'actions/setup-node')) expect(step.with['node-version']).toBe('24.15.0');
    for (const step of stepsWith(candidate, 'oven-sh/setup-bun')) expect(step.with['bun-version']).toBe('1.4.2');
    if (stepsWith(candidate, 'actions/setup-node').length) expect(runs(candidate)).toContain('npm install --global npm@11.12.1');
  }
});
