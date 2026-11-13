'use strict'
/**
 * winicon.js — 快捷方式图标解析
 *
 * 取图标的优先级（逐个尝试，最后取「最清晰的那张」）：
 *   1) .lnk 里写的 IconLocation（用户自定义图标的快捷方式靠它，例如安装器的 ProductIcon）
 *   2) .lnk 的真实目标 exe —— 自己解析 PE 资源，通常能拿到 256x256 原图
 *   3) .url 里写的 IconFile（Steam 游戏快捷方式）
 *   4) 快捷方式文件本身（交给 Shell 兜底）
 *
 * 直接对 .lnk 调 getFileIcon 只能得到「通用快捷方式」白纸图标，
 * 而对某些 Electron 应用的 exe 调 getFileIcon 也会退化成「未知程序」图标，
 * 所以 exe 一律优先走 peicon 自己抠资源。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { app, nativeImage } = require('electron')
const peicon = require('./peicon')

const iconCache = new Map()
const IMAGE_EXT = /\.(ico|png|jpe?g|bmp|gif|webp)$/i
const EXE_EXT = /\.(exe|dll|ocx|cpl|scr|mun)$/i
const MAX_PX = 128

let tmpDir = ''

/** 把内存里的 .ico 落地成临时文件（nativeImage 只能从路径读 ico） */
function tmpIcoFile(buf) {
  if (!tmpDir) {
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskdock-ico-'))
    } catch {
      return ''
    }
  }
  const f = path.join(tmpDir, crypto.createHash('sha1').update(buf).digest('hex') + '.ico')
  try {
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf)
    return f
  } catch {
    return ''
  }
}

/**
 * 解析一批 .lnk 的 TargetPath 与 IconLocation
 * 返回 Map<lnkPath, { target, icon }>
 */
function resolveLnkTargets(paths) {
  return new Promise((resolve) => {
    const list = [...new Set((paths || []).filter((p) => p && fs.existsSync(p)))]
    if (!list.length) return resolve(new Map())

    let dir
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskdock-'))
    } catch {
      return resolve(new Map())
    }
    const inFile = path.join(dir, 'in.txt')
    const outFile = path.join(dir, 'out.txt')
    try {
      fs.writeFileSync(inFile, list.join('\r\n'), 'utf8')
    } catch {
      return resolve(new Map())
    }

    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$ws = New-Object -ComObject WScript.Shell',
      '$lines = New-Object System.Collections.ArrayList',
      `foreach ($p in (Get-Content -LiteralPath "${inFile}" -Encoding UTF8)) { if ($p) { $s = $ws.CreateShortcut($p); [void]$lines.Add($p + [char]9 + $s.TargetPath + [char]9 + $s.IconLocation) } }`,
      `Set-Content -LiteralPath "${outFile}" -Value $lines -Encoding UTF8`
    ].join('; ')

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 25000 },
      () => {
        const map = new Map()
        try {
          const text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue
            const parts = line.split('\t')
            const from = (parts[0] || '').trim()
            if (!from) continue
            map.set(from, {
              target: (parts[1] || '').trim(),
              icon: (parts[2] || '').trim()
            })
          }
        } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
        resolve(map)
      })
  })
}

/** 读 .url（Internet 快捷方式）里写的 IconFile= —— Steam 游戏快捷方式就靠它 */
function urlIconFile(urlPath) {
  try {
    const text = fs.readFileSync(urlPath, 'utf8')
    const m = text.match(/^IconFile=(.+)$/im)
    if (!m) return ''
    const raw = m[1].trim().replace(/^"|"$/g, '')
    if (!raw) return ''
    const p = path.isAbsolute(raw) ? raw : path.join(path.dirname(urlPath), raw)
    return fs.existsSync(p) ? p : ''
  } catch {
    return ''
  }
}

/** "C:\x\app.exe,3" → "C:\x\app.exe"；带了索引的先忽略索引 */
function stripIconIndex(loc) {
  if (!loc) return ''
  const s = loc.trim().replace(/^"|"$/g, '')
  if (!s) return ''
  const m = s.match(/^(.*?),(-?\d+)$/)
  const p = m ? m[1] : s
  return fs.existsSync(p) ? p : ''
}

/** 所有可能的图标来源，按优先级排好 */
function iconCandidates(target, iconLoc, filePath) {
  const out = []
  const push = (p) => {
    if (p && fs.existsSync(p) && !out.includes(p)) out.push(p)
  }
  push(stripIconIndex(iconLoc))
  push(target)
  if (/\.url$/i.test(filePath)) push(urlIconFile(filePath))
  push(filePath)
  return out
}

/**
 * 决定从哪个文件取图标（兼容旧调用）
 * 返回 { sources: string[], primary: string }
 */
function iconSource(target, filePath) {
  const list = iconCandidates(target, '', filePath)
  return list[0] || filePath
}

function toDataUrl(img) {
  if (!img || img.isEmpty()) return ''
  const size = img.getSize()
  const big = Math.max(size.width, size.height)
  const out = big > MAX_PX ? img.resize({ width: MAX_PX, height: MAX_PX, quality: 'best' }) : img
  try {
    return out.toDataURL()
  } catch {
    return ''
  }
}

/** 从单个文件取一张图标（dataURL），取不到返回 '' */
async function iconFrom(filePath) {
  if (!filePath) return ''

  // 图标本身就是图片：直接读，能拿到原始分辨率（.ico 常有 256px）
  if (IMAGE_EXT.test(filePath)) {
    try {
      const img = nativeImage.createFromPath(filePath)
      const url = toDataUrl(img)
      if (url) return url
    } catch { /* ignore */ }
  }

  // exe / dll（或没有扩展名的资源文件）：自己解析 PE 资源
  if (EXE_EXT.test(filePath) || !path.extname(filePath)) {
    const ico = peicon.extractIconBuffer(filePath)
    if (ico) {
      const tmp = tmpIcoFile(ico)
      if (tmp) {
        try {
          const img = nativeImage.createFromPath(tmp)
          const url = toDataUrl(img)
          if (url) return url
        } catch { /* ignore */ }
      }
    }
  }

  // Shell 兜底
  for (const size of ['large', 'normal']) {
    try {
      const img = await app.getFileIcon(filePath, { size })
      const url = toDataUrl(img)
      if (url) return url
    } catch { /* ignore */ }
  }
  return ''
}

/**
 * 取某条目最合适的图标（dataURL），带缓存。
 * 会依次尝试所有候选来源，取「信息量最大」的那张（真图标比通用图标大得多）。
 */
async function iconDataUrl(item) {
  const filePath = typeof item === 'string' ? item : item.file
  const target = typeof item === 'string' ? '' : item.target
  const iconLoc = typeof item === 'string' ? '' : item.iconLoc

  const list = iconCandidates(target, iconLoc, filePath)
  const key = list.join('|')
  if (iconCache.has(key)) return iconCache.get(key)

  let best = ''
  for (const src of list) {
    const url = await iconFrom(src)
    if (url.length > best.length) best = url
    // 已经拿到清晰大图就不用再试后面的了
    if (best.length > 4000) break
  }
  iconCache.set(key, best)
  return best
}

function clearCache() {
  iconCache.clear()
}

module.exports = { resolveLnkTargets, iconDataUrl, iconSource, iconCandidates, urlIconFile, clearCache }
