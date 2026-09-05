#!/usr/bin/env node
'use strict';

/*
 * omo-webchat npm wrapper (bin entry).
 *
 * Resolves the platform binary package (omo-webchat-<os>-<arch>) installed as
 * an optionalDependency, execs its server binary with stdio inherited and no
 * shell, forwards SIGINT/SIGTERM, and propagates the child exit code. The omo
 * agent binary the server will spawn is resolved up front and injected into
 * the child environment as CHAT_PI_BINARY.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Platform package names, keyed by process.platform then process.arch.
// Every entry maps to a published platform package; a platform/arch with no
// package resolves to an actionable error instead of a silent fallback.
const PLATFORM_PACKAGES = {
  darwin: { arm64: 'omo-webchat-darwin-arm64', x64: 'omo-webchat-darwin-x64' },
  linux: { arm64: 'omo-webchat-linux-arm64', x64: 'omo-webchat-linux-x64' },
  win32: { arm64: 'omo-webchat-win32-arm64', x64: 'omo-webchat-win32-x64' },
};

const AGENT_HINT = [
  'omo-webchat: no omo agent binary found (the webchat server spawns it to answer chats).',
  '  fix with one of:',
  '    1. export CHAT_PI_BINARY=/path/to/your/omo-agent',
  '    2. install the `omo` CLI so it is on your PATH',
  '    3. bundle omo-ai via optionalDependencies (see README, "Enabling bundled omo")',
].join('\n');

function resolvePlatformPackage(platform = process.platform, arch = process.arch) {
  const byArch = PLATFORM_PACKAGES[platform];
  return (byArch && byArch[arch]) || null;
}

// Resolves the shipped binary path for a platform package. The platform
// package's contract is its index.js entrypoint, which exports the absolute
// path to the binary (see npm/platform/generate.mjs). We honor that first and
// fall back to the documented on-disk layout (exe/omo-webchat-bin) only if the
// entrypoint is unavailable. The historical bin/omo-webchat name is NOT used:
// the binary is deliberately shipped under exe/ to avoid the repo .gitignore.
function binPathFromPackage(pkgName, pkgJsonPath, platform, loadPackage) {
  let entryPath = null;
  try {
    entryPath = loadPackage(pkgName);
  } catch {
    entryPath = null;
  }
  if (typeof entryPath === 'string' && entryPath.length > 0) {
    return entryPath;
  }
  // Layout fallback, kept in sync with generate.mjs BIN_BASE/exe layout.
  const ext = platform === 'win32' ? '.exe' : '';
  return path.resolve(path.dirname(pkgJsonPath), 'exe', `omo-webchat-bin${ext}`);
}

function resolveBinaryPath(platform = process.platform, arch = process.arch, deps = {}) {
  const resolvePackage = deps.resolvePackage || ((specifier) => require.resolve(specifier));
  const loadPackage = deps.loadPackage || ((specifier) => require(specifier));
  const pkgName = resolvePlatformPackage(platform, arch);
  if (!pkgName) {
    return { ok: false, reason: `unsupported platform "${platform}-${arch}" (no platform package exists)` };
  }
  let pkgJsonPath;
  try {
    pkgJsonPath = resolvePackage(`${pkgName}/package.json`);
  } catch {
    return { ok: false, reason: `platform package "${pkgName}" is not installed for ${platform}-${arch}` };
  }
  let binPath;
  try {
    binPath = binPathFromPackage(pkgName, pkgJsonPath, platform, loadPackage);
  } catch (err) {
    return { ok: false, reason: `cannot read platform package "${pkgName}": ${err.message}` };
  }
  if (!fs.existsSync(binPath)) {
    return { ok: false, reason: `binary not found in "${pkgName}" at ${binPath}` };
  }
  return { ok: true, path: binPath, pkgName };
}

function findOnPath(env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['omo.exe', 'omo.cmd', 'omo'] : ['omo'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

// omo-ai is an OPTIONAL integration and must never be a hard dependency:
// every lookup here is guarded, and its absence is a normal outcome.
function findBundledOmo() {
  try {
    const pkgJsonPath = require.resolve('omo-ai/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    let rel = null;
    if (typeof pkg.bin === 'string') {
      rel = pkg.bin;
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      rel = pkg.bin.omo || pkg.bin['omo.js'] || Object.values(pkg.bin)[0] || null;
    }
    if (!rel) return null;
    return path.resolve(path.dirname(pkgJsonPath), rel);
  } catch {
    return null;
  }
}

/**
 * Pure resolver: given an env object, locate the omo agent binary that the
 * webchat server will spawn. Precedence:
 *   1. env.CHAT_PI_BINARY
 *   2. `omo` on PATH
 *   3. optionally-bundled omo-ai (its bin/omo.js), only if the package exists
 * Returns { ok:true, source, path } or { ok:false, reason } with an
 * actionable message. Never throws, never installs anything.
 */
function resolveAgent(env = process.env, deps = {}) {
  if (env.CHAT_PI_BINARY) {
    return { ok: true, source: 'env:CHAT_PI_BINARY', path: env.CHAT_PI_BINARY };
  }
  const fromPath = findOnPath(env);
  if (fromPath) {
    return { ok: true, source: 'PATH', path: fromPath };
  }
  const bundled = (deps.findBundledOmo || findBundledOmo)();
  if (bundled) {
    return { ok: true, source: 'omo-ai', path: bundled };
  }
  return { ok: false, reason: AGENT_HINT };
}

function main(argv) {
  argv = argv || process.argv.slice(2);
  const resolved = resolveBinaryPath();
  if (!resolved.ok) {
    console.error(`omo-webchat: ${resolved.reason}.`);
    console.error(`  current platform: ${process.platform}-${process.arch}`);
    console.error(`  expected package: ${resolvePlatformPackage() || 'n/a'}`);
    console.error('  Reinstall the package so optionalDependencies are fetched (npm may have skipped them with --omit=optional).');
    return 1;
  }

  const agent = resolveAgent(process.env);
  const childEnv = { ...process.env };
  if (agent.ok) {
    childEnv.CHAT_PI_BINARY = agent.path;
  } else {
    // Warn but do not block: --status/--stop and --provider overrides stay usable.
    console.error(agent.reason);
  }

  const child = spawn(resolved.path, argv, { stdio: 'inherit', env: childEnv });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  child.on('error', (err) => {
    console.error(`omo-webchat: failed to launch ${resolved.path}: ${err.message}`);
    process.exitCode = 1;
  });

  child.on('close', (code, signal) => {
    if (signal) {
      process.exitCode = 128 + (os.constants.signals[signal] || 15);
    } else {
      process.exitCode = typeof code === 'number' ? code : 1;
    }
  });
}

module.exports = { resolveAgent, resolveBinaryPath, resolvePlatformPackage };

if (require.main === module) {
  process.exitCode = main();
}
