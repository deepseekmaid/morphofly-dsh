// Analyze DSH session logs: event-type byte shares, assistant/message stream redundancy,
// runtime-context snapshot growth. Read-only.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSessionFile } from './zstd-frames.mjs'

const ROOT = 'C:/Users/butte/.dsh/sessions'
const B = (s) => Buffer.byteLength(s, 'utf8')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

const targets = walk(ROOT).sort((a, b) => statSync(b).size - statSync(a).size)
console.log(`sessions: ${targets.length}`)

const typeAgg = new Map()
const perSession = []
let totalEvents = 0
let totalBytes = 0
let streamBytes = 0
let streamRecords = 0
let streamTextChars = 0
let msgBytes = 0
let msgTextChars = 0
const chunkType = new Map()
const rcSnapshots = []
const timeSnapshots = []
let toolResultBytes = 0
let toolCallBytes = 0
let jobBytes = 0

for (const file of targets) {
  let text
  try {
    text = decodeSessionFile(file).text
  } catch (e) {
    continue
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const sid = file.split('session-')[1]?.split('\\')[0] ?? file
  let sBytes = 0
  let sEvents = 0
  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    sEvents++
    totalEvents++
    const bytes = B(line)
    sBytes += bytes
    totalBytes += bytes
    const type = ev.type ?? '(header)'
    const a = typeAgg.get(type) ?? { count: 0, bytes: 0 }
    a.count++
    a.bytes += bytes
    typeAgg.set(type, a)
    if (type === 'tool/result') toolResultBytes += bytes
    if (type === 'tool/call') toolCallBytes += bytes
    if (type.startsWith('job/')) jobBytes += bytes

    if (type === 'assistant/message' && Array.isArray(ev.data?.stream)) {
      const sB = B(JSON.stringify(ev.data.stream))
      streamBytes += sB
      msgBytes += B(JSON.stringify(ev.data.message))
      for (const rec of ev.data.stream) {
        streamRecords++
        const ct = rec?.chunk?.type ?? rec?.type ?? 'unknown'
        const c = chunkType.get(ct) ?? { n: 0, bytes: 0 }
        c.n++
        c.bytes += B(JSON.stringify(rec))
        chunkType.set(ct, c)
        if (typeof rec?.chunk?.text === 'string') streamTextChars += rec.chunk.text.length
      }
      for (const block of ev.data.message?.content ?? []) if (typeof block?.text === 'string') msgTextChars += block.text.length
    }
    if (type === 'user/message') {
      const kind = ev.data?.source?.kind
      const txt = ev.data?.content?.[0]?.text ?? ''
      if (kind === 'runtime-context') rcSnapshots.push({ sid, seq: ev.seq, bytes, chars: txt.length, text: txt })
      if (kind === 'time-context') timeSnapshots.push({ sid, seq: ev.seq, bytes, chars: txt.length, text: txt })
    }
  }
  perSession.push({ sid, events: sEvents, mb: sBytes / 1048576, compressedMB: statSync(file).size / 1048576 })
}

perSession.sort((a, b) => b.mb - a.mb)
console.log(`\n== totals ==`)
console.log(`events=${totalEvents}  uncompressed=${(totalBytes / 1048576).toFixed(1)} MB  compressed=${(perSession.reduce((s, x) => s + x.compressedMB, 0)).toFixed(1)} MB`)
console.log(`\n== per-session (top 6) ==`)
for (const s of perSession.slice(0, 6)) console.log(`${s.sid.slice(0, 12)} events=${String(s.events).padStart(5)} raw=${s.mb.toFixed(2).padStart(6)} MB compressed=${s.compressedMB.toFixed(2)}MB`)

console.log(`\n== event type share (top 12) ==`)
for (const [type, a] of [...typeAgg.entries()].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 12)) {
  console.log(`${type.padEnd(22)} n=${String(a.count).padStart(6)} ${(a.bytes / 1048576).toFixed(2).padStart(7)} MB ${((a.bytes / totalBytes) * 100).toFixed(1).padStart(5)}%  avg=${(a.bytes / a.count / 1024).toFixed(1)}KB`)
}

console.log(`\n== assistant/message internals ==`)
console.log(`stream ${(streamBytes / 1048576).toFixed(2)} MB (${streamRecords} records, avg ${(streamBytes / streamRecords).toFixed(0)}B)`)
console.log(`message ${(msgBytes / 1048576).toFixed(2)} MB  -> stream/message = ${(streamBytes / msgBytes).toFixed(2)}x`)
console.log(`text chars: stream=${streamTextChars} message=${msgTextChars} ratio=${(streamTextChars / msgTextChars).toFixed(3)}`)
for (const [ct, c] of [...chunkType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  chunk ${ct.padEnd(14)} n=${String(c.n).padStart(7)} ${(c.bytes / 1048576).toFixed(2).padStart(7)} MB avg=${(c.bytes / c.n).toFixed(0)}B`)
}

const rcMb = rcSnapshots.reduce((s, x) => s + x.bytes, 0) / 1048576
console.log(`\n== runtime-context snapshots: ${rcSnapshots.length} events, ${rcMb.toFixed(2)} MB (${((rcMb / (totalBytes / 1048576)) * 100).toFixed(1)}%) ==`)
const bySid = new Map()
for (const s of rcSnapshots) {
  const list = bySid.get(s.sid) ?? []
  list.push(s)
  bySid.set(s.sid, list)
}
for (const [sid, list] of [...bySid.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) {
  const sizes = list.map((x) => x.chars).sort((a, b) => a - b)
  const uniq = new Set(list.map((x) => x.text)).size
  let identical = 0
  for (let i = 1; i < list.length; i++) if (list[i].text === list[i - 1].text) identical++
  console.log(`  ${sid.slice(0, 12)}: n=${list.length} chars min/med/max=${sizes[0]}/${sizes[Math.floor(sizes.length / 2)]}/${sizes.at(-1)} distinct=${uniq} identicalConsecutive=${identical}/${list.length - 1}`)
  // measure how much would be saved if identical-prefix snapshots were deduped
  let dupBytes = 0
  const seen = new Set()
  for (const s of list) {
    if (seen.has(s.text)) dupBytes += s.bytes
    else seen.add(s.text)
  }
  console.log(`    exact-duplicate bytes: ${(dupBytes / 1048576).toFixed(2)} MB of ${(list.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(2)} MB`)
  console.log(`    first: ${JSON.stringify(list[0].text.slice(0, 150))}`)
  console.log(`    last : ${JSON.stringify(list.at(-1).text.slice(0, 150))}`)
}

console.log(`\n== time-context snapshots: ${timeSnapshots.length}, ${(timeSnapshots.reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(2)} MB ==`)
for (const s of timeSnapshots.slice(0, 2)) console.log(`  ${s.sid.slice(0, 12)} chars=${s.chars} preview=${JSON.stringify(s.text.slice(0, 200))}`)
