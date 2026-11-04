// Measure what the assistant/message.stream field actually costs and what is duplicated.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSessionFile } from './zstd-frames.mjs'

const ROOT = 'C:/Users/butte/.dsh/sessions'
const B = (s) => Buffer.byteLength(s, 'utf8')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

const acc = {
  streamBytes: 0, events: 0, records: 0,
  dtBytes: 0, dtNumbers: 0,
  textsBytes: 0, textsChars: 0,
  blockEndBytes: 0, blockEndChars: 0,
  finishBytes: 0, usageBytes: 0, blockStartBytes: 0,
  toolArgsBytes: 0, toolArgsChars: 0,
  otherChunkBytes: 0,
  msgBytes: 0, msgTextChars: 0, msgReasoningChars: 0,
  jsonKeyBytes: 0,
}

for (const file of walk(ROOT)) {
  let text
  try { text = decodeSessionFile(file).text } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant/message' || !Array.isArray(ev.data?.stream)) continue
    acc.events++
    acc.streamBytes += B(JSON.stringify(ev.data.stream))
    acc.msgBytes += B(JSON.stringify(ev.data.message))
    for (const block of ev.data.message?.content ?? []) {
      if (typeof block?.text === 'string') {
        if (block.type === 'reasoning') acc.msgReasoningChars += block.text.length
        acc.msgTextChars += block.text.length
      }
    }
    for (const rec of ev.data.stream) {
      acc.records++
      const top = rec.type
      const inner = rec.chunk?.type
      const kind = inner ?? top
      if (Array.isArray(rec.dt)) {
        acc.dtBytes += B(JSON.stringify(rec.dt))
        acc.dtNumbers += rec.dt.length
      }
      if (Array.isArray(rec.texts)) {
        acc.textsBytes += B(JSON.stringify(rec.texts))
        for (const t of rec.texts) acc.textsChars += t.length
      }
      if (kind === 'block-end' && rec.chunk?.block) {
        acc.blockEndBytes += B(JSON.stringify(rec.chunk.block))
        if (typeof rec.chunk.block.text === 'string') acc.blockEndChars += rec.chunk.block.text.length
      }
      if (kind === 'finish') acc.finishBytes += B(JSON.stringify(rec))
      if (kind === 'usage') acc.usageBytes += B(JSON.stringify(rec))
      if (kind === 'block-start') acc.blockStartBytes += B(JSON.stringify(rec))
      if (kind === 'tool-call-chunks') {
        acc.toolArgsBytes += B(JSON.stringify(rec.args ?? []))
        for (const a of rec.args ?? []) acc.toolArgsChars += String(a).length
      }
      if (!['block-end','finish','usage','block-start','tool-call-chunks','reasoning-chunks','text-chunks'].includes(kind)) {
        acc.otherChunkBytes += B(JSON.stringify(rec))
      }
      // key-name overhead: strip values
      const stripped = JSON.stringify(rec, (k, v) => (typeof v === 'string' ? '' : typeof v === 'number' ? 0 : Array.isArray(v) ? [] : v))
      acc.jsonKeyBytes += B(stripped)
    }
  }
}

const mb = (n) => (n / 1048576).toFixed(2)
console.log(`assistant/message events: ${acc.events}, total stream records: ${acc.records}`)
console.log(`stream bytes: ${mb(acc.streamBytes)} MB ; message bytes: ${mb(acc.msgBytes)} MB ; ratio ${(acc.streamBytes / acc.msgBytes).toFixed(2)}x`)
console.log(`message text chars: ${acc.msgTextChars} (reasoning ${acc.msgReasoningChars})`)
console.log('')
console.log('-- stream composition (bytes / share of stream) --')
const parts = [
  ['dt timing arrays', acc.dtBytes, `${acc.dtNumbers} numbers, avg ${(acc.dtBytes / acc.records).toFixed(0)}B/record`],
  ['texts arrays', acc.textsBytes, `${acc.textsChars} chars (${(acc.textsChars / acc.msgTextChars * 100).toFixed(1)}% of message text)`],
  ['block-end full block', acc.blockEndBytes, `${acc.blockEndChars} chars (${(acc.blockEndChars / acc.msgTextChars * 100).toFixed(1)}% of message text)`],
  ['finish + replayState', acc.finishBytes, ''],
  ['usage', acc.usageBytes, ''],
  ['block-start', acc.blockStartBytes, ''],
  ['tool-call args', acc.toolArgsBytes, `${acc.toolArgsChars} chars`],
  ['key-name overhead (approx)', acc.jsonKeyBytes, 'same JSON keys repeated per record'],
]
for (const [name, bytes, note] of parts) {
  console.log(`${name.padEnd(26)} ${mb(bytes).padStart(7)} MB  ${((bytes / acc.streamBytes) * 100).toFixed(1).padStart(5)}%  ${note}`)
}
const uniquePayload = acc.textsBytes + acc.blockEndBytes + acc.finishBytes + acc.usageBytes + acc.blockStartBytes + acc.toolArgsBytes
console.log('')
console.log(`non-payload (timing + structural) ≈ ${mb(acc.streamBytes - uniquePayload)} MB = ${(((acc.streamBytes - uniquePayload) / acc.streamBytes) * 100).toFixed(1)}% of stream`)
console.log(`duplicate-candidate payload (texts + block-end + args) ≈ ${mb(acc.textsBytes + acc.blockEndBytes + acc.toolArgsBytes)} MB`)
