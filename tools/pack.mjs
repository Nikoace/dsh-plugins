#!/usr/bin/env node
// Zero-dependency packer for the DSH plugin bundles. `npm run pack` calls this.
//
// For each bundle under this repository it writes:
//
//   dist/<name>-<version>.zip          stored (uncompressed) ZIP archive
//   dist/<name>-<version>.zip.sha256   sha256sum-compatible checksum file
//
// The ZIP writer is implemented from scratch (CRC32 table, local file headers,
// central directory, end-of-central-directory) so packing needs no dependencies.
// Archives are reproducible: entries are sorted, timestamps are fixed, and there
// are no extra fields, so packing unchanged sources produces identical bytes and
// therefore an identical sha256.
//
// Entry selection follows each bundle's package.json "files" list (the same list
// DSH installation uses) plus package.json itself. `*` matches within one path
// segment; a trailing `*` also includes everything below a directory. The
// repository-level LICENSE / CHANGELOG / README are not part of a bundle, so
// they are not packed; the bundle's own README.md is included because its
// package.json lists it. Keep the root LICENSE next to the archives when
// redistributing.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST = join(ROOT, 'dist')
const BUNDLES = ['dsh-sidebar-clock', 'dsh-token-cost', 'dsh-github', 'dsh-html-preview']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected polynomial 0xEDB88320)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// ZIP writer: stored entries only, fixed DOS timestamp 1980-01-01 00:00:00
// ---------------------------------------------------------------------------
const DOS_TIME = 0
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1 // 0x0021
const UTF8_FLAG = 0x0800

function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > 0xffff) throw new Error('entry name too long for ZIP: ' + name)
    if (data.length > 0xffffffff) throw new Error('entry too large for ZIP: ' + name)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract (2.0)
    local.writeUInt16LE(UTF8_FLAG, 6) // general purpose flag: UTF-8 names
    local.writeUInt16LE(0, 8) // compression method: stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    chunks.push(local, nameBytes, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // central directory header signature
    cd.writeUInt16LE((3 << 8) | 20, 4) // version made by: UNIX, ZIP 2.0
    cd.writeUInt16LE(20, 6) // version needed to extract
    cd.writeUInt16LE(UTF8_FLAG, 8)
    cd.writeUInt16LE(0, 10) // stored
    cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30) // extra field length
    cd.writeUInt16LE(0, 32) // comment length
    cd.writeUInt16LE(0, 34) // disk number start
    cd.writeUInt16LE(0, 36) // internal attributes
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // external attributes: -rw-r--r--
    cd.writeUInt32LE(offset, 42) // offset of local header
    central.push(cd, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // number of this disk
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(entries.length, 8) // entries on this disk
  end.writeUInt16LE(entries.length, 10) // total entries
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16) // central directory offset
  end.writeUInt16LE(0, 20) // comment length
  return Buffer.concat([...chunks, centralBytes, end])
}

// ---------------------------------------------------------------------------
// "files" list expansion
// ---------------------------------------------------------------------------
function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function patternToRegExp(pattern) {
  const segments = pattern.split('/')
  const parts = segments.map((segment, index) => {
    const isLast = index === segments.length - 1
    if (segment === '*' && isLast) return '.*' // trailing *: include the whole subtree
    return escapeRegExp(segment).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  })
  return new RegExp('^' + parts.join('/') + '$')
}

function walkFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = prefix ? prefix + '/' + entry.name : entry.name
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(abs, rel))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(rel)
    }
  }
  return files
}

function collectEntries(bundleDir) {
  const packagePath = join(bundleDir, 'package.json')
  if (!existsSync(packagePath)) throw new Error('missing package.json in ' + bundleDir)
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (!pkg.name) throw new Error(packagePath + ': package.json has no "name"')
  if (!pkg.version) throw new Error(pkg.name + ': package.json has no "version"')
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(pkg.name + ': package.json has no "files" list')
  }
  if (!pkg.files.every((pattern) => typeof pattern === 'string')) {
    throw new Error(pkg.name + ': package.json "files" must contain only strings')
  }
  const available = walkFiles(bundleDir).sort((a, b) => a.localeCompare(b, 'en'))
  const entries = new Map()
  entries.set('package.json', readFileSync(packagePath))

  for (const pattern of pkg.files) {
    const matcher = patternToRegExp(pattern)
    const matches = available.filter((rel) => matcher.test(rel))
    if (matches.length === 0) {
      throw new Error(`${pkg.name}: "files" entry matched nothing: ${pattern}`)
    }
    for (const rel of matches) {
      if (entries.has(rel)) continue
      entries.set(rel, readFileSync(join(bundleDir, ...rel.split('/'))))
    }
  }

  return {
    pkg,
    entries: [...entries].map(([name, data]) => ({ name, data })),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
mkdirSync(DIST, { recursive: true })
let totalBytes = 0

for (const bundle of BUNDLES) {
  const bundleDir = join(ROOT, bundle)
  if (!existsSync(bundleDir)) throw new Error('bundle directory not found: ' + bundle)

  const { pkg, entries } = collectEntries(bundleDir)
  const shortName = String(pkg.name || bundle).replace(/^@[^/]+\//, '') || bundle
  const baseName = `${shortName}-${pkg.version}`
  const zipBytes = buildZip(entries)
  const zipPath = join(DIST, baseName + '.zip')
  writeFileSync(zipPath, zipBytes)

  const checksum = createHash('sha256').update(zipBytes).digest('hex')
  const checksumPath = zipPath + '.sha256'
  // sha256sum format: "<hex>  <file>"; same line order as `sha256sum` output.
  writeFileSync(checksumPath, `${checksum}  ${baseName}.zip\n`)

  totalBytes += zipBytes.length
  console.log(`packed ${pkg.name}@${pkg.version} -> ${relative(ROOT, zipPath)} (${entries.length} files, ${zipBytes.length} bytes)`)
  for (const { name, data } of entries) console.log(`  + ${name} (${data.length} bytes)`)
  console.log(`  sha256 ${checksum}`)
}

console.log('')
console.log(`wrote ${BUNDLES.length} archives (${totalBytes} bytes) plus .sha256 files to ${relative(ROOT, DIST) || 'dist'}/`)
