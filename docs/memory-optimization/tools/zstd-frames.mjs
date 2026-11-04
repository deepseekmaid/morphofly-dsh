// Split concatenated zstd frames (DSH session logs append one frame per commit) and decode each.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528

/** Return the byte length of the zstd frame starting at `off` using header + block parsing. */
export function frameLength(buf, off) {
  if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`no zstd magic at ${off}`)
  off += 4
  const fhd = buf[off++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) off += 1 // Window_Descriptor
  const dictIdSize = [0, 1, 2, 4][dictIdFlag]
  off += dictIdSize
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  off += fcsSize
  let last = 0
  while (!last) {
    const h = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
    off += 3
    last = h & 1
    const type = (h >> 1) & 3
    const size = h >> 3
    if (type === 1) off += 1 // RLE: one byte payload
    else if (type === 2) off += size // compressed
    else if (type === 0) off += size // raw
    else throw new Error('reserved block type')
  }
  if (checksum) off += 4
  return off
}

/** Decode every concatenated frame into one UTF-8 string. */
export function decodeSessionFile(path) {
  const buf = readFileSync(path)
  const parts = []
  let off = 0
  while (off < buf.length) {
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== MAGIC) break
    const end = frameLength(buf, off)
    parts.push(zstdDecompressSync(buf.subarray(off, end)))
    off = end
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, trailing: buf.length - off }
}
