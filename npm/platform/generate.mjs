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
 *   node npm/platform/generate.mjs                  # goreleaser snapshot + populate
 *   node npm/platform/generate.mjs --skip-build     # require all six dist/ archives
 *   node npm/platform/generate.mjs --skip-build --version 1.2.3
 *
 * Versions come from dist/metadata.json; --version asserts an exact match.
 * All inputs are validated before any package is changed. No fallback builds.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PLATFORM_DIR, '..', '..')
const DIST_DIR = path.join(REPO_ROOT, 'dist')

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

const NOTICE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md']
const REPOSITORY_URL = 'https://github.com/DevNewbie1826/omo-webchat'

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { skipBuild: false, version: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-build') args.skipBuild = true
    else if (argv[i] === '--version') args.version = parseVersion(argv[++i])
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

function parseVersion(version) {
  // Canonical npm versions: no tag prefix, ranges, whitespace or leading zeros.
  const numeric = '(0|[1-9][0-9]*)'
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`)
  if (typeof version !== 'string' || !semver.test(version) ||
      version.split(/[.-]/).slice(0, 3).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`Invalid npm release version: ${JSON.stringify(version)}`)
  }
  return version
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

function archiveFor(target) {
  // goreleaser archive name template: omo-webchat_<os>_<arch> (Go tokens),
  // tar.gz everywhere except windows, which format_overrides to zip.
  const ext = target.goos === 'windows' ? '.zip' : '.tar.gz'
  return path.join(DIST_DIR, `omo-webchat_${target.goos}_${target.goarch}${ext}`)
}

// GNU tar cannot read ZIP. Use unzip when installed, bsdtar otherwise;
// an invalid archive must not be retried with a more permissive extractor.
function archiveCommand(archive, destDir) {
  let result
  if (archive.endsWith('.zip')) {
    result = spawnSync('unzip', destDir ? ['-q', archive, '-d', destDir] : ['-Z1', archive], { encoding: 'utf8' })
  }
  if (!result || result.error?.code === 'ENOENT') {
    result = spawnSync('tar', destDir ? ['-xf', archive, '-C', destDir] : ['-tf', archive], { encoding: 'utf8' })
  }
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot read ${archive}: ${result.stderr}`)
  return result.stdout
}

/**
 * Validate the flat GoReleaser payload before extracting. Restricting members
 * prevents traversal and duplicate entries from overwriting an earlier file.
 */
function extractBinary(target, notices) {
  const archive = archiveFor(target)
  const name = `omo-webchat${target.ext ?? ''}`
  const members = archiveCommand(archive).trim().split(/\r?\n/)
  const required = [name, ...NOTICE_FILES]
  const allowed = [...required, 'README.md']
  if (new Set(members).size !== members.length ||
      members.some((member) => !allowed.includes(member)) ||
      required.some((member) => !members.includes(member))) {
    throw new Error(`${archive}: expected one binary and both notice files at archive root`)
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-platform-'))
  try {
    archiveCommand(archive, tmpDir)
    for (const member of members) {
      if (!fs.lstatSync(path.join(tmpDir, member)).isFile()) {
        throw new Error(`${archive}: ${member} must be a regular file`)
      }
    }
    for (const notice of NOTICE_FILES) {
      if (!fs.readFileSync(path.join(tmpDir, notice)).equals(notices[notice])) {
        throw new Error(`${archive}: ${notice} differs from the release source`)
      }
    }
    const binary = path.join(tmpDir, name)
    validateBinary(fs.readFileSync(binary), target)
    return { binary, tmpDir }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
}

function validateBinary(bytes, target) {
  let valid = false
  if (bytes.length >= 64) {
    if (target.goos === 'darwin') {
      valid = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(12) === 2 &&
        bytes.readUInt32LE(4) === (target.goarch === 'amd64' ? 0x01000007 : 0x0100000c)
    } else if (target.goos === 'linux') {
      valid = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        bytes[4] === 2 && bytes[5] === 1 && [2, 3].includes(bytes.readUInt16LE(16)) &&
        bytes.readUInt16LE(18) === (target.goarch === 'amd64' ? 62 : 183)
    } else {
      const pe = bytes.readUInt32LE(0x3c)
      valid = bytes.subarray(0, 2).toString() === 'MZ' && pe >= 64 && pe + 6 <= bytes.length &&
        bytes.readUInt32LE(pe) === 0x00004550 &&
        bytes.readUInt16LE(pe + 4) === (target.goarch === 'amd64' ? 0x8664 : 0xaa64)
    }
  }
  if (!valid) throw new Error(`Invalid executable for ${target.goos}/${target.goarch}`)
}

// ---------------------------------------------------------------------------
// package writing
// ---------------------------------------------------------------------------

function writePackage(target, version, produced, notices) {
  const pkgDir = path.join(PLATFORM_DIR, `${target.osNode}-${target.cpuNode}`)
  const binName = BIN_BASE + (target.ext ?? '')
  const exeDir = path.join(pkgDir, 'exe')
  const binPath = path.join(exeDir, binName)

  fs.rmSync(pkgDir, { recursive: true, force: true })
  fs.mkdirSync(exeDir, { recursive: true })
  fs.copyFileSync(produced.binary, binPath)
  fs.chmodSync(binPath, 0o755)
  for (const notice of NOTICE_FILES) fs.writeFileSync(path.join(pkgDir, notice), notices[notice])

  const pkg = {
    name: `omo-webchat-${target.osNode}-${target.cpuNode}`,
    version,
    description: `Prebuilt omo-webchat server binary for ${target.osNode}/${target.cpuNode} (Go ${target.goos}/${target.goarch}).`,
    repository: REPOSITORY_URL,
    license: 'MIT',
    os: [target.osNode],
    cpu: [target.cpuNode],
    main: 'index.js',
    exports: {
      '.': './index.js',
      './package.json': './package.json',
    },
    files: ['exe', 'index.js', ...NOTICE_FILES],
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

function updateCliVersion(version, notices) {
  const cliManifestPath = path.join(REPO_ROOT, 'npm', 'cli', 'package.json')
  const cliManifest = JSON.parse(fs.readFileSync(cliManifestPath, 'utf8'))
  cliManifest.version = version
  cliManifest.license = 'MIT'
  cliManifest.repository = REPOSITORY_URL
  cliManifest.files = [...new Set([...cliManifest.files, ...NOTICE_FILES])]
  for (const target of TARGETS) {
    const dependency = `omo-webchat-${target.osNode}-${target.cpuNode}`
    cliManifest.optionalDependencies[dependency] = version
  }
  fs.writeFileSync(cliManifestPath, JSON.stringify(cliManifest, null, 2) + '\n')
  for (const notice of NOTICE_FILES) fs.writeFileSync(path.join(path.dirname(cliManifestPath), notice), notices[notice])
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.skipBuild) {
    console.log('[generate] running: goreleaser release --snapshot --clean')
    sh('goreleaser', ['release', '--snapshot', '--clean'])
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'metadata.json'), 'utf8'))
  const version = parseVersion(metadata?.version)
  if (args.version !== undefined && args.version !== version) {
    throw new Error(`Requested version ${args.version} differs from release metadata ${version}`)
  }
  const notices = Object.fromEntries(NOTICE_FILES.map((name) => [name, fs.readFileSync(path.join(REPO_ROOT, name))]))
  const produced = []
  try {
    for (const target of TARGETS) produced.push(extractBinary(target, notices))
    updateCliVersion(version, notices)
    for (const [i, target] of TARGETS.entries()) {
      const { binPath } = writePackage(target, version, produced[i], notices)
      console.log(`[generate] wrote ${path.relative(REPO_ROOT, binPath)}`)
    }
  } finally {
    for (const { tmpDir } of produced) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
  console.log(`[generate] done — ${TARGETS.length} platform package(s) at version ${version}.`)
}

main()
