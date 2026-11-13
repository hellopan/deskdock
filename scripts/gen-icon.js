'use strict'
/**
 * gen-icon.js — 用纯 Node 生成应用图标（PNG + ICO），无需任何依赖
 * 运行：node scripts/gen-icon.js
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0
    rgba.copy(raw, o, y * width * 4, (y + 1) * width * 4)
    o += width * 4
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------------- 图形绘制 ---------------- */

const lerp = (a, b, t) => a + (b - a) * t
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

function roundedCoverage(px, py, x0, y0, x1, y1, r) {
  // 点是否在圆角矩形内
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r + 1e-6
}

function render(size) {
  const S = size
  const px = Buffer.alloc(S * S * 4)
  const A = hex('#7A9BFF')
  const B = hex('#8A63FF')
  const SS = 4 // 每个像素 4x4 超采样

  // 外框
  const m = S * 0.045
  const box = { x0: m, y0: m, x1: S - m, y1: S - m, r: S * 0.235 }
  // 内部 2x2 方块
  const s = S * 0.163
  const gap = S * 0.052
  const total = s * 2 + gap
  const start = (S - total) / 2
  const sq = S * 0.048 // 小方块圆角
  const squares = [
    { x: start, y: start, a: 1 },
    { x: start + s + gap, y: start, a: 0.62 },
    { x: start, y: start + s + gap, a: 0.62 },
    { x: start + s + gap, y: start + s + gap, a: 0.34 }
  ]

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let inside = 0
      let acc = [0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS
          const fy = y + (sy + 0.5) / SS
          if (!roundedCoverage(fx, fy, box.x0, box.y0, box.x1, box.y1, box.r)) continue
          inside++
          const t = Math.min(1, ((fx - box.x0) / (box.x1 - box.x0) * 0.45 + (fy - box.y0) / (box.y1 - box.y0) * 0.55))
          let col = [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]
          for (const q of squares) {
            if (roundedCoverage(fx, fy, q.x, q.y, q.x + s, q.y + s, sq)) {
              col = [
                lerp(col[0], 255, q.a),
                lerp(col[1], 255, q.a),
                lerp(col[2], 255, q.a)
              ]
            }
          }
          acc[0] += col[0]
          acc[1] += col[1]
          acc[2] += col[2]
        }
      }
      const total2 = SS * SS
      const o = (y * S + x) * 4
      if (!inside) {
        px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0
        continue
      }
      px[o] = Math.round(acc[0] / inside)
      px[o + 1] = Math.round(acc[1] / inside)
      px[o + 2] = Math.round(acc[2] / inside)
      px[o + 3] = Math.round(255 * (inside / total2))
    }
  }
  return encodePNG(S, S, px)
}

/* ---------------- ICO 打包 ---------------- */

function buildICO(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)

  const entries = []
  let offset = 6 + count * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4)   // planes
    e.writeUInt16LE(32, 6)  // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

/* ---------------- main ---------------- */

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map((size) => ({ size, data: render(size) }))

fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data)
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO(pngs))
console.log('✓ build/icon.png (256x256)')
console.log('✓ build/icon.ico (' + sizes.join(', ') + ')')
