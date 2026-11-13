'use strict'
/**
 * peicon.js — 直接从 exe 的 PE 资源里抠图标（不依赖 Windows Shell）
 *
 * 为什么要自己解析：部分 Electron 应用（DeepSeek Harness / MINI Coder / OpenCode …）
 * 的图标只存在于 exe 资源的某个尺寸/格式里，Shell 的 SHGetFileInfo 会退化成
 * 「未知程序」那张白纸通用图标。自己读 RT_GROUP_ICON / RT_ICON 反而能拿到真图，
 * 而且通常是 256x256，比 Shell 给的 32x32 清楚得多。
 *
 * 性能：只读文件头 + .rsrc 段，不把整个 exe 读进内存。
 */

const fs = require('fs')

function readU16(b, o) { return b.readUInt16LE(o) }
function readU32(b, o) { return b.readUInt32LE(o) }

/** 解析 PE 头，返回 { sections, resRVA } 或 null */
function parsePE(buf) {
  if (buf.length < 0x40 || readU16(buf, 0) !== 0x5a4d) return null
  const peOff = readU32(buf, 0x3c)
  if (peOff + 24 > buf.length) return null
  if (readU32(buf, peOff) !== 0x00004550) return null

  const numSections = readU16(buf, peOff + 6)
  const optSize = readU16(buf, peOff + 20)
  const optOff = peOff + 24
  if (optOff + 2 > buf.length) return null
  const magic = readU16(buf, optOff)
  const ddOff = optOff + (magic === 0x20b ? 112 : 96)
  if (ddOff + 24 > buf.length) return null
  const resRVA = readU32(buf, ddOff + 8 * 2)
  if (!resRVA) return null

  const sections = []
  const secOff = optOff + optSize
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40
    if (o + 40 > buf.length) break
    sections.push({
      va: readU32(buf, o + 12),
      vsize: readU32(buf, o + 8),
      rawSize: readU32(buf, o + 16),
      rawPtr: readU32(buf, o + 20)
    })
  }
  if (!sections.length) return null
  return { sections, resRVA }
}

/** 列出一个资源目录里的条目 */
function dirEntries(buf, dirOff) {
  if (dirOff + 16 > buf.length) return []
  const named = readU16(buf, dirOff + 12)
  const ids = readU16(buf, dirOff + 14)
  const out = []
  for (let i = 0; i < named + ids; i++) {
    const ent = dirOff + 16 + i * 8
    if (ent + 8 > buf.length) break
    const nameField = readU32(buf, ent)
    const offsetField = readU32(buf, ent + 4)
    out.push({
      id: (nameField & 0x80000000) === 0 ? nameField & 0xffff : -1,
      isDir: (offsetField & 0x80000000) !== 0,
      child: offsetField & 0x7fffffff
    })
  }
  return out
}

/**
 * 从 exe / dll 里取出最佳图标，返回 ico Buffer（失败返回 null）
 * 只读取 PE 头（8KB）和资源段，避免大文件全量加载。
 */
function extractIconBuffer(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(8192)
    const hn = fs.readSync(fd, head, 0, head.length, 0)
    const pe = parsePE(head.subarray(0, hn))
    if (!pe) return null

    // 资源目录所在的段
    const sec = pe.sections.find((s) => {
      const span = Math.max(s.vsize, s.rawSize)
      return pe.resRVA >= s.va && pe.resRVA < s.va + span
    })
    if (!sec || !sec.rawPtr) return null

    const rawLen = Math.min(sec.rawSize, 24 * 1024 * 1024)
    if (rawLen <= 0) return null
    const buf = Buffer.alloc(rawLen)
    const n = fs.readSync(fd, buf, 0, rawLen, sec.rawPtr)
    if (n < 32) return null

    const base = pe.resRVA - sec.va
    if (base < 0 || base >= n) return null
    const dataOff = (rva) => {
      const off = rva - sec.va
      return off >= 0 && off + 16 <= n ? off : -1
    }

    const groups = []
    const icons = new Map()

    for (const typeEnt of dirEntries(buf, base)) {
      if (typeEnt.id !== 3 && typeEnt.id !== 14) continue
      if (!typeEnt.isDir) continue
      for (const nameEnt of dirEntries(buf, base + typeEnt.child)) {
        if (!nameEnt.isDir || nameEnt.id < 0) continue
        for (const langEnt of dirEntries(buf, base + nameEnt.child)) {
          if (langEnt.isDir) continue
          const leaf = base + langEnt.child
          if (leaf + 8 > n) continue
          const rva = readU32(buf, leaf)
          const size = readU32(buf, leaf + 4)
          const off = dataOff(rva)
          if (off < 0 || off + size > n) continue
          if (typeEnt.id === 14) {
            if (!groups.some((g) => g.id === nameEnt.id)) groups.push({ id: nameEnt.id, off, size })
          } else if (!icons.has(nameEnt.id)) {
            icons.set(nameEnt.id, { off, size })
          }
        }
      }
    }
    if (!groups.length || !icons.size) return null

    // 选条目最完整的一组
    let best = null
    for (const g of groups) {
      if (g.off + 6 > n) continue
      const count = readU16(buf, g.off + 4)
      if (count > 0 && (!best || count > best.count)) best = { ...g, count }
    }
    if (!best) return null

    const entries = []
    for (let i = 0; i < best.count; i++) {
      const o = best.off + 6 + i * 14
      if (o + 14 > n) break
      const w = buf[o] === 0 ? 256 : buf[o]
      const h = buf[o + 1] === 0 ? 256 : buf[o + 1]
      const bpp = readU16(buf, o + 6)
      const bytes = readU32(buf, o + 8)
      const id = readU16(buf, o + 12)
      const ic = icons.get(id)
      if (!ic) continue
      const size = Math.min(ic.size, bytes || ic.size)
      if (size <= 0) continue
      entries.push({ w, h, bpp, off: ic.off, size })
    }
    if (!entries.length) return null

    // 只带最大的一两张，控制体积
    entries.sort((a, b) => b.w * b.h - a.w * a.h)
    const keep = entries.slice(0, 2)

    const header = Buffer.alloc(6)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(keep.length, 4)

    const dir = Buffer.alloc(16 * keep.length)
    let offset = 6 + 16 * keep.length
    const blobs = []
    keep.forEach((e, i) => {
      const b = dir.subarray(i * 16, i * 16 + 16)
      b[0] = e.w >= 256 ? 0 : e.w
      b[1] = e.h >= 256 ? 0 : e.h
      b[2] = 0
      b[3] = 0
      b.writeUInt16LE(1, 4)
      b.writeUInt16LE(e.bpp || 32, 6)
      b.writeUInt32LE(e.size, 8)
      b.writeUInt32LE(offset, 12)
      offset += e.size
      blobs.push(buf.subarray(e.off, e.off + e.size))
    })
    return Buffer.concat([header, dir, ...blobs])
  } catch {
    return null
  } finally {
    try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}

module.exports = { extractIconBuffer }
