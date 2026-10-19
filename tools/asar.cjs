#!/usr/bin/env node
// Minimal ASAR archive reader for inspecting the installed DSH packages.
// Usage:
//   node asar.cjs list [<asar>] [prefix]
//   node asar.cjs cat <path> [start] [length]
//   node asar.cjs search <regex> [pathPrefix]
//   node asar.cjs extract <path> <outFile>
'use strict';
const fs = require('fs');
const path = require('path');

const ASAR = process.env.DSH_ASAR || 'D:\\software\\deepseek-harness\\resources\\app.asar';

let archiveCache;
function loadArchive(file = ASAR) {
  if (archiveCache && archiveCache.file === file) return archiveCache;
  const buf = fs.readFileSync(file);
  const idx = buf.indexOf('{"files"');
  if (idx < 0) throw new Error('asar header not found');
  const jsonLen = buf.readUInt32LE(idx - 4);
  const json = buf.subarray(idx, idx + jsonLen).toString('utf8');
  const header = JSON.parse(json);

  // Detect the data start by validating a known file's bytes.
  const probe = findEntry(header, 'dsh/package.json') || findEntry(header, 'dsh/node_modules/@deepseek-ai/dsh-llm/package.json');
  let dataStart = -1;
  if (probe) {
    const base = idx + jsonLen;
    for (const candidate of [base, (base + 3) & ~3, base + 1, base + 2, base + 3, idx + jsonLen + 8]) {
      const start = candidate + Number(probe.offset);
      const len = Number(probe.size);
      if (start + len > buf.length) continue;
      const head = buf.subarray(start, start + Math.min(40, len)).toString('utf8');
      if (head.trimStart().startsWith('{')) {
        dataStart = candidate;
        break;
      }
    }
  }
  if (dataStart < 0) throw new Error('could not locate asar data section');
  archiveCache = { file, buf, header, dataStart };
  return archiveCache;
}

function findEntry(header, p) {
  const parts = p.split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node || !node.files) return undefined;
    node = node.files[part];
    if (!node) return undefined;
  }
  return node.files ? undefined : node;
}

function walk(header, visit, prefix = '') {
  for (const [name, node] of Object.entries(header.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (node.files) walk(node, visit, p);
    else visit(p, node);
  }
}

function readEntry(entry) {
  const a = loadArchive();
  const start = a.dataStart + Number(entry.offset);
  return a.buf.subarray(start, start + Number(entry.size));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const a = loadArchive();
  if (cmd === 'list') {
    const prefix = args[0] || '';
    const out = [];
    walk(a.header, (p, node) => {
      if (p.startsWith(prefix)) out.push(`${String(node.size).padStart(9)}  ${p}`);
    });
    console.log(out.join('\n'));
  } else if (cmd === 'cat') {
    const entry = findEntry(a.header, args[0]);
    if (!entry) throw new Error(`not found: ${args[0]}`);
    const bytes = readEntry(entry);
    const start = Number(args[1] || 0);
    const len = args[2] ? Number(args[2]) : bytes.length;
    process.stdout.write(bytes.subarray(start, start + len).toString('utf8'));
  } else if (cmd === 'extract') {
    const entry = findEntry(a.header, args[0]);
    if (!entry) throw new Error(`not found: ${args[0]}`);
    fs.mkdirSync(path.dirname(args[1]), { recursive: true });
    fs.writeFileSync(args[1], readEntry(entry));
    console.log(`wrote ${args[1]} (${entry.size} bytes)`);
  } else if (cmd === 'search') {
    const re = new RegExp(args[0], 'm');
    const prefix = args[1] || '';
    const textExt = /\.(js|cjs|mjs|ts|tsx|jsx|json|md|yml|yaml|css|d\.ts)$/;
    let fileCount = 0;
    let matchCount = 0;
    walk(a.header, (p, node) => {
      if (!p.startsWith(prefix) || !textExt.test(p) || Number(node.size) > 12 * 1024 * 1024) return;
      fileCount++;
      let text;
      try { text = readEntry(node).toString('utf8'); } catch { return; }
      if (!text.includes(args[0].replace(/[.*+?^${}()|[\]\\]/g, '').slice(0, 3))) {
        // cheap prefilter above is unreliable; fall through to regex
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matchCount++;
          const line = lines[i].length > 400 ? lines[i].slice(0, 400) + '…' : lines[i];
          console.log(`${p}:${i + 1}: ${line.trim()}`);
          if (matchCount >= 400) { console.error('...truncated at 400 matches'); return; }
        }
      }
    });
    console.error(`searched ${fileCount} files, ${matchCount} matches`);
  } else {
    console.error('usage: list|cat|search|extract');
    process.exit(1);
  }
}
main();
