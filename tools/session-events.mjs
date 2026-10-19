// Decode a concatenated-frame zstd Session log into its JSONL records.
// Session persistence appends one independent zstd frame per write, so a plain
// decompress stops after the first frame; this scans the frame magic instead.
import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * @param {Buffer} buffer - whole .zstd file.
 * @returns {string} concatenated decoded text.
 */
export function decodeSessionLog(buffer) {
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    const index = buffer.indexOf(MAGIC, offset)
    if (index < 0) break
    try {
      const frame = zlib.zstdDecompressSync(buffer.subarray(index))
      parts.push(frame.toString('utf8'))
      offset = index + 1
    } catch {
      offset = index + 1
    }
  }
  return parts.join('')
}

/** Parse decoded JSONL into records. */
export function parseRecords(text) {
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // A frame boundary is not necessarily a line boundary; ignore noise.
    }
  }
  return records
}

if (process.argv[1] && process.argv[1].endsWith('session-events.mjs')) {
  const file = process.argv[2]
  const text = decodeSessionLog(fs.readFileSync(file))
  const records = parseRecords(text)
  const counts = new Map()
  for (const record of records) {
    const type = record.event?.type ?? record.type ?? 'unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  console.log('records', records.length, 'chars', text.length)
  console.log('first', JSON.stringify(records[0]).slice(0, 300))
  console.log('counts', JSON.stringify([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)))
}
