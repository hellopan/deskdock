'use strict'
/**
 * store.js — 配置与快捷方式文件的持久化
 *
 * 数据目录（v1.1.3 起放在用户数据目录，重装/卸载/更新都不会被删）：
 *   %APPDATA%\DeskDock\DeskDockData\
 *       config.json          分类、快捷方式索引、设置
 *       shortcuts/           所有 .lnk / .url 实体文件
 *       backup/              config.json 的历史快照
 *
 * ⚠️ 历史教训：v1.1.2 及以前把数据放在安装目录里，electron-builder 的
 * NSIS 卸载器在"覆盖安装"时会把 $INSTDIR 整个搬到临时目录再删掉，
 * 用户数据跟着一起没了。所以数据必须放在安装目录之外。
 */

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { app, shell } = require('electron')
const winicon = require('./winicon')

/* 开发模式下 app.getVersion() 返回的是 Electron 自己的版本号，
   设置里的"关于"会显示成 33.x；打包后才是应用版本。统一读 package.json。 */
let APP_VERSION = ''
try { APP_VERSION = require('../../package.json').version } catch { APP_VERSION = '' }

const PALETTE = ['#5B8CFF', '#39C0A0', '#B07BFF', '#F5A24B', '#4FC3E8', '#F2728C', '#8FBF3F', '#C9A227']
const SHORTCUT_EXT = ['.lnk', '.url', '.appref-ms']
const DATA_DIR_NAME = 'DeskDockData'
const MAX_BACKUPS = 40

let BASE = null
let cfg = null
let configPath = null
let loadedFresh = false      // 本次启动时数据目录里还没有配置（真正的首次运行）
let recoveredCount = 0       // 启动时从 shortcuts 目录"自愈"回来的条目数
let lastSnapshotAt = 0

/* ------------------------------------------------------------------ 工具 */

function randId() {
  return Math.random().toString(36).slice(2, 8)
}

function safeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60) || 'shortcut'
}

function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${Date.now()}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function exeDir() {
  try { return path.dirname(app.getPath('exe')) } catch { return process.cwd() }
}

/** 老版本的位置：安装目录\DeskDockData（只用来迁移/兼容） */
function legacyDir() {
  return path.join(exeDir(), DATA_DIR_NAME)
}

/** 新位置：用户数据目录，安装/卸载/覆盖升级都不会碰 */
function userDir() {
  return path.join(app.getPath('userData'), DATA_DIR_NAME)
}

/** 开发模式还是放项目目录里，方便调试 */
function devDir() {
  return path.join(app.getAppPath(), DATA_DIR_NAME)
}

/** 绿色版：exe 旁边放一个 DeskDockPortable.txt 就地把数据留在应用目录 */
function isPortable() {
  try { return fs.existsSync(path.join(exeDir(), 'DeskDockPortable.txt')) } catch { return false }
}

/** 目录整体复制（不删源，宁可多留一份） */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  let entries = []
  try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    if (ent.isDirectory()) copyDir(s, d)
    else {
      try { fs.copyFileSync(s, d) } catch { /* 单个文件失败不影响其它 */ }
    }
  }
}

/** 老用户升级：把安装目录里的数据搬到用户目录（源目录保持不动） */
function migrateIfNeeded(dir) {
  if (dir !== userDir()) return
  if (fs.existsSync(path.join(dir, 'config.json'))) return
  const old = legacyDir()
  if (old === dir) return
  if (!fs.existsSync(path.join(old, 'config.json'))) return
  try {
    copyDir(old, dir)
    console.log('[store] 已把数据从', old, '迁移到', dir)
  } catch (err) {
    console.error('[store] 数据迁移失败', err.message)
  }
}

function baseDir() {
  if (BASE) return BASE
  const candidates = []
  // 开发/调试用：把数据目录指到别处，方便用真实数据复现问题
  if (process.env.DESKDOCK_DATA_DIR) candidates.push(process.env.DESKDOCK_DATA_DIR)
  if (!app.isPackaged) candidates.push(devDir())
  if (isPortable()) candidates.push(legacyDir())
  candidates.push(userDir())      // 正式安装版：用户数据目录（安全）
  candidates.push(legacyDir())    // 兜底：用户目录写不进去时才退回安装目录
  for (const dir of candidates) {
    if (isDirWritable(dir)) {
      BASE = dir
      break
    }
  }
  if (!BASE) BASE = candidates[candidates.length - 1]
  fs.mkdirSync(path.join(BASE, 'shortcuts'), { recursive: true })
  migrateIfNeeded(BASE)
  return BASE
}

function shortcutsDir() {
  const d = path.join(baseDir(), 'shortcuts')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function backupDir() {
  const d = path.join(baseDir(), 'backup')
  fs.mkdirSync(d, { recursive: true })
  return d
}

/* ------------------------------------------------------------- 自动备份 */

function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^config-\d{4}-\d{2}-\d{2}_\d{6}.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(MAX_BACKUPS)) {
      try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 给当前 config.json 拍一张快照。
 * force=false 时最多每 10 分钟一张，避免频繁设置操作刷出一堆文件。
 */
function snapshot(reason, force) {
  if (!configPath || !fs.existsSync(configPath)) return ''
  const now = Date.now()
  if (!force && now - lastSnapshotAt < 10 * 60 * 1000) {
    // 仍然刷新一份 latest，方便"出事了至少还有最近一次"
    try { fs.copyFileSync(configPath, path.join(backupDir(), 'config-latest.json')) } catch { /* ignore */ }
    return ''
  }
  lastSnapshotAt = now
  try {
    const dir = backupDir()
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    const file = path.join(dir, `config-${stamp}${reason ? '-' + reason : ''}.json`)
    fs.copyFileSync(configPath, file)
    fs.copyFileSync(configPath, path.join(dir, 'config-latest.json'))
    pruneBackups(dir)
    return file
  } catch {
    return ''
  }
}

/** 立即备份（设置页按钮 / 退出前的最后一份） */
function backupNow(reason) {
  return snapshot(reason || 'manual', true)
}

function listBackups() {
  try {
    const dir = backupDir()
    return fs.readdirSync(dir)
      .filter((f) => /^config-.*\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { file: f, size: st.size, at: st.mtimeMs }
      })
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/** 从某个备份恢复（恢复前会先给当前状态再拍一张快照） */
function restoreBackup(file) {
  const dir = backupDir()
  const abs = path.join(dir, path.basename(String(file || '')))
  if (!fs.existsSync(abs)) return { ok: false, message: '备份文件不存在' }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch {
    return { ok: false, message: '备份文件已损坏' }
  }
  if (!raw || !Array.isArray(raw.items)) return { ok: false, message: '备份内容不是有效配置' }
  snapshot('before-restore', true)
  cfg = normalize(raw)
  for (const it of cfg.items) it.missing = !fs.existsSync(absolute(it.file))
  configPath = path.join(baseDir(), 'config.json')
  save()
  return { ok: true, items: cfg.items.length, categories: cfg.categories.length }
}

/* ------------------------------------------------------------ 默认配置 */

function defaultConfig() {
  const cats = [
    { id: 'cat_' + randId(), name: '编程开发', color: PALETTE[0], collapsed: false },
    { id: 'cat_' + randId(), name: '聊天社交', color: PALETTE[1], collapsed: false },
    { id: 'cat_' + randId(), name: '影音娱乐', color: PALETTE[2], collapsed: false },
    { id: 'cat_' + randId(), name: '游戏', color: PALETTE[3], collapsed: true },
    { id: 'cat_' + randId(), name: '办公工具', color: PALETTE[4], collapsed: true },
    { id: 'cat_' + randId(), name: '未分类', color: PALETTE[6], collapsed: false }
  ]
  return {
    version: 1,
    settings: {
      edge: 'left',          // left | right | top | bottom
      autoHide: true,
      pinned: false,
      peek: 4,               // 隐藏后留在屏幕上的感应条宽度(px)
      hideDelay: 550,        // 鼠标移出后自动隐藏的延时(ms)
      thickness: 330,        // 坞的厚度(px)，仅贴上下边时有效
      columns: 6,            // 每排图标个数(4–10)，决定面板宽度
      iconSize: 44,          // 图标尺寸(px)
      tileSize: 74,          // 磁贴宽度(px)
      theme: 'dark',         // dark | light
      launchAtLogin: false,
      showLabels: true,
      importKeepCategory: true, // 从桌面导入时，坞里已有同名条目则保留原分类
      cooldownMs: 2000,      // 点击快捷方式后的冷却时长(ms)，期间再点不响应；0 = 关闭
      offset: null,          // 沿边的偏移；null = 居中
      displayId: null        // 坞所在的显示器 id；null = 主屏/自动推断
    },
    categories: cats,
    items: []
  }
}

function normalize(raw) {
  const base = defaultConfig()
  const data = raw && typeof raw === 'object' ? raw : {}
  const settings = Object.assign({}, base.settings, data.settings || {})
  let categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories.filter((c) => c && c.id && c.name).map((c, i) => ({
      id: String(c.id),
      name: String(c.name).slice(0, 24),
      color: c.color || PALETTE[i % PALETTE.length],
      collapsed: !!c.collapsed
    }))
    : base.categories
  const ids = new Set(categories.map((c) => c.id))
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && it.id && it.file)
    .map((it) => ({
      id: String(it.id),
      categoryId: ids.has(it.categoryId) ? it.categoryId : categories[0].id,
      name: String(it.name || '快捷方式').slice(0, 60),
      file: String(it.file),
      target: it.target || '',
      iconLoc: typeof it.iconLoc === 'string' ? it.iconLoc : undefined,
      missing: !!it.missing,
      addedAt: it.addedAt || Date.now()
    }))

  /* 「每排图标个数」：
   * 老配置没有这一项，按旧规则（分类里最多的一组）快照一次写回，
   * 之后面板宽度只由用户改，不再随内容增删跳变。 */
  if (!data.settings || !('columns' in data.settings)) {
    const counts = new Map()
    for (const it of items) counts.set(it.categoryId, (counts.get(it.categoryId) || 0) + 1)
    let max = 0
    for (const n of counts.values()) if (n > max) max = n
    settings.columns = max || base.settings.columns
  }
  settings.columns = Math.max(4, Math.min(10, Math.round(Number(settings.columns) || 6)))

  return { version: 1, settings, categories, items }
}

/* ------------------------------------------------------------ 读写配置 */

function load() {
  configPath = path.join(baseDir(), 'config.json')
  const existed = fs.existsSync(configPath)
  loadedFresh = !existed
  let raw = null
  if (existed) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch {
      // 配置损坏：备份后重建，避免直接丢数据
      try {
        fs.copyFileSync(configPath, configPath + '.broken-' + Date.now())
      } catch { /* ignore */ }
      raw = null
    }
  }
  cfg = normalize(raw)

  // ⚠️ 这里绝对不能再把"文件不存在"的条目直接删掉：
  // 一旦目录被外部清空，配置文件会被写回成空列表，等于把索引彻底销毁。
  // 现在只做缺失标记，界面显示灰态，并提供"修复 / 从备份恢复"。
  markMissing()

  // 自愈：索引空了但 shortcuts 目录里还有文件，就从文件名反推重建索引
  if (!cfg.items.length) recoverFromFiles()

  save(true)
  // 第一次运行/刚从老目录迁移过来：先留一张初始快照，后面出问题有得退
  if (!listBackups().length) snapshot('init', true)
  return cfg
}

/** 给每条打上 missing 标记，返回缺失数量 */
function markMissing() {
  if (!cfg) return 0
  let missing = 0
  for (const it of cfg.items) {
    it.missing = !fs.existsSync(absolute(it.file))
    if (it.missing) missing++
  }
  return missing
}

function missingCount() {
  return cfg ? cfg.items.filter((it) => it.missing).length : 0
}

/**
 * 从 shortcuts 目录里的实际文件重建条目（文件名格式：itm_xxxx—显示名.lnk）。
 * 用于"配置文件丢了但文件还在"以及"文件被外部删了一半"的情况。
 */
function recoverFromFiles() {
  let files = []
  try {
    files = fs.readdirSync(shortcutsDir()).filter((f) => SHORTCUT_EXT.includes(path.extname(f).toLowerCase()))
  } catch {
    return 0
  }
  if (!files.length) return 0
  const fallback = cfg.categories.find((c) => c.name === '未分类') || cfg.categories[cfg.categories.length - 1]
  const known = new Set(cfg.items.map((it) => path.basename(it.file).toLowerCase()))
  files.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  let added = 0
  for (const f of files) {
    if (known.has(f.toLowerCase())) continue
    const stem = path.basename(f, path.extname(f))
    const parts = stem.split('—')
    const id = /^itm_[a-z0-9]+$/i.test(parts[0]) ? parts[0] : 'itm_' + randId() + randId()
    const name = (parts.length > 1 ? parts.slice(1).join('—') : stem).slice(0, 60) || stem
    cfg.items.push({
      id,
      categoryId: fallback.id,
      name,
      file: path.join('shortcuts', f),
      target: '',
      addedAt: Date.now(),
      missing: false
    })
    added++
  }
  recoveredCount = added
  return added
}

/** 用条目里记下的 target 重建丢失的 .lnk（配置还在就能原地救回来） */
function rebuildShortcut(item) {
  return new Promise((resolve) => {
    const abs = absolute(item.file)
    const target = item.target || ''
    if (!target || !fs.existsSync(target)) return resolve(false)
    const icon = item.iconLoc || ''
    const ps = [
      '$ErrorActionPreference="Stop"',
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${abs.replace(/'/g, "''")}')`,
      `$s.TargetPath='${target.replace(/'/g, "''")}'`,
      `$s.WorkingDirectory='${path.dirname(target).replace(/'/g, "''")}'`,
      icon ? `$s.IconLocation='${icon.replace(/'/g, "''")}'` : '',
      '$s.Save()'
    ].filter(Boolean).join('; ')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 8000 }, (err) => resolve(!err))
  })
}

/** 批量修复失效条目：能给回来的都救回来，救不回来的保留但标记 */
async function repairMissing() {
  const c = get()
  const broken = c.items.filter((it) => it.missing || !fs.existsSync(absolute(it.file)))
  if (!broken.length) return { repaired: 0, unrepaired: 0, total: 0 }
  let repaired = 0
  for (const it of broken) {
    if (!it.file.toLowerCase().endsWith('.lnk')) continue
    if (await rebuildShortcut(it)) {
      it.missing = false
      repaired++
    }
  }
  markMissing()
  save()
  return { repaired, unrepaired: broken.length - repaired, total: broken.length }
}

function save(silent) {
  if (!cfg) return
  if (!configPath) configPath = path.join(baseDir(), 'config.json')
  // 落盘前先给旧文件留一份快照（10 分钟一张）
  if (!silent) snapshot('', false)
  const text = JSON.stringify(cfg, null, 2)
  const tmp = configPath + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, configPath)
  } catch {
    fs.writeFileSync(configPath, text, 'utf8')
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

function absolute(file) {
  return path.isAbsolute(file) ? file : path.join(baseDir(), file)
}

function get() {
  if (!cfg) load()
  return cfg
}

function publicState() {
  const c = get()
  return {
    settings: c.settings,
    categories: c.categories,
    items: c.items.map((it) => ({
      id: it.id,
      categoryId: it.categoryId,
      name: it.name,
      target: it.target,
      iconLoc: it.iconLoc,
      missing: !!it.missing,
      addedAt: it.addedAt,
      path: absolute(it.file)
    })),
    dataDir: baseDir(),
    shortcutsDir: shortcutsDir(),
    missingCount: missingCount(),
    firstRun: loadedFresh,
    recoveredCount,
    appVersion: APP_VERSION || app.getVersion(),
    isPackaged: app.isPackaged
  }
}

/* ------------------------------------------- .lnk 真实目标（用于取图标） */

async function resolveTargets() {
  const c = get()
  const pending = c.items.filter(
    (it) => it.file.toLowerCase().endsWith('.lnk') && (!it.target || it.iconLoc === undefined)
  )
  if (!pending.length) return false
  const map = await winicon.resolveLnkTargets(pending.map((it) => absolute(it.file)))
  let changed = false
  for (const it of pending) {
    const info = map.get(absolute(it.file))
    if (!info) continue
    if (info.target && fs.existsSync(info.target) && it.target !== info.target) {
      it.target = info.target
      changed = true
    }
    // IconLocation 可能是 "C:\x\app.exe,0" 或 "C:\x\ProductIcon,0"，原样存下来
    const loc = info.icon || ''
    if (it.iconLoc !== loc) {
      it.iconLoc = loc
      changed = true
    }
    if (it.iconLoc === undefined) {
      it.iconLoc = ''
      changed = true
    }
  }
  if (changed) save()
  return changed
}

/* ------------------------------------------------------------ 分类操作 */

function addCategory(name, color) {
  const c = get()
  const used = new Set(c.categories.map((x) => x.color))
  const free = PALETTE.find((p) => !used.has(p)) || PALETTE[c.categories.length % PALETTE.length]
  const cat = {
    id: 'cat_' + randId(),
    name: String(name || '新分类').trim().slice(0, 24) || '新分类',
    color: color || free,
    collapsed: false
  }
  c.categories.push(cat)
  save()
  return cat
}

function renameCategory(id, name) {
  const c = get()
  const cat = c.categories.find((x) => x.id === id)
  if (!cat) return false
  const next = String(name || '').trim().slice(0, 24)
  if (!next) return false
  cat.name = next
  save()
  return true
}

function deleteCategory(id) {
  const c = get()
  if (c.categories.length <= 1) return { ok: false, message: '至少要保留一个分类' }
  const idx = c.categories.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false, message: '分类不存在' }
  snapshot('before-del-category', true)
  const fallback = c.categories.find((x) => x.id !== id)
  let moved = 0
  for (const it of c.items) {
    if (it.categoryId === id) {
      it.categoryId = fallback.id
      moved++
    }
  }
  c.categories.splice(idx, 1)
  save()
  return { ok: true, moved, fallback: fallback.name }
}

function reorderCategories(ids) {
  const c = get()
  const map = new Map(c.categories.map((x) => [x.id, x]))
  const next = []
  for (const id of ids) {
    const cat = map.get(id)
    if (cat) {
      next.push(cat)
      map.delete(id)
    }
  }
  for (const rest of map.values()) next.push(rest)
  c.categories = next
  save()
}

function setCollapsed(id, collapsed) {
  const c = get()
  const cat = c.categories.find((x) => x.id === id)
  if (!cat) return
  cat.collapsed = !!collapsed
  save()
}

function setCategoryColor(id, color) {
  const c = get()
  const cat = c.categories.find((x) => x.id === id)
  if (!cat || !color) return false
  cat.color = String(color)
  save()
  return true
}

/* ---------------------------------------------------- 快捷方式条目操作 */

function uniqueFileName(dir, base, ext) {
  let name = base + ext
  let n = 2
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base} (${n++})${ext}`
  }
  return name
}

/** 把一个磁盘上的 .lnk/.url 收进来（复制），返回 item 或 null */
function absorbFile(srcPath, categoryId, displayName) {
  const c = get()
  if (!fs.existsSync(srcPath)) return null
  const ext = path.extname(srcPath).toLowerCase()
  if (!SHORTCUT_EXT.includes(ext)) return null
  const cat = c.categories.find((x) => x.id === categoryId) || c.categories[0]
  const id = 'itm_' + randId() + randId()
  const rawName = displayName || path.basename(srcPath, path.extname(srcPath))
  const fileName = uniqueFileName(shortcutsDir(), `${id}—${safeName(rawName)}`, ext)
  fs.copyFileSync(srcPath, path.join(shortcutsDir(), fileName))
  const item = {
    id,
    categoryId: cat.id,
    name: rawName.slice(0, 60),
    file: path.join('shortcuts', fileName),
    target: '',
    addedAt: Date.now()
  }
  c.items.push(item)
  save()
  return item
}

function moveItem(id, categoryId, index) {
  const c = get()
  const item = c.items.find((x) => x.id === id)
  if (!item) return
  const cat = c.categories.find((x) => x.id === categoryId)
  if (!cat) return

  const targetList = c.items.filter((x) => x.categoryId === categoryId && x.id !== id)
  const at = Math.max(0, Math.min(index === undefined || index === null ? targetList.length : index, targetList.length))

  // 从旧位置摘掉
  const from = c.items.indexOf(item)
  c.items.splice(from, 1)
  item.categoryId = categoryId

  // 计算在扁平数组里的落点：目标分类中第 at 个元素之前
  let insertAt
  if (at < targetList.length) {
    insertAt = c.items.indexOf(targetList[at])
  } else if (targetList.length) {
    insertAt = c.items.indexOf(targetList[targetList.length - 1]) + 1
  } else {
    insertAt = c.items.length
  }
  c.items.splice(insertAt, 0, item)
  save()
}

function renameItem(id, name) {
  const c = get()
  const item = c.items.find((x) => x.id === id)
  if (!item) return { ok: false }
  const next = String(name || '').trim().slice(0, 60)
  if (!next) return { ok: false, message: '名称不能为空' }
  item.name = next
  // 同步重命名磁盘文件（保留 id 前缀，失败不影响使用）
  try {
    const oldAbs = absolute(item.file)
    const dir = path.dirname(oldAbs)
    const ext = path.extname(oldAbs)
    const prefix = path.basename(oldAbs, ext).split('—')[0]
    const wanted = `${prefix}—${safeName(next)}${ext}`
    const target = path.join(dir, wanted)
    if (target !== oldAbs && !fs.existsSync(target)) {
      fs.renameSync(oldAbs, target)
      item.file = path.join(path.dirname(item.file), wanted)
    }
  } catch { /* ignore */ }
  save()
  return { ok: true }
}

/** 从坞中移除；restore=true 时把文件放回桌面 */
function removeItem(id, restore) {
  const c = get()
  const idx = c.items.findIndex((x) => x.id === id)
  if (idx < 0) return { ok: false }
  snapshot('before-remove-item', true)
  const item = c.items[idx]
  const abs = absolute(item.file)
  let restored = ''
  if (restore && fs.existsSync(abs)) {
    try {
      const desk = app.getPath('desktop')
      const target = path.join(desk, uniqueFileName(desk, path.basename(abs, path.extname(abs)).split('—').slice(1).join('—') || item.name, path.extname(abs)))
      fs.copyFileSync(abs, target)
      restored = target
    } catch { /* ignore */ }
  }
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs)
  } catch { /* ignore */ }
  c.items.splice(idx, 1)
  save()
  return { ok: true, restored }
}

/* ------------------------------------------------------- 桌面扫描/导入 */

function desktopDirs() {
  const dirs = []
  try { dirs.push(app.getPath('desktop')) } catch { /* ignore */ }
  const pub = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : ''
  if (pub && fs.existsSync(pub) && !dirs.includes(pub)) dirs.push(pub)
  return dirs
}

function scanDesktop() {
  const found = []
  const seen = new Set()
  for (const dir of desktopDirs()) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isFile()) continue
      const ext = path.extname(ent.name).toLowerCase()
      if (!SHORTCUT_EXT.includes(ext)) continue
      if (ent.name.startsWith('~$')) continue
      const full = path.join(dir, ent.name)
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      let size = 0
      try { size = fs.statSync(full).size } catch { /* ignore */ }
      found.push({
        path: full,
        name: path.basename(ent.name, ext),
        fileName: ent.name,
        fromPublic: dir !== desktopDirs()[0],
        size
      })
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return found
}

/**
 * 批量导入桌面快捷方式。
 * moveOriginals=true 时，复制成功后才把桌面原文件删掉（等于"搬进来"，文件仍完整保留在数据目录）。
 */
/** 删桌面原件时优先丢进回收站，误删还能捞回来；失败才真删 */
async function trashFile(p) {
  try {
    await shell.trashItem(p)
    return true
  } catch {
    try {
      fs.unlinkSync(p)
      return true
    } catch {
      return false
    }
  }
}

/** 名称归一化：忽略大小写、首尾空格和连续空白，用来判断"是不是同一个快捷方式" */
function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 在坞里找与桌面这个文件对应的既有条目（按显示名匹配） */
function findExistingItem(displayName) {
  const c = get()
  const key = normName(displayName)
  if (!key) return null
  const same = c.items.filter((it) => normName(it.name) === key)
  if (!same.length) return null
  // 优先选文件还在的那个；都不在就选第一个（用来按原 id 补回）
  return same.find((it) => fs.existsSync(absolute(it.file))) || same[0]
}

/**
 * 把桌面文件补进一个已存在的条目：文件还在就什么都不做（返回 false），
 * 文件丢了就用这次导入的文件补回去（返回 true）。分类、排序、id 全部保持原样。
 */
async function refillExisting(item, srcPath) {
  const abs = absolute(item.file)
  if (fs.existsSync(abs)) return false
  const ext = path.extname(srcPath).toLowerCase()
  let dest = abs
  if (path.extname(abs).toLowerCase() !== ext) {
    // 扩展名对不上（.url 变 .lnk 之类），用同一个 id 前缀重新落一个文件
    const base = path.basename(abs, path.extname(abs))
    dest = path.join(shortcutsDir(), uniqueFileName(shortcutsDir(), base, ext))
    item.file = path.join('shortcuts', path.basename(dest))
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(srcPath, dest)
  item.missing = false
  try {
    const map = await winicon.resolveLnkTargets([dest])
    const hit = map.get(dest)
    if (hit && hit.target) item.target = hit.target
  } catch { /* icon 解析失败不影响功能 */ }
  return true
}

/**
 * 批量导入桌面快捷方式。
 * @param {boolean} moveOriginals   导入后把桌面原件丢回收站
 * @param {boolean} keepOriginal    true = 坞里已有同名的条目时，保留它原来的分类，只同步文件
 */
async function importFromDesktop(paths, categoryId, moveOriginals, keepOriginal) {
  const keep = keepOriginal !== false
  const result = { imported: 0, kept: 0, repaired: 0, removed: 0, failed: [], items: [], details: [] }
  // 同一批里同名的文件只能命中一次"已有条目"，第二个必须当成新条目，
  // 否则桌面上两个同名快捷方式会被悄悄吞掉一个
  const matched = new Set()
  for (const p of paths) {
    try {
      const displayName = path.basename(p, path.extname(p))
      const key = normName(displayName)
      const existing = keep && !matched.has(key) ? findExistingItem(displayName) : null
      if (existing) matched.add(key)

      if (existing) {
        const cat = get().categories.find((x) => x.id === existing.categoryId)
        const fixed = await refillExisting(existing, p)
        result.items.push(existing.id)
        result.kept++
        if (fixed) result.repaired++
        result.details.push({
          name: existing.name,
          action: fixed ? 'refill' : 'keep',
          category: cat ? cat.name : ''
        })
        if (moveOriginals) {
          const copy = absolute(existing.file)
          try {
            const a = fs.statSync(copy)
            const b = fs.statSync(p)
            if (a.size === b.size && await trashFile(p)) result.removed++
          } catch { /* ignore */ }
        }
        continue
      }

      const item = absorbFile(p, categoryId)
      if (!item) {
        result.failed.push({ path: p, reason: '不支持的类型' })
        continue
      }
      result.items.push(item.id)
      result.imported++
      const cat = get().categories.find((x) => x.id === item.categoryId)
      result.details.push({ name: item.name, action: 'new', category: cat ? cat.name : '' })
      if (moveOriginals) {
        // 只有确认副本存在且体积一致，才移除桌面原件
        const copy = absolute(item.file)
        try {
          const a = fs.statSync(copy)
          const b = fs.statSync(p)
          if (a.size === b.size && await trashFile(p)) result.removed++
        } catch { /* ignore */ }
      }
    } catch (err) {
      result.failed.push({ path: p, reason: err.message })
    }
  }
  save()
  return result
}

function addFilesFromPaths(paths, categoryId) {
  const out = { imported: 0, items: [] }
  for (const p of paths) {
    const item = absorbFile(p, categoryId)
    if (item) {
      out.imported++
      out.items.push(item.id)
    }
  }
  return out
}

function restoreAllToDesktop() {
  const c = get()
  snapshot('before-restore-all', true)
  const desk = app.getPath('desktop')
  let count = 0
  for (const it of [...c.items]) {
    const abs = absolute(it.file)
    try {
      if (fs.existsSync(abs)) {
        const ext = path.extname(abs)
        const name = path.basename(abs, ext).split('—').slice(1).join('—') || it.name
        fs.copyFileSync(abs, path.join(desk, uniqueFileName(desk, name, ext)))
        fs.unlinkSync(abs)
        count++
      }
    } catch { /* ignore */ }
    const i = c.items.indexOf(it)
    if (i >= 0) c.items.splice(i, 1)
  }
  save()
  return count
}

function updateSettings(patch) {
  const c = get()
  Object.assign(c.settings, patch || {})
  save()
  return c.settings
}

module.exports = {
  load,
  save,
  get,
  publicState,
  absolute,
  baseDir,
  shortcutsDir,
  backupDir,
  backupNow,
  listBackups,
  restoreBackup,
  missingCount,
  markMissing,
  repairMissing,
  recoverFromFiles,
  addCategory,
  renameCategory,
  deleteCategory,
  reorderCategories,
  setCollapsed,
  setCategoryColor,
  resolveTargets,
  moveItem,
  renameItem,
  removeItem,
  scanDesktop,
  importFromDesktop,
  addFilesFromPaths,
  restoreAllToDesktop,
  updateSettings,
  PALETTE
}
