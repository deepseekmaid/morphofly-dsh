// Flatten multi-physical-line prose paragraphs in working docs (verify-md-wrap convention).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

const STRUCTURAL = /^\s*(#|\||>|-|\*|\d+\.|```|\t)/

function joinLines(lines) {
  let out = ''
  for (const line of lines) {
    const t = line.trim()
    if (!out) { out = t; continue }
    const prev = out.slice(-1)
    const cur = t[0]
    const ascii = /[A-Za-z0-9)`]/.test(prev) && /[A-Za-z0-9`]/.test(cur)
    out += (ascii ? ' ' : '') + t
  }
  return out
}

let fixedFiles = 0
let flattened = 0
for (const file of walk('.')) {
  const original = readFileSync(file, 'utf8')
  const lines = original.split(/\r?\n/)
  const out = []
  let block = []
  let fence = false
  const flush = () => {
    if (!block.length) return
    const isQuote = block.every(l => l.trim().startsWith('>'))
    const hasStruct = block.some(l => STRUCTURAL.test(l))
    if ((isQuote || !hasStruct) && block.length > 1) {
      if (isQuote) out.push('> ' + joinLines(block.map(l => l.replace(/^\s*>\s?/, ''))))
      else out.push(joinLines(block))
      flattened++
    } else {
      out.push(...block)
    }
    block = []
  }
  for (const line of lines) {
    if (line.trim().startsWith('```')) { flush(); fence = !fence; out.push(line); continue }
    if (fence) { out.push(line); continue }
    if (!line.trim()) { flush(); out.push('') } else block.push(line)
  }
  flush()
  const result = out.join('\n')
  if (result !== original) { writeFileSync(file, result); fixedFiles++; console.log('flattened: ' + file) }
}
console.log(`files=${fixedFiles} paragraphs=${flattened}`)
