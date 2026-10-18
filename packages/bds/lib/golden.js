// owner: U1 (BDS harness & e2e infra)
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { BDS_VERSION, BDS_ZIP, IMAGE, SERVER_BINARY, paths } = require('./config')
const docker = require('./docker')

/**
 * Golden BDS cache: `<cache>/bds/<version>/` holds the extracted official zip with the server
 * binary renamed to `bedrock_server-<version>` (what itzg's `VERSION=EXISTING` expects). Instances
 * hardlink the binary and copy the rest, so starting a server never touches the network.
 *
 * `pull()` is idempotent: image present + marker file present → nothing to do. The zip is verified
 * against the pinned size and sha256 before extraction; extraction goes to a temp dir that is
 * renamed into place, so a crash never leaves a half-extracted golden dir behind.
 */

const MARKER = '.bedboo-golden.json'

function log (opts, ...args) {
  if (opts.log !== false) (opts.log || console.log)(...args)
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyZip (file, expected = BDS_ZIP) {
  const { size } = fs.statSync(file)
  if (size !== expected.size) return `size ${size} != ${expected.size}`
  const sha = await sha256File(file)
  if (sha !== expected.sha256) return `sha256 ${sha} != ${expected.sha256}`
  return null
}

/** @returns {object|null} the golden marker if the golden dir is complete */
function goldenInfo (p = paths()) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(p.golden, MARKER), 'utf8'))
    if (info.version !== BDS_VERSION || info.sha256 !== BDS_ZIP.sha256) return null
    if (!fs.statSync(path.join(p.golden, SERVER_BINARY)).isFile()) return null
    return info
  } catch {
    return null
  }
}

/** Throws a helpful error when `bds pull` has not been run. */
function requireGolden (p = paths()) {
  const info = goldenInfo(p)
  if (!info) {
    throw new Error(`BDS ${BDS_VERSION} golden cache missing at ${p.golden}: run \`corepack pnpm bds pull\` first`)
  }
  return info
}

async function download (url, dest, opts) {
  // curl honours HTTPS_PROXY/NO_PROXY (Node's fetch does not by default)
  const part = `${dest}.part-${process.pid}`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  log(opts, `downloading ${url}`)
  try {
    await docker.run('curl', ['-fsSL', '--retry', '3', '-A', 'bedboo-harness', '-o', part, url], { timeout: 30 * 60 * 1000 })
    fs.renameSync(part, dest)
  } finally {
    fs.rmSync(part, { force: true })
  }
}

/**
 * Pull the docker image and populate the golden BDS cache (idempotent).
 * @param {{ force?: boolean, log?: false|Function, env?: object }} [opts]
 * @returns {Promise<{ golden: string, image: string, pulled: boolean, extracted: boolean }>}
 */
async function pull (opts = {}) {
  const p = paths(opts.env)
  const result = { golden: p.golden, image: IMAGE, pulled: false, extracted: false }

  if (!(await docker.imageExists(IMAGE))) {
    log(opts, `docker pull ${IMAGE}`)
    await docker.run('docker', ['pull', IMAGE], { timeout: 30 * 60 * 1000, inherit: opts.log !== false })
    result.pulled = true
  } else {
    log(opts, `image ${IMAGE} present`)
  }

  if (!opts.force && goldenInfo(p)) {
    log(opts, `golden BDS ${BDS_VERSION} present at ${p.golden}`)
    return result
  }

  let problem = fs.existsSync(p.zip) ? await verifyZip(p.zip) : 'missing'
  if (problem) {
    if (problem !== 'missing') log(opts, `cached zip invalid (${problem}), downloading again`)
    fs.rmSync(p.zip, { force: true })
    await download(BDS_ZIP.url, p.zip, opts)
    problem = await verifyZip(p.zip)
    if (problem) {
      fs.rmSync(p.zip, { force: true })
      throw new Error(`downloaded ${BDS_ZIP.url} does not match the pinned checksum: ${problem}`)
    }
  }
  log(opts, `zip verified (sha256 ${BDS_ZIP.sha256})`)

  const tmp = `${p.golden}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    log(opts, `extracting to ${p.golden}`)
    await extractZip(p.zip, tmp)
    fs.renameSync(path.join(tmp, 'bedrock_server'), path.join(tmp, SERVER_BINARY))
    fs.chmodSync(path.join(tmp, SERVER_BINARY), 0o555) // shared by hardlinks: never written
    fs.writeFileSync(path.join(tmp, MARKER), JSON.stringify({
      version: BDS_VERSION,
      sha256: BDS_ZIP.sha256,
      size: BDS_ZIP.size,
      url: BDS_ZIP.url,
      extractedAt: new Date().toISOString()
    }, null, 2) + '\n')
    // replace atomically (a concurrent pull may have finished first: keep whichever is complete)
    if (fs.existsSync(p.golden)) {
      const old = `${p.golden}.old-${process.pid}`
      fs.renameSync(p.golden, old)
      fs.renameSync(tmp, p.golden)
      makeWritable(old)
      fs.rmSync(old, { recursive: true, force: true })
    } else {
      fs.mkdirSync(path.dirname(p.golden), { recursive: true })
      fs.renameSync(tmp, p.golden)
    }
  } finally {
    if (fs.existsSync(tmp)) {
      makeWritable(tmp)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  result.extracted = true
  log(opts, `golden BDS ${BDS_VERSION} ready at ${p.golden}`)
  return result
}

/** Extract with the host's `unzip`, else with the image's (run as the host user so files stay ours). */
async function extractZip (zip, dest) {
  if (await docker.commandExists('unzip')) {
    await docker.run('unzip', ['-q', '-o', zip, '-d', dest], { timeout: 10 * 60 * 1000 })
    return
  }
  const uid = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000'
  await docker.run('docker', ['run', '--rm', '-u', uid, '--entrypoint', 'unzip',
    '-v', `${path.dirname(zip)}:/zip:ro`, '-v', `${dest}:/out`, IMAGE,
    '-q', '-o', `/zip/${path.basename(zip)}`, '-d', '/out'], { timeout: 10 * 60 * 1000 })
}

/** Restore the owner's write bit (the golden binary is 0555) so rm works everywhere. */
function makeWritable (dir) {
  const bin = path.join(dir, SERVER_BINARY)
  try { fs.chmodSync(bin, 0o755) } catch {}
}

module.exports = { pull, goldenInfo, requireGolden, verifyZip, sha256File, MARKER }
