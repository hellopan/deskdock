'use strict'
/**
 * main.js — DeskDock 主进程
 * 负责：无边框窗口、贴边感应/自动隐藏、图标提取、托盘、开机自启、IPC
 */

const {
  app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, dialog
} = require('electron')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const winicon = require('./winicon')

const PAD = 18            // 窗口内留给阴影的透明边距（要和 styles.css 的 --pane-pad 一致）
const PANEL_LENGTH = 780  // 竖排时坞的长边最大长度
const MAX_COLS = 10       // 每排最多显示 10 个快捷方式
const MIN_COLS = 4        // 每排最少 4 个（与 store.js 的 columns 夹取一致）
const COL_GAP = 6         // 磁贴列间距（与 styles.css 的 .grid 列间距保持一致）
const PANEL_CHROME = 32   // 面板左右边框 2 + 列表左右内边距 24 + 竖向滚动条 6
const DEBUG = !!process.env.DESKDOCK_DEBUG

function dbg(...args) {
  if (DEBUG) console.log('[dock]', ...args)
}

/** 调试用：把窗口内容截图落盘（相对文件名写到系统临时目录） */
async function debugCapture(name) {
  try {
    const img = await win.webContents.capturePage()
    const file = path.isAbsolute(name || '')
      ? name
      : path.join(app.getPath('temp'), name || 'deskdock-window.png')
    fs.writeFileSync(file, img.toPNG())
    dbg('capture', file, JSON.stringify(win.getBounds()), 'visible=' + win.isVisible())
  } catch (err) {
    dbg('capture err', err.message)
  }
}

/**
 * 调试用：DESKDOCK_DRAG_PATH="x,y;x,y;..." 注入一次完整拖拽，
 * 用来在没有真实鼠标操作的自动化环境里验证"跨屏换边"。
 */
function runDragPath(spec) {
  if (!win || !winReady) return
  const pts = String(spec).split(';')
    .map((s) => s.split(',').map(Number))
    .filter((a) => a.length === 2 && a.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }))
  if (!pts.length) return
  dbg('drag-path start', JSON.stringify(pts))
  startDrag(pts[0])
  for (const p of pts.slice(1)) dragMoveTo(p)
  dragState = null
  store.save()
  dbg('drag-path end',
    'edge=' + settings().edge,
    'displayId=' + dockDisplay().id,
    'panel=' + JSON.stringify(geometry().panel),
    'window=' + JSON.stringify(win.getBounds()))
}

app.setAppUserModelId('com.pzb.deskdock')

// 调试用：让开发版用独立的 userData，避免和已安装的实例抢单实例锁
if (process.env.DESKDOCK_TEST_USERDATA) {
  try { app.setPath('userData', process.env.DESKDOCK_TEST_USERDATA) } catch { /* ignore */ }
}

let win = null
let settingsWin = null
let tray = null
let menuOpen = false
let hideTimer = null
let tickTimer = null
let visible = false
let winReady = false
let dragState = null

/* ------------------------------------------------------------- 几何计算 */

function settings() {
  return store.get().settings
}

function isVerticalEdge() {
  const e = settings().edge
  return e === 'left' || e === 'right'
}

/* ------------------------------------------------- 多显示器：坞归属哪块屏 */
/*
 * 之前 workArea() 写死 getPrimaryDisplay()，导致所有几何都锁在主屏：
 * 光标拖到副屏后，clamp 会把面板位置钳回主屏范围，看上去就是"只能在主屏移动"。
 * 改成"坞有一块归属屏"，拖拽跨屏时把归属屏一起搬过去。
 */

let dockDisplayId = null

function displayById(id) {
  if (id == null) return null
  const n = Number(id)
  return screen.getAllDisplays().find((d) => d.id === n) || null
}

/** 坞当前所在的显示器：内存记录 → 持久化 → 反推窗口矩形 → 主屏 */
function dockDisplay() {
  let d = displayById(dockDisplayId)
  if (d) return d
  d = displayById(settings().displayId)
  if (d) return d
  if (win && winReady && !win.isDestroyed()) {
    try {
      const m = screen.getDisplayMatching(win.getBounds())
      if (m) return m
    } catch { /* ignore */ }
  }
  return screen.getPrimaryDisplay()
}

function setDockDisplay(id) {
  dockDisplayId = Number(id)
  store.updateSettings({ displayId: Number(id) })
}

function workArea() {
  return dockDisplay().workArea
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

/* 每排图标个数：由设置决定（4–10），不再按内容推导，宽度因此稳定 */
function dockCols() {
  return clamp(Math.round(Number(settings().columns) || 6), MIN_COLS, MAX_COLS)
}

/* 竖排时面板需要的宽度：列数 × 磁贴宽 + 列间距 + 固定装饰 */
function panelWidthFor(cols) {
  const tile = clamp(Number(settings().tileSize) || 72, 60, 104)
  return Math.round(PANEL_CHROME + cols * tile + (cols - 1) * COL_GAP)
}

function geometry() {
  const wa = workArea()
  const s = settings()
  const edge = s.edge
  const vertical = isVerticalEdge()

  if (vertical) {
    /* 宽度跟着内容走：最多 10 列，屏幕放不下再逐列退让 */
    let cols = dockCols()
    while (cols > 1 && panelWidthFor(cols) > wa.width - 60) cols--
    const thick = panelWidthFor(cols)
    const length = Math.min(wa.height - 40, PANEL_LENGTH)
    const defOffset = Math.round(wa.y + (wa.height - length) / 2)
    const offset = s.offset == null ? defOffset : clamp(s.offset, wa.y, wa.y + wa.height - length)
    const px = edge === 'left' ? wa.x : wa.x + wa.width - thick
    return {
      cols,
      panel: { x: px, y: offset, width: thick, height: length },
      window: { x: px - PAD, y: offset - PAD, width: thick + PAD * 2, height: length + PAD * 2 }
    }
  }

  /* 贴上下边：宽度占本屏宽度的 80%，居中 */
  const length = Math.min(Math.round(wa.width * 0.8), wa.width - 40)
  const hThick = clamp(s.thickness || 330, 220, 460)
  const maxX = wa.x + wa.width - length
  const offset = s.offset == null ? Math.round(wa.x + (wa.width - length) / 2) : clamp(s.offset, wa.x, maxX)
  const py = edge === 'top' ? wa.y : wa.y + wa.height - hThick
  return {
    cols: 0, // 0 = 不定列数，交给 CSS 按容器宽度自动排列
    panel: { x: offset, y: py, width: length, height: hThick },
    window: { x: offset - PAD, y: py - PAD, width: length + PAD * 2, height: hThick + PAD * 2 }
  }
}

function hitRect() {
  const { panel } = geometry()
  const m = 6
  return {
    x: panel.x - m,
    y: panel.y - m,
    width: panel.width + m * 2,
    height: panel.height + m * 2
  }
}

function inRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/* ---------------------------------------------- 拖拽换边（吸附到别的屏边） */

const EDGE_ZONE = 120   // 光标离屏幕边多近才吸附到那条边
const EDGE_MARGIN = 70  // 必须比贴着当前边的那一侧明显更近，避免沿边拖动时误换向

function edgeDistances(p) {
  const wa = workArea()
  return {
    left: p.x - wa.x,
    right: wa.x + wa.width - p.x,
    top: p.y - wa.y,
    bottom: wa.y + wa.height - p.y
  }
}

/** 光标最靠近哪条边（不达阈值就返回当前边） */
function edgeTargetAt(p) {
  const cur = settings().edge
  const d = edgeDistances(p)
  let best = cur
  let bestD = d[cur]
  for (const k of ['left', 'right', 'top', 'bottom']) {
    if (d[k] < bestD) {
      best = k
      bestD = d[k]
    }
  }
  if (best === cur) return { edge: cur, dist: d[cur] }
  if (bestD > EDGE_ZONE) return { edge: cur, dist: d[cur] }
  if (bestD + EDGE_MARGIN > d[cur]) return { edge: cur, dist: d[cur] }
  return { edge: best, dist: bestD }
}

/** 光标离这块屏哪条边最近（跨屏落地时用它选边，不受当前边干扰） */
function nearestEdge(p, wa) {
  const d = {
    left: Math.abs(p.x - wa.x),
    right: Math.abs(wa.x + wa.width - p.x),
    top: Math.abs(p.y - wa.y),
    bottom: Math.abs(wa.y + wa.height - p.y)
  }
  let best = 'left'
  let bestD = d.left
  for (const k of ['right', 'top', 'bottom']) {
    if (d[k] < bestD) {
      best = k
      bestD = d[k]
    }
  }
  return best
}

/** 切到某条边，并让坞沿这条边居中到光标处 */
function dockToEdge(edge, p) {
  const s = store.get().settings
  const wa = workArea()
  s.edge = edge
  s.offset = null
  const g = geometry()
  const vertical = edge === 'left' || edge === 'right'
  const len = vertical ? g.panel.height : g.panel.width
  s.offset = vertical
    ? clamp(Math.round(p.y - len / 2), wa.y, wa.y + wa.height - len)
    : clamp(Math.round(p.x - len / 2), wa.x, wa.x + wa.width - len)
  const g2 = geometry()
  try { win.setBounds(g2.window) } catch { /* ignore */ }
  sendToRenderer('dock:layout', { edge, cols: g2.cols })
  // 设置窗口里的"贴边位置"要跟着换，否则显示的还是旧的一边
  broadcastAll('settings:changed', { settings: settings() })
  dbg('dock-to-edge', edge, JSON.stringify(g2.panel))
  return g2
}

/* ------------------------------------------------------------- 显示/隐藏 */
/*
 * 窗口位置永远不动（贴在屏幕边缘的固定矩形），"隐藏"由渲染进程把面板平移出去实现，
 * 这样多显示器下不会露到隔壁屏，同时隐藏时整窗鼠标穿透，不挡桌面点击。
 */

function setClickThrough(on) {
  try { win.setIgnoreMouseEvents(!!on) } catch { /* ignore */ }
}

function show(options = {}) {
  if (!win || !winReady) return
  clearTimeout(hideTimer)
  hideTimer = null
  if (visible) {
    if (options.focus) win.focus()
    return
  }
  visible = true
  setClickThrough(false)
  win.showInactive()
  sendToRenderer('dock:visibility', { visible: true })
  dbg('show')
  if (options.focus) win.focus()
}

function hide(force) {
  if (!win) return
  // 设置窗口开着时坞不收：改外观/尺寸能当场看到效果，这是独立窗口的意义
  if (!force && settingsWindowActive()) return
  const s = settings()
  if (!force && (s.pinned || !s.autoHide)) return
  if (!visible) return
  clearTimeout(hideTimer)
  hideTimer = null
  visible = false
  setClickThrough(true)
  sendToRenderer('dock:visibility', { visible: false })
  dbg('hide')
}

function scheduleHide() {
  const s = settings()
  if (s.pinned || !s.autoHide) return
  if (settingsWindowActive()) return
  if (hideTimer) return
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (menuOpen) return scheduleHide()
    hide()
  }, clamp(s.hideDelay || 550, 120, 5000))
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

/* ---------------------------------------------------------------- 轮询 */

// 开发调试用：DESKDOCK_FAKE_CURSOR="2,600" 可以模拟光标位置来验证贴边逻辑
const FAKE_CURSOR = process.env.DESKDOCK_FAKE_CURSOR

function cursorPoint() {
  if (FAKE_CURSOR) {
    const [x, y] = FAKE_CURSOR.split(',').map(Number)
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
  }
  return screen.getCursorScreenPoint()
}

function startWatch() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => {
    if (!win || dragState) return
    const s = settings()
    const p = cursorPoint()
    const disp = dockDisplay()
    const wa = disp.workArea
    const db = disp.bounds
    // 关键：只有光标就在坞所在的那块屏上，才做贴边判断（否则多屏时永远触发）
    const onDockScreen = p.x >= db.x && p.x <= db.x + db.width - 1
      && p.y >= db.y && p.y <= db.y + db.height - 1

    if (!visible) {
      if (!onDockScreen) return
      if (s.pinned || !s.autoHide) return show()
      const { panel } = geometry()
      const near = clamp(s.peek || 4, 1, 12) + 2
      let hot = false
      if (s.edge === 'left') hot = p.x <= wa.x + near && p.y >= panel.y && p.y <= panel.y + panel.height
      else if (s.edge === 'right') hot = p.x >= wa.x + wa.width - near && p.y >= panel.y && p.y <= panel.y + panel.height
      else if (s.edge === 'top') hot = p.y <= wa.y + near && p.x >= panel.x && p.x <= panel.x + panel.width
      else hot = p.y >= wa.y + wa.height - near && p.x >= panel.x && p.x <= panel.x + panel.width
      if (hot) show()
      return
    }

    // 已显示：鼠标移出则准备隐藏
    if (s.pinned || !s.autoHide) return cancelHide()
    const r = hitRect()
    if (inRect(p, r) || menuOpen) cancelHide()
    else scheduleHide()
  }, 80)
}

/* ------------------------------------------------------------ 创建窗口 */

function createWindow() {
  const s = settings()
  const g = geometry()
  win = new BrowserWindow({
    ...g.window,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  win.loadFile(path.join(__dirname, '../renderer/index.html'))

  win.once('ready-to-show', () => {
    // 必须真正 show 出来一次，窗口才会被绘制（哪怕只是屏幕边缘的一条感应条）
    const keepOpen = s.pinned || !s.autoHide
    visible = keepOpen
    try { win.setBounds(geometry().window) } catch { /* ignore */ }
    win.showInactive()
    setClickThrough(!keepOpen)
    winReady = true
    dbg('ready-to-show', 'keepOpen=' + keepOpen, JSON.stringify(win.getBounds()))
    sendToRenderer('dock:visibility', { visible: keepOpen })
  })

  win.on('closed', () => { win = null })

  startWatch()
}

function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.send(channel, payload) } catch { /* ignore */ }
}

/** 发给所有窗口（坞 + 设置窗口）：状态与设置的广播走这里 */
function broadcastAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue
    const wc = w.webContents
    if (!wc || wc.isDestroyed()) continue
    try { wc.send(channel, payload) } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------- 设置窗口 */
/*
 * 设置原本是坞里的一个覆盖层：一打开就把坞整个盖住，调尺寸/主题时看不到坞，
 * 只能关掉设置再瞄一眼。改成独立窗口后：
 *   - 坞留在原地可见，拖动滑杆能当场看到变化；
 *   - 窗口位置避开坞所在的那条边，不挡视线；
 *   - 坞在此期间保持展开（不自动收起），关掉设置后恢复原来的隐藏节奏。
 */

const SETTINGS_W = 780
const SETTINGS_H = 620

function settingsWindowExists() {
  return !!(settingsWin && !settingsWin.isDestroyed())
}

/** 设置窗口是否正被用户看着（最小化就不算，坞该回到自动隐藏） */
function settingsWindowActive() {
  if (!settingsWindowExists()) return false
  return settingsWin.isVisible() && !settingsWin.isMinimized()
}

function chromeColor(theme) {
  return theme === 'light' ? '#ffffff' : '#1e212b'
}

/** 把设置窗口摆在坞的反方向：坞在左就靠右，避免盖住正在调整的坞 */
function settingsBounds() {
  const wa = workArea()
  const w = Math.min(SETTINGS_W, Math.max(560, wa.width - 96))
  const h = Math.min(SETTINGS_H, Math.max(420, wa.height - 96))
  let x = Math.round(wa.x + (wa.width - w) / 2)
  let y = Math.round(wa.y + (wa.height - h) / 2)
  const gap = 72
  const edge = settings().edge
  if (edge === 'left') x = wa.x + wa.width - w - gap
  else if (edge === 'right') x = wa.x + gap
  else if (edge === 'top') y = wa.y + Math.round((wa.height - h) * 0.62)
  else y = wa.y + Math.round((wa.height - h) * 0.38)
  return { x, y, width: w, height: h }
}

function openSettingsWindow(tab) {
  // 先把坞亮出来（不抢焦点），用户才有东西可看
  if (win && winReady) {
    cancelHide()
    show({ focus: false })
  }

  if (settingsWindowExists()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    if (tab) settingsWin.webContents.send('settings:tab', tab)
    return true
  }

  const theme = settings().theme
  settingsWin = new BrowserWindow({
    ...settingsBounds(),
    minWidth: 600,
    minHeight: 440,
    show: false,
    frame: false,          // 自定义标题栏，颜色跟着主题走
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: '桌面坞设置',
    backgroundColor: chromeColor(theme),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  settingsWin.loadFile(path.join(__dirname, '../renderer/settings.html'))

  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return
    // 跨 DPI 屏幕创建窗口时，Chromium 会按主屏的缩放因子算一遍尺寸，
    // 到 ready 之后按目标屏再设一次，窗口才是我们要的 DIP 大小
    try { settingsWin.setBounds(settingsBounds()) } catch { /* ignore */ }
    settingsWin.show()
    settingsWin.focus()
    dbg('settings-open', JSON.stringify(settingsWin.getBounds()))
  })

  // 从最小化还原：坞要重新亮出来，否则改设置看不到东西
  settingsWin.on('restore', () => {
    if (win && winReady) {
      cancelHide()
      show({ focus: false })
    }
  })

  settingsWin.on('closed', () => {
    settingsWin = null
    // 回到正常的自动隐藏：鼠标不在坞上就收起
    scheduleHide()
    dbg('settings-closed')
  })

  return true
}

function closeSettingsWindow() {
  if (!settingsWindowExists()) return false
  settingsWin.close()
  return true
}

function relayout() {
  if (!win || !winReady) return
  const g = geometry()
  const cur = win.getBounds()
  const b = g.window
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
    try { win.setBounds(b) } catch { /* ignore */ }
    dbg('relayout', JSON.stringify(b), 'cols=' + g.cols)
  }
  sendToRenderer('dock:layout', { edge: settings().edge, cols: g.cols })
}

/* ---------------------------------------------------------------- 托盘 */

function createTray() {
  if (tray) {
    try { tray.destroy() } catch { /* ignore */ }
    tray = null
  }
  const iconPath = path.join(__dirname, '../../build/icon.png')
  let img = nativeImage.createEmpty()
  try {
    img = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 })
  } catch { /* ignore */ }
  tray = new Tray(img)
  tray.setToolTip('桌面坞 DeskDock')
  const build = () => Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => (visible ? hide(true) : show({ focus: true })) },
    { label: '固定常显', type: 'checkbox', checked: !!settings().pinned, click: (mi) => togglePin(mi.checked) },
    { type: 'separator' },
    { label: '打开主界面', click: () => show({ focus: true }) },
    { label: '设置…', click: () => { openSettingsWindow() } },
    { label: '打开数据目录', click: () => shell.openPath(store.baseDir()) },
    { type: 'separator' },
    { label: '退出桌面坞', click: () => { app.isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(build())
  tray.on('click', () => (visible ? hide(true) : show({ focus: true })))
  tray.on('right-click', () => tray.setContextMenu(build()))
}

/* ------------------------------------------------------------ 开机自启 */

function readLoginState() {
  if (!app.isPackaged) return { openAtLogin: false, supported: false }
  try {
    const st = app.getLoginItemSettings({ path: process.execPath })
    return { openAtLogin: !!st.openAtLogin, supported: true }
  } catch {
    return { openAtLogin: false, supported: false }
  }
}

function setLogin(enabled) {
  if (!app.isPackaged) return { ok: false, message: '开发模式下不支持开机自启，打包安装后可用' }
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: ['--hidden'] })
    store.updateSettings({ launchAtLogin: !!enabled })
    return { ok: true, openAtLogin: !!enabled }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}

function togglePin(pinned) {
  store.updateSettings({ pinned: !!pinned })
  sendToRenderer('state:changed', appState())
  if (pinned) show()
  else if (!settings().autoHide) hide(true)
  createTray()
}

/* 送给渲染层的完整状态：多带一个 cols，宽/高由它决定排布 */
function appState() {
  return {
    ...store.publicState(),
    cols: geometry().cols
  }
}

/* ------------------------------------------------------------ 图标解析 */

async function iconFor(item) {
  const abs = store.absolute(item.file)
  // 缓存 key 由"候选来源列表"决定：target / iconLoc 一解析出来 key 就变，自然重取
  return winicon.iconDataUrl({ file: abs, target: item.target, iconLoc: item.iconLoc })
}

/** 批量补齐 .lnk 目标后刷新图标 */
async function refreshTargets() {
  const changed = await store.resolveTargets()
  if (changed) broadcast()
}

/**
 * 启动自检：
 *  1) 索引被清空但 shortcuts 目录里还有文件 → 已经自愈，提示用户
 *  2) 条目指向的 .lnk 丢了但 target 还在 → 自动重建
 */
async function startupHealthCheck(firstRun) {
  const st = store.publicState()
  if (!firstRun && st.recoveredCount > 0) {
    broadcast()
    sendToRenderer('ui:toast', { text: `已从数据目录恢复了 ${st.recoveredCount} 个快捷方式` })
  }
  if (store.missingCount() > 0) {
    const r = await store.repairMissing()
    broadcast()
    if (r.repaired > 0) sendToRenderer('ui:toast', { text: `已自动修复 ${r.repaired} 个快捷方式` })
    if (r.unrepaired > 0) {
      sendToRenderer('ui:toast', { type: 'error', text: `有 ${r.unrepaired} 个快捷方式失效，可在设置 → 数据安全 里处理` })
    }
  }
}

/** 解析 .lnk 真实目标（用于"打开所在位置"） */
async function resolveTarget(abs) {
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process')
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${abs.replace(/'/g, "''")}'); Write-Output $s.TargetPath`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 4000 },
        (err, stdout) => resolve(err ? '' : String(stdout).trim()))
    } catch { resolve('') }
  })
}

/* ---------------------------------------------------------------- 动作 */

function findItem(id) {
  return store.get().items.find((x) => x.id === id)
}

async function openItem(id) {
  const item = findItem(id)
  if (!item) return { ok: false }
  // 调试用：只记一次调用，不真的启动程序，用来验证"冷却期内点击被丢弃"
  if (process.env.DESKDOCK_TEST_NOOPEN) {
    console.log('[open]', id, Date.now())
    return { ok: true }
  }
  const abs = store.absolute(item.file)
  const err = await shell.openPath(abs)
  if (err) return { ok: false, message: err }
  // 打开后不主动收起：要连点多个快捷方式时坞得留在原地。
  // 隐藏交给 startWatch 的轮询 —— 光标离开坞区域超过 hideDelay 才会收起。
  return { ok: true }
}

async function revealItem(id) {
  const item = findItem(id)
  if (!item) return false
  const abs = store.absolute(item.file)
  let target = item.target && fs.existsSync(item.target) ? item.target : ''
  if (!target) target = await resolveTarget(abs)
  if (target && fs.existsSync(target)) shell.showItemInFolder(target)
  else shell.showItemInFolder(abs)
  return true
}

/* ---------------------------------------------------------------- IPC */

function fixIpc() {
  // ---- 状态
  ipcMain.handle('app:state', () => ({
    ...appState(),
    login: readLoginState(),
    visible
  }))

  ipcMain.handle('icon:get', async (_e, id) => {
    const item = findItem(id)
    if (!item) return ''
    return iconFor(item)
  })

  // ---- 设置
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = store.updateSettings(patch)
    if (patch && ('thickness' in patch || 'tileSize' in patch || 'columns' in patch)) relayout()
    if (patch && 'edge' in patch) {
      store.updateSettings({ offset: null })
      relayout()
    }
    if (patch && ('pinned' in patch || 'autoHide' in patch)) {
      if (s.pinned || !s.autoHide) show()
      else if (!settingsWindowActive()) hide(true)
      createTray()
    }
    // 值改了就立刻推回去（坞和设置窗口都要收到），渲染层不必等下一次 state:changed 才生效
    broadcastAll('settings:changed', { settings: s })
    return { settings: s }
  })

  ipcMain.handle('settings:login', (_e, enabled) => setLogin(enabled))
  ipcMain.handle('settings:login-state', () => readLoginState())

  // ---- 设置窗口（独立窗口）
  ipcMain.handle('settings:open', (_e, tab) => openSettingsWindow(tab))
  ipcMain.handle('settings:close', () => closeSettingsWindow())
  // 窗口背景色跟主题走，缩放/重绘时不会闪一下白底
  ipcMain.handle('settings:chrome', (e, theme) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) {
      try { w.setBackgroundColor(chromeColor(theme)) } catch { /* ignore */ }
    }
    return true
  })

  // ---- 无边框窗口的通用控制（发消息的窗口自己处理）
  ipcMain.handle('win:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) w.minimize()
    return true
  })
  ipcMain.handle('win:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) w.close()
    return true
  })

  // ---- 分类
  ipcMain.handle('cat:add', (_e, name, color) => {
    const cat = store.addCategory(name, color)
    broadcast()
    return cat
  })
  ipcMain.handle('cat:rename', (_e, id, name) => {
    const ok = store.renameCategory(id, name)
    broadcast()
    return ok
  })
  ipcMain.handle('cat:delete', (_e, id) => {
    const r = store.deleteCategory(id)
    broadcast()
    return r
  })
  ipcMain.handle('cat:reorder', (_e, ids) => {
    store.reorderCategories(ids)
    broadcast()
    return true
  })
  ipcMain.handle('cat:collapse', (_e, id, collapsed) => {
    store.setCollapsed(id, collapsed)
    return true
  })
  ipcMain.handle('cat:color', (_e, id, color) => {
    const ok = store.setCategoryColor(id, color)
    broadcast()
    return ok
  })

  // ---- 条目
  ipcMain.handle('item:move', (_e, id, categoryId, index) => {
    store.moveItem(id, categoryId, index)
    broadcast()
    return true
  })
  ipcMain.handle('item:rename', (_e, id, name) => {
    const r = store.renameItem(id, name)
    broadcast()
    return r
  })
  ipcMain.handle('item:open', (_e, id) => openItem(id))
  ipcMain.handle('item:reveal', (_e, id) => revealItem(id))
  ipcMain.handle('item:remove', (_e, id, restore) => {
    const r = store.removeItem(id, restore)
    broadcast()
    return r
  })
  ipcMain.handle('item:add-files', async (_e, paths, categoryId) => {
    const r = store.addFilesFromPaths(paths, categoryId)
    broadcast()
    refreshTargets()
    return r
  })

  // ---- 桌面导入
  ipcMain.handle('desktop:scan', () => store.scanDesktop())
  ipcMain.handle('desktop:import', async (_e, paths, categoryId, moveOriginals, keepOriginal) => {
    const r = await store.importFromDesktop(paths, categoryId, moveOriginals, keepOriginal)
    broadcast()
    refreshTargets()
    return r
  })
  ipcMain.handle('desktop:restore-all', (_e, confirmToken) => {
    if (confirmToken !== 'yes') return { ok: false }
    const n = store.restoreAllToDesktop()
    broadcast()
    return { ok: true, count: n }
  })

  // ---- 系统
  ipcMain.handle('sys:open-data-dir', () => shell.openPath(store.baseDir()))
  ipcMain.handle('sys:open-shortcuts-dir', () => shell.openPath(store.shortcutsDir()))
  ipcMain.handle('sys:open-backup-dir', () => shell.openPath(store.backupDir()))

  // ---- 数据安全：备份 / 恢复 / 修复
  ipcMain.handle('data:backup', () => {
    const file = store.backupNow('manual')
    return { ok: !!file, file, backups: store.listBackups() }
  })
  ipcMain.handle('data:backups', () => store.listBackups())
  ipcMain.handle('data:restore', (_e, file) => {
    const r = store.restoreBackup(file)
    if (r.ok) {
      refreshTargets()
      broadcast()
    }
    return r
  })
  ipcMain.handle('data:repair', async () => {
    const r = await store.repairMissing()
    broadcast()
    return r
  })
  ipcMain.handle('sys:quit', () => { app.isQuitting = true; app.quit() })
  // 设置窗口开着时忽略隐藏请求，否则坞藏起来、设置窗还杵在那儿，很怪
  ipcMain.handle('sys:hide', () => {
    if (!settingsWindowActive()) hide(true)
    return true
  })
  ipcMain.handle('sys:pin', (_e, pinned) => { togglePin(pinned); return true })

  // ---- 右键菜单
  ipcMain.handle('menu:item', (e, id) => {
    const st = store.publicState()
    const item = st.items.find((x) => x.id === id)
    if (!item) return
    const cats = st.categories.filter((c) => c.id !== item.categoryId)
    menuOpen = true
    const menu = Menu.buildFromTemplate([
      { label: '打开', click: () => { openItem(id) } },
      { label: '打开文件所在位置', click: () => { revealItem(id) } },
      { type: 'separator' },
      { label: '重命名…', click: () => sendToRenderer('ui:rename-item', id) },
      {
        label: '移动到分类',
        submenu: cats.length
          ? cats.map((c) => ({ label: c.name, click: () => { store.moveItem(id, c.id, 9999); broadcast() } }))
          : [{ label: '（没有其他分类）', enabled: false }]
      },
      { type: 'separator' },
      { label: '移出坞（放回桌面）', click: () => { store.removeItem(id, true); broadcast() } },
      {
        label: '移出坞并删除副本…',
        click: async () => {
          const r = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['取消', '删除副本'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            title: '删除副本',
            message: `要从坞里移除「${item.name}」并删除它的副本吗？`,
            detail: '副本是导入时复制到坞数据目录的那份文件。删除后无法从坞恢复；如果导入时已移除桌面原件，也不会随之还原。'
          })
          if (r.response !== 1) return
          store.removeItem(id, false)
          broadcast()
          sendToRenderer('ui:toast', { text: `已移除「${item.name}」并删除副本` })
        }
      }
    ])
    menu.popup({
      window: win,
      callback: () => { menuOpen = false }
    })
  })

  ipcMain.handle('menu:category', (_e, id) => {
    const st = store.publicState()
    const cat = st.categories.find((c) => c.id === id)
    if (!cat) return
    menuOpen = true
    const menu = Menu.buildFromTemplate([
      { label: '重命名分类…', click: () => sendToRenderer('ui:rename-cat', id) },
      { label: '修改颜色…', click: () => sendToRenderer('ui:color-cat', id) },
      { type: 'separator' },
      { label: '删除分类', click: async () => {
        const r = store.deleteCategory(id)
        broadcast()
        if (!r.ok) sendToRenderer('ui:toast', { type: 'error', text: r.message })
        else sendToRenderer('ui:toast', { text: `分类已删除，${r.moved} 个快捷方式移到「${r.fallback}」` })
      } }
    ])
    menu.popup({ window: win, callback: () => { menuOpen = false } })
  })

  // ---- 沿边拖动 / 拖到另一条边就换方向吸附
  ipcMain.on('panel:drag-start', () => startDrag(screen.getCursorScreenPoint()))
  ipcMain.on('panel:drag-move', () => {
    if (!dragState) return
    dragMoveTo(screen.getCursorScreenPoint())
  })
  ipcMain.on('panel:drag-end', () => {
    if (!dragState) return
    dragState = null
    store.save()
  })
}

/* --------------------------------------------------------- 拖拽换边逻辑 */

function startDrag(p) {
  if (!win) return
  dragState = {
    cursor: { x: p.x, y: p.y },
    bounds: geometry().panel,
    edge: settings().edge
  }
}

function dragMoveTo(p) {
  if (!dragState || !win) return

  // 0) 光标跨到另一块屏 → 归属屏跟着换，坞落到新屏最近的边上
  const under = screen.getDisplayNearestPoint(p)
  if (under && under.id !== dockDisplay().id) {
    const edge = nearestEdge(p, under.workArea)
    setDockDisplay(under.id)
    const g = dockToEdge(edge, p)
    dragState = { cursor: { x: p.x, y: p.y }, bounds: g.panel, edge }
    return
  }

  // 1) 先看要不要换边：光标离另一条屏幕边更近，且进入了吸附区
  const target = edgeTargetAt(p)
  if (target.edge !== settings().edge) {
    const g = dockToEdge(target.edge, p)
    // 换边后以当前光标为基准重新算增量，避免面板"跳一下"
    dragState = { cursor: { x: p.x, y: p.y }, bounds: g.panel, edge: target.edge }
    return
  }

  // 2) 留在原边上，沿边滑动
  const wa = workArea()
  const { panel } = geometry()
  const next = { ...panel }
  if (isVerticalEdge()) {
    const dy = p.y - dragState.cursor.y
    next.y = clamp(dragState.bounds.y + dy, wa.y, wa.y + wa.height - panel.height)
  } else {
    const dx = p.x - dragState.cursor.x
    next.x = clamp(dragState.bounds.x + dx, wa.x, wa.x + wa.width - panel.width)
  }
  // 拖动过程中只改内存，松手时才落盘
  store.get().settings.offset = isVerticalEdge() ? next.y : next.x
  const wb = { x: next.x - PAD, y: next.y - PAD, width: next.width + PAD * 2, height: next.height + PAD * 2 }
  try { win.setBounds(wb) } catch { /* ignore */ }
}

function broadcast() {
  winicon.clearCache()
  broadcastAll('state:changed', appState())
  // 增删/移动图标可能改变"最多一组的数量"，坞的宽度要跟着变
  relayout()
}

/* ---------------------------------------------------------------- 启动 */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => show({ focus: true }))

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    store.load()

    // 首次启动：先固定显示，让用户一眼看到坞在哪，之后再自己决定是否自动隐藏
    const firstRun = store.publicState().firstRun
    if (firstRun) store.updateSettings({ pinned: true })

    fixIpc()

    createWindow()
    createTray()
    refreshTargets()

    // 启动自检：索引被清空但文件还在 / 快捷方式文件丢了但 target 还在
    setTimeout(() => { startupHealthCheck(firstRun) }, 1200)

    if (process.env.DESKDOCK_CAPTURE) {
      setTimeout(() => debugCapture(process.env.DESKDOCK_CAPTURE), Number(process.env.DESKDOCK_CAPTURE_DELAY || 3500))
    }

    if (process.env.DESKDOCK_DRAG_PATH) {
      setTimeout(() => {
        runDragPath(process.env.DESKDOCK_DRAG_PATH)
        const quitAfter = Number(process.env.DESKDOCK_EXIT_AFTER || 0)
        if (quitAfter > 0) setTimeout(() => { app.isQuitting = true; app.quit() }, quitAfter)
      }, Number(process.env.DESKDOCK_DRAG_DELAY || 2200))
    }

    // 调试用：给第一个图标触发冷却动画，并在指定毫秒后截图，用来看扇形扫描的中间帧
    if (process.env.DESKDOCK_COOLDOWN_TEST) {
      const shotDelay = Number(process.env.DESKDOCK_COOLDOWN_TEST)
      setTimeout(() => {
        show({ focus: false })
        win.webContents.executeJavaScript(
          "document.querySelectorAll('.tile .ico')[" +
          Number(process.env.DESKDOCK_COOLDOWN_INDEX || 0) +
          "]?.classList.add('cooling'); true"
        ).catch(() => {})
        setTimeout(() => {
          debugCapture(process.env.DESKDOCK_COOLDOWN_SHOT || 'cooldown-test.png')
          setTimeout(() => { app.isQuitting = true; app.quit() }, 900)
        }, shotDelay)
      }, 2600)
    }

    // 调试用：DESKDOCK_CLICK_TEST="0,300,600,3000" 在指定毫秒依次点击第一个磁贴，
    // 配合 DESKDOCK_TEST_NOOPEN 验证冷却期内重复点击是否被丢弃
    if (process.env.DESKDOCK_CLICK_TEST) {
      const ticks = process.env.DESKDOCK_CLICK_TEST.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      setTimeout(() => {
        show({ focus: false })
        for (const t of ticks) {
          setTimeout(() => {
            win.webContents.executeJavaScript("document.querySelectorAll('.tile')[0]?.click(); true").catch(() => {})
          }, t)
        }
        const last = ticks.length ? Math.max(...ticks) : 0
        setTimeout(() => { app.isQuitting = true; app.quit() }, last + 1500)
      }, 2600)
    }

    // 调试用：DESKDOCK_EVAL="js" 启动后执行一段页面脚本（配合 DESKDOCK_CAPTURE 截图）
    if (process.env.DESKDOCK_EVAL) {
      setTimeout(() => {
        show({ focus: false })
        win.webContents.executeJavaScript(process.env.DESKDOCK_EVAL).catch((e) => console.log('[eval]', String(e)))
      }, 2600)
    }

    screen.on('display-metrics-changed', relayout)
    screen.on('display-added', relayout)
    screen.on('display-removed', () => {
      // 归属屏被拔掉 → 丢掉记录，坞回到主屏
      if (dockDisplayId != null && !displayById(dockDisplayId)) {
        dockDisplayId = null
        store.updateSettings({ displayId: null })
      }
      relayout()
    })

    if (firstRun) {
      setTimeout(() => {
        show({ focus: true })
        sendToRenderer('ui:toast', { text: '首次启动，坞已固定显示；点右上角图钉可恢复自动隐藏' })
      }, 900)
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    try { store.backupNow('quit') } catch { /* ignore */ }
  })

  app.on('window-all-closed', (e) => {
    // 常驻托盘，不退出
    if (!app.isQuitting) e.preventDefault()
  })

  app.on('activate', () => {
    if (!win) createWindow()
  })
}
