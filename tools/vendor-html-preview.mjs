// Explicit maintenance command; normal builds never fetch the network.
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const version = '3.4.17'
const root = new URL('../dsh-html-preview/vendor/', import.meta.url)
await mkdir(root, { recursive: true })
const files = []
for (const [remote, local] of [['dist/purify.es.mjs', 'purify.es.mjs'], ['LICENSE', 'LICENSE-DOMPurify']]) {
  const url = `https://unpkg.com/dompurify@${version}/${remote}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(new URL(local, root), bytes)
  files.push({ file: local, url, sha256: createHash('sha256').update(bytes).digest('hex') })
  console.log(`Vendored ${local}: ${bytes.length} bytes`)
}
await writeFile(new URL('provenance.json', root), JSON.stringify({ name: 'dompurify', version, files }, null, 2) + '\n')
