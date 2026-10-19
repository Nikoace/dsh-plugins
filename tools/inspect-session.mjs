// Inspect one stored Session log: decompress and print event type counts.
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const buf = fs.readFileSync(file)
let text
const zstd = zlib.zstdDecompressSync ?? zlib.zstdDecompress
if (zstd) text = zstd(buf).toString('utf8')
else {
  const stream = zlib.createZstdDecompress()
  const chunks = []
  stream.on('data', (chunk) => chunks.push(chunk))
  await new Promise((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
    stream.end(buf)
  })
  text = Buffer.concat(chunks).toString('utf8')
}
const lines = text.split('\n').filter((line) => line.trim().length > 0)
const counts = new Map()
let header = null
const samples = []
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const event = record.event ?? record
  const type = event.type ?? record.type ?? 'unknown'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (header === null) header = record
  if ((type === 'assistant/message' || type === 'assistant/attempt' || type === 'request/header' || type === 'step/start') && samples.length < 3) {
    samples.push({ type, keys: Object.keys(event.data ?? {}), usage: event.data?.usage ?? null })
  }
}
console.log('lines', lines.length)
console.log('textLength', text.length)
console.log('textHead', JSON.stringify(text.slice(0, 600)))
console.log('header', JSON.stringify(header).slice(0, 400))
console.log('counts', JSON.stringify([...counts.entries()]))
console.log('samples', JSON.stringify(samples, null, 2))
