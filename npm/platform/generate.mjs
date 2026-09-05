#!/usr/bin/env node
/**
 * generate.mjs — builds and populates the npm platform packages under
 * npm/platform/<osNode>-<cpuNode>/ for omo-webchat.
 *
 * Each package ships exactly one prebuilt native binary so that the
 * omo-webchat wrapper (npm/cli) can depend on it via optionalDependencies;
 * npm's "os"/"cpu" fields make npm install only the matching package.
 *
 * Layout contract (shared with the npm/cli wrapper lane — keep in sync):
 *   npm name:    omo-webchat-<osNode>-<cpuNode>     (npm tokens: darwin/linux/win32, x64/arm64)
 *   binary:      <pkg>/exe/omo-webchat-bin (+ ".exe" on win32)
 *   entrypoint:  <pkg>/index.js exports the absolute binary path, so the
 *                wrapper never hardcodes the filename:
 *                  const bin = require('omo-webchat-darwin-arm64')
 *   resolution:  require.resolve('omo-webchat-<os>-<arch>/package.json') also works.
 *
 * NOTE on naming: the binary is deliberately NOT named `omo-webchat` and NOT
 * placed in a `bin/` directory — both are gitignored as bare path tokens in
 * the repo root .gitignore (rules `omo-webchat` and `bin/`), which would make
 * the shipped binary silently untrackable.
 *
 * Usage:
 *   node npm/platform/generate.mjs                  # goreleaser build + populate
 *   node npm/platform/generate.mjs --skip-build     # reuse archives already in dist/
 *   node npm/platform/generate.mjs --version 1.2.3  # stamp package.json versions
 *
 * Build strategy per target:
 *   1. dist/omo-webchat_<goos>_<goarch>.tar.gz (goreleaser snapshot output,
 *      or produced here via `goreleaser release --snapshot`) is extracted; or
 *   2. fallback: build the frontend once, then run a direct
 *      `GOOS=<goos> GOARCH=<goarch> go build` of ./cmd/server (pure Go,
 *      CGO_ENABLED=0 — equivalent flags to .goreleaser.yaml).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PLATFORM_DIR, '..', '..')
const DIST_DIR = path.join(REPO_ROOT, 'dist')
const GO_MODULE_PATH = './cmd/server'

/**
 * One row per npm platform package. Adding a platform is a purely additive
 * data change: add one row here. Everything else (package.json, binary name,
 * extraction) is derived.
 *
 * Token cheat sheet — osNode/cpuNode use NODE values, goos/goarch use GO
 * values, and they are NOT the same vocabulary (npm "x64" == Go "amd64").
 *
 * Windows ships as a zip (see the goreleaser format_overrides), so those
 * archives go through the zip reader below.
 */
// prettier-ignore
const TARGETS = [
  { osNode: 'darwin', cpuNode: 'arm64', goos: 'darwin',  goarch: 'arm64'  },
  { osNode: 'darwin', cpuNode: 'x64',   goos: 'darwin',  goarch: 'amd64'  },
  { osNode: 'linux',  cpuNode: 'x64',   goos: 'linux',   goarch: 'amd64'  },
  { osNode: 'linux',  cpuNode: 'arm64', goos: 'linux',   goarch: 'arm64'  },
  { osNode: 'win32',  cpuNode: 'x64',   goos: 'windows', goarch: 'amd64', ext: '.exe' },
  { osNode: 'win32',  cpuNode: 'arm64', goos: 'windows', goarch: 'arm64', ext: '.exe' },
]

// Deliberately not `omo-webchat` and not under `bin/` — both are gitignored
// as bare path tokens in the repo root .gitignore. The wrapper must not
// hardcode this name; it should use the package's index.js entrypoint.
const BIN_BASE = 'omo-webchat-bin'

const DEFAULT_VERSION = '0.1.0'
const REPOSITORY_URL = 'https://github.com/DevNewbie1826/omo-webchat'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { skipBuild: false, version: DEFAULT_VERSION }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-build') args.skipBuild = true
    else if (argv[i] === '--version') args.version = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node generate.mjs [--skip-build] [--version x.y.z]')
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${argv[i]}`)
      process.exit(1)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// build / extract
// ---------------------------------------------------------------------------

function sh(cmd, cmdArgs, { cwd = REPO_ROOT, env } = {}) {
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${res.status}`)
  }
}

function hasCmd(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0
}

let frontendReady = false

function buildFrontend() {
  if (frontendReady) return
  console.log('[generate] building frontend required by frontend/embed.go')
  sh('npm', ['ci'], { cwd: path.join(REPO_ROOT, 'frontend') })
  sh('npm', ['run', 'build'], { cwd: path.join(REPO_ROOT, 'frontend') })
  frontendReady = true
}

function archiveFor(target) {
  // goreleaser archive name template: omo-webchat_<os>_<arch> (Go tokens),
  // tar.gz everywhere except windows, which format_overrides to zip.
  const ext = target.goos === 'windows' ? '.zip' : '.tar.gz'
  return path.join(DIST_DIR, `omo-webchat_${target.goos}_${target.goarch}${ext}`)
}

// bsdtar (macOS, Windows 10+) reads zip; GNU tar does not, so prefer unzip
// wherever it exists and keep tar as the fallback.
function unpack(archive, destDir) {
  if (archive.endsWith('.zip')) {
    const unzipped = spawnSync('unzip', ['-q', '-o', archive, '-d', destDir], { stdio: 'inherit' })
    if (unzipped.status === 0) return
    sh('tar', ['-xf', archive, '-C', destDir])
    return
  }
  sh('tar', ['-xzf', archive, '-C', destDir])
}

/**
 * Extract the goreleaser archive. Returns { binary, tmpDir } where tmpDir is a
 * generator-created scratch directory the caller must clean up, or null when
 * no archive exists.
 */
function extractBinary(target) {
  const archive = archiveFor(target)
  if (!fs.existsSync(archive)) return null
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-platform-'))
  try {
    unpack(archive, tmpDir)
    // goreleaser `binary: omo-webchat` (+ .exe on windows).
    return { binary: findFile(tmpDir, `omo-webchat${target.ext ?? ''}`), tmpDir }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
}

function findFile(dir, name) {
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === name) return full
    }
  }
  return null
}

/**
 * Fallback: build exactly what .goreleaser.yaml would, per target, into a
 * dedicated scratch directory. Returns { binary, tmpDir } so the caller can
 * clean up the generator-created directory (never a shared parent like /tmp).
 */
function goBuild(target) {
  buildFrontend()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-platform-'))
  const dest = path.join(tmpDir, `omo-webchat_${target.goos}_${target.goarch}${target.ext ?? ''}`)
  try {
    sh('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', dest, GO_MODULE_PATH], {
      env: { CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    })
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
  return { binary: dest, tmpDir }
}

// ---------------------------------------------------------------------------
// package writing
// ---------------------------------------------------------------------------

function writePackage(target, version, rawBinary) {
  const pkgDir = path.join(PLATFORM_DIR, `${target.osNode}-${target.cpuNode}`)
  const binName = BIN_BASE + (target.ext ?? '')
  const exeDir = path.join(pkgDir, 'exe')
  const binPath = path.join(exeDir, binName)

  fs.rmSync(pkgDir, { recursive: true, force: true })
  fs.mkdirSync(exeDir, { recursive: true })
  fs.copyFileSync(rawBinary, binPath)
  fs.chmodSync(binPath, 0o755)

  const pkg = {
    name: `omo-webchat-${target.osNode}-${target.cpuNode}`,
    version,
    description: `Prebuilt omo-webchat server binary for ${target.osNode}/${target.cpuNode} (Go ${target.goos}/${target.goarch}).`,
    repository: REPOSITORY_URL,
    os: [target.osNode],
    cpu: [target.cpuNode],
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
    },
    files: ['exe', 'index.js'],
    scripts: {
      prepack: `node -e "const fs=require('node:fs');const p='exe/${binName}';try{if(!fs.statSync(p).isFile())throw 0;fs.accessSync(p,fs.constants.X_OK)}catch{console.error('prepack: expected executable '+p+' is missing or not executable');process.exit(1)}"`,
    },
    private: false,
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const indexJs = [
    '// Generated by npm/platform/generate.mjs — do not edit by hand.',
    "// Resolves to the absolute path of the prebuilt omo-webchat binary shipped in this package's exe/ directory.",
    "'use strict';",
    "const path = require('node:path');",
    '',
    `module.exports = path.join(__dirname, 'exe', ${JSON.stringify(binName)});`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(pkgDir, 'index.js'), indexJs)

  return { pkgDir, binPath }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function updateCliVersion(version) {
  const cliManifestPath = path.join(REPO_ROOT, 'npm', 'cli', 'package.json')
  const cliManifest = JSON.parse(fs.readFileSync(cliManifestPath, 'utf8'))
  cliManifest.version = version
  for (const target of TARGETS) {
    const dependency = `omo-webchat-${target.osNode}-${target.cpuNode}`
    cliManifest.optionalDependencies[dependency] = version
  }
  fs.writeFileSync(cliManifestPath, JSON.stringify(cliManifest, null, 2) + '\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  updateCliVersion(args.version)

  if (args.skipBuild) {
    console.log('[generate] --skip-build: consuming whatever is in dist/, go build fallback for anything missing.')
  } else if (hasCmd('goreleaser')) {
    console.log('[generate] running: goreleaser release --snapshot --clean')
    sh('goreleaser', ['release', '--snapshot', '--clean'])
    frontendReady = true
  } else {
    console.log('[generate] goreleaser not found on PATH; falling back to direct go build per target.')
  }

  let fallbacks = 0
  for (const target of TARGETS) {
    const label = `${target.osNode}-${target.cpuNode} (go ${target.goos}/${target.goarch})`
    let produced = extractBinary(target)
    if (produced) {
      console.log(`[generate] ${label}: extracted binary from ${path.basename(archiveFor(target))}`)
    } else {
      fallbacks++
      console.log(`[generate] ${label}: no archive at dist/, using go build fallback`)
      produced = goBuild(target)
    }
    try {
      if (!produced.binary || !fs.existsSync(produced.binary)) {
        throw new Error(`${label}: no binary produced (archive missing the omo-webchat file?)`)
      }
      const { binPath } = writePackage(target, args.version, produced.binary)
      console.log(`[generate] ${label}: wrote ${path.relative(REPO_ROOT, binPath)}`)
    } finally {
      // Only ever remove the generator-created scratch dir, never a shared parent.
      fs.rmSync(produced.tmpDir, { recursive: true, force: true })
    }
  }

  if (fallbacks > 0) {
    console.log(`[generate] note: ${fallbacks} target(s) used the go build fallback (no goreleaser archive).`)
  }
  console.log(`[generate] done — ${TARGETS.length} platform package(s) at version ${args.version}.`)
}

main()
