'use strict'
/**
 * preview-shot.js — 仅用于开发期视觉验证
 * 用真实的渲染进程 + 假数据截图，检查界面是否正常
 * 运行：npx electron scripts/preview-shot.js
 */

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const winicon = require('../src/main/winicon')

const CATS = [
  { id: 'c1', name: '编程开发', color: '#5B8CFF', collapsed: false },
  { id: 'c2', name: '聊天社交', color: '#39C0A0', collapsed: false },
  { id: 'c3', name: '影音娱乐', color: '#B07BFF', collapsed: false },
  { id: 'c4', name: '游戏', color: '#F5A24B', collapsed: true },
  { id: 'c5', name: '办公工具', color: '#4FC3E8', collapsed: true }
]

const ITEMS = [
  ['c1', 'Visual Studio Code', 'Visual Studio Code.lnk'],
  ['c1', 'Cursor', 'Cursor.lnk'],
  ['c1', 'Trae CN', 'Trae CN.lnk'],
  ['c1', 'DBeaver', 'DBeaver.lnk'],
  ['c1', 'Anaconda Prompt', 'Anaconda Prompt.lnk'],
  ['c1', 'Qoder', 'Qoder.lnk'],
  ['c2', '微信', null],
  ['c2', 'QQ', null],
  ['c2', 'Telegram', 'Telegram.lnk'],
  ['c2', 'Discord', 'Discord.lnk'],
  ['c3', 'PotPlayer', null],
  ['c3', 'WizTree', 'WizTree.lnk'],
  ['c3', 'Xmind', 'Xmind.lnk']
]

const theme = process.env.SHOT_THEME || 'dark'
const outFile = process.env.SHOT_OUT || path.join(__dirname, '..', '.preview', `ui-${theme}.png`)

// SHOT_LONG=1 → 单开一个"长名称"分类，检验 68px 磁贴里的折行策略
// （CamelCase / 无空格 / 带空格 / 连字符 / 中文 / 带数字 + 符号）
if (process.env.SHOT_LONG === '1') {
  CATS.push({ id: 'c6', name: '长名称', color: '#E86A9B', collapsed: false })
  ITEMS.push(
    ['c6', 'WorkBuddy', null],
    ['c6', 'VisualStudioCode', null],
    ['c6', 'PowerPoint', null],
    ['c6', 'Adobe Photoshop 2024', null],
    ['c6', 'docker-compose', null],
    ['c6', '系统配置实用程序', null],
    ['c6', 'Notepad++', null],
    ['c6', 'WinSCP', null]
  )
}

// SHOT_DPI=1.25 → 模拟 Windows 显示缩放 125%/150%，
// 必须在 app ready 之前设置，否则 Chromium 不会采用
if (process.env.SHOT_DPI) {
  app.commandLine.appendSwitch('force-device-scale-factor', process.env.SHOT_DPI)
}

app.whenReady().then(async () => {
  const desktop = app.getPath('desktop')
  const pub = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : ''

  const findLnk = (name) => {
    if (!name) return ''
    for (const dir of [desktop, pub]) {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
    return ''
  }

  // SHOT_MANY=11 → 给第一个分类塞 11 个图标，验证"超过 10 个换第二排"
  if (process.env.SHOT_MANY) {
    const n = Number(process.env.SHOT_MANY) || 11
    const base = ITEMS.filter((i) => i[0] === 'c1')
    let k = 0
    while (ITEMS.filter((i) => i[0] === 'c1').length < n) {
      const src = base[k % base.length]
      ITEMS.push(['c1', src[1] + ' ' + (k + 2), src[2]])
      k++
    }
  }

  // SHOT_EXPAND_EMPTY=1 → 展开空分类，验证投放区
  if (process.env.SHOT_EXPAND_EMPTY === '1') {
    for (const c of CATS) c.collapsed = false
  }

  const items = process.env.SHOT_EMPTY === '1' ? [] : ITEMS.map(([cat, name, file], i) => ({
    id: 'i' + i,
    categoryId: cat,
    name,
    file: findLnk(file) || path.join(desktop, file || 'x.lnk'),
    target: '',
    addedAt: Date.now()
  }))

  // 解析 .lnk 目标，才能拿到真实图标
  const tmap = await winicon.resolveLnkTargets(items.map((i) => i.file).filter((p) => fs.existsSync(p)))
  for (const it of items) {
    const info = tmap.get(it.file)
    if (info) {
      it.target = info.target || ''
      it.iconLoc = info.icon || ''
    }
  }

  const edge = process.env.SHOT_EDGE || 'left'
  const vertical = edge === 'left' || edge === 'right'
  const tile = Number(process.env.SHOT_TILE) || 72
  const colGap = 6
  const panelChrome = 32
  const cols = vertical ? Math.max(4, Math.min(10, Number(process.env.SHOT_COLS) || 6)) : 0
  const panelW = vertical ? panelChrome + cols * tile + (cols - 1) * colGap : 1536

  const statePayload = {
    settings: {
      edge, autoHide: true, pinned: false, peek: 4, hideDelay: 550,
      thickness: 330, columns: vertical ? cols : 6, iconSize: 44, tileSize: tile, theme,
      launchAtLogin: false, showLabels: true, offset: null, cooldownMs: 2000
    },
    categories: CATS,
    items,
    cols,
    dataDir: 'D:\\00-Work\\PZB-Programs\\261102_Desktop\\DeskDockData',
    appVersion: '1.0.0',
    isPackaged: false,
    login: { openAtLogin: false, supported: true }
  }
  console.log(`edge=${edge} cols=${cols} panelW=${panelW}`)

  const iconCache = new Map()
  ipcMain.handle('app:state', () => statePayload)
  ipcMain.handle('icon:get', async (_e, id) => {
    if (iconCache.has(id)) return iconCache.get(id)
    const it = items.find((x) => x.id === id)
    let d = ''
    try {
      if (it && fs.existsSync(it.file)) {
        d = await winicon.iconDataUrl({ file: it.file, target: it.target, iconLoc: it.iconLoc })
      }
    } catch { /* ignore */ }
    iconCache.set(id, d)
    return d
  })
  const noop = () => ({ ok: true })
  const skipScan = process.env.SHOT_IMPORT === '1'
  for (const ch of ['settings:update', 'settings:login', 'settings:login-state', 'cat:add', 'cat:rename',
    'cat:delete', 'cat:reorder', 'cat:collapse', 'cat:color', 'item:move', 'item:rename', 'item:open',
    'item:reveal', 'item:remove', 'item:add-files', 'desktop:scan', 'desktop:import', 'desktop:restore-all',
    'sys:open-data-dir', 'sys:open-shortcuts-dir', 'sys:open-backup-dir', 'sys:quit', 'sys:hide', 'sys:pin',
    'data:backup', 'data:backups', 'data:restore', 'data:repair',
    'menu:item', 'menu:category']) {
    if (skipScan && ch === 'desktop:scan') continue
    ipcMain.handle(ch, noop)
  }

  // SHOT_IMPORT=1：伪造一批"桌面快捷方式"，其中一部分坞里已有（名字与 items 对上）
  if (skipScan) {
    const fake = [
      { name: 'Visual Studio Code', fromPublic: false },
      { name: 'Cursor', fromPublic: false },
      { name: 'Notepad++', fromPublic: false },
      { name: 'Figma', fromPublic: false },
      { name: 'Steam', fromPublic: true }
    ].map((x) => ({
      path: path.join(desktop, x.name + '.lnk'),
      name: x.name,
      fileName: x.name + '.lnk',
      fromPublic: x.fromPublic,
      size: 1024
    }))
    // 让其中一条处于"文件丢失"状态，验证"补回原分类"的标签
    items.find((i) => i.name === 'Cursor').missing = true
    ipcMain.handle('desktop:scan', () => fake)
  }

  // SHOT_FOCUSED=1 → 用可见窗口跑，这样 :focus / :focus-visible 才会生效
  // （offscreen 窗口永远拿不到系统焦点，焦点环样式在离屏下无法验证）
  const focusMode = process.env.SHOT_FOCUSED === '1'
  const win = new BrowserWindow({
    width: vertical ? panelW + 36 : 1536,
    height: vertical ? 780 : 330 + 36,
    show: focusMode,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: !focusMode
    }
  })
  if (focusMode) { win.show(); win.focus() }

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1400))

  // SHOT_METRICS=1 → 输出布局度量，用来比对不同 DPI 缩放下是否发生回流/裁切
  if (process.env.SHOT_METRICS === '1') {
    const m = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.panel').getBoundingClientRect()
      const list = document.querySelector('#list')
      const grid = document.querySelector('.grid')
      const gs = getComputedStyle(grid)
      const tiles = [...grid.querySelectorAll('.tile')]
      const tops = tiles.map((t) => Math.round(t.getBoundingClientRect().top))
      return {
        dpr: window.devicePixelRatio,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        panelW: Math.round(panel.width * 100) / 100,
        docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        listOverflowX: list.scrollWidth > list.clientWidth,
        listScrollbar: list.offsetWidth - list.clientWidth,
        gridCols: gs.gridTemplateColumns.split(' ').length,
        gridContentW: Math.round(grid.clientWidth * 100) / 100,
        tileW: Math.round(tiles[0].getBoundingClientRect().width * 100) / 100,
        tileRows: new Set(tops).size,
        tileClipped: tiles.some((t) => {
          const r = t.getBoundingClientRect()
          return r.right > grid.getBoundingClientRect().right + 1
        })
      }
    })()`)
    console.log('metrics', JSON.stringify(m))
  }

  // 注入一个"桌面"背景，方便看清面板边缘
  await win.webContents.executeJavaScript(`
    document.documentElement.style.background = 'linear-gradient(135deg,#1d2b41,#2d3b52 45%,#3a2f4a)';
    document.body.style.padding = '18px';
  `)
  await new Promise((r) => setTimeout(r, 500))

  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, img.toPNG())
  console.log('saved', outFile)

  // 设置已搬到独立窗口：截图与断言见 scripts/settings-shot.js

  // SHOT_PROBE=1 → 验证增量渲染：节点是否复用、滚动与焦点是否保留、改名/失效/换分类能否原地更新
  if (process.env.SHOT_PROBE === '1') {
    const probe = await win.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('#list')
      const cat0 = document.querySelector('.cat')
      const tile0 = cat0.querySelector('.tile')
      const id0 = tile0.dataset.id
      list.scrollTop = 60
      tile0.focus({ preventScroll: true })   // 不带 preventScroll 的话 focus 自己会把列表滚回顶部
      const beforeScroll = list.scrollTop
      render()
      const after = {
        sameCat: document.querySelector('.cat') === cat0,
        sameTile: document.querySelector('.tile') === tile0,
        scrollable: list.scrollHeight > list.clientHeight,
        beforeScroll,
        scrollKept: list.scrollTop === beforeScroll,
        focusKept: document.activeElement === tile0
      }
      // 改名：同一个节点上文字应该更新
      const item = state.items.find((i) => i.id === id0)
      const oldName = item.name
      item.name = '改名测试'
      render()
      after.renameInPlace = document.querySelector('.tile[data-id="' + id0 + '"]') === tile0
        && tile0.querySelector('.label').textContent === '改名测试'
      item.name = oldName
      // 失效
      item.missing = true
      render()
      after.missingInPlace = tile0.classList.contains('missing')
      item.missing = false
      render()
      after.missingCleared = !tile0.classList.contains('missing')
      // 换分类：节点应该被搬到另一个 grid，而不是重建
      const other = state.categories.find((c) => c.id !== item.categoryId)
      const oldCat = item.categoryId
      item.categoryId = other.id
      render()
      const moved = document.querySelector('.tile[data-id="' + id0 + '"]')
      after.movedInPlace = moved === tile0 && moved.closest('.grid').dataset.cat === other.id
      after.movedNotDuplicated = document.querySelectorAll('.tile[data-id="' + id0 + '"]').length === 1
      item.categoryId = oldCat
      render()
      after.restored = document.querySelector('.tile[data-id="' + id0 + '"]') === tile0

      // 搜索：全部过滤掉 → 只剩提示；清空 → 磁贴恢复且来自缓存
      query = 'zzz-不存在'
      render()
      after.searchEmpty = document.querySelectorAll('.tile').length === 0
        && !!document.querySelector('#list > .empty')
      query = ''
      render()
      after.searchRestored = document.querySelectorAll('.tile').length === 13
        && !!document.querySelector('.tile[data-id="' + id0 + '"]')

      after.tiles = document.querySelectorAll('.tile').length
      after.cats = document.querySelectorAll('.cat').length
      after.icons = document.querySelectorAll('.tile img').length
      return after
    })()`)
    console.log('render probe', JSON.stringify(probe))

    // 分类头键盘折叠：真发按键事件，走 <button> 的原生激活，而不是直接改 class
    const kb = await win.webContents.executeJavaScript(`(() => {
      const sec = document.querySelector('.cat')
      const t = sec.querySelector('.cat-toggle')
      const m = sec.querySelector('.cat-more')
      t.focus()
      const focusables = [...sec.querySelectorAll('.cat-toggle, .cat-more')]
      return {
        tag: t.tagName, role: t.getAttribute('role') || 'button(implicit)',
        tabIndex: t.tabIndex, focusable: t.tabIndex === 0 && document.activeElement === t,
        controlsResolves: !!document.getElementById(t.getAttribute('aria-controls')),
        hasLabel: (t.getAttribute('aria-label') || '').includes('个快捷方式'),
        order: focusables.map((n) => n.className).join('→'),
        before: sec.classList.contains('collapsed'),
        expandedAttr: t.getAttribute('aria-expanded')
      }
    })()`)
    const catState = () => win.webContents.executeJavaScript(`(() => {
      const sec = document.querySelector('.cat')
      const t = sec.querySelector('.cat-toggle')
      return {
        collapsed: sec.classList.contains('collapsed'),
        expanded: t.getAttribute('aria-expanded'),
        gridShown: getComputedStyle(sec.querySelector('.grid')).display !== 'none',
        focusOnToggle: document.activeElement === t,
        focusRing: t.matches(':focus-visible') ? getComputedStyle(t).outlineWidth : 'none'
      }
    })()`)
    const press = (keyCode, char) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    press('Space', ' ')
    await new Promise((r) => setTimeout(r, 250))
    const afterSpace = await catState()
    press('Space', ' ')
    await new Promise((r) => setTimeout(r, 250))
    const backSpace = await catState()
    press('Enter', '\r')
    await new Promise((r) => setTimeout(r, 250))
    const afterEnter = await catState()
    console.log('cat probe', JSON.stringify({
      ...kb, afterSpace, backSpace, afterEnter,
      spaceToggles: afterSpace.collapsed === !kb.before && afterSpace.expanded === String(kb.before),
      spaceKeepsFocus: afterSpace.focusOnToggle,
      spaceRestores: backSpace.collapsed === kb.before,
      enterToggles: afterEnter.collapsed === !kb.before,
      gridFollowsState: afterSpace.gridShown === !afterSpace.collapsed
    }))
    // 三次按键后状态是 !before，再按一次就回到初始，后面的截图不受影响
    press('Enter', '\r')
    await new Promise((r) => setTimeout(r, 200))

    // 用真实的 Tab 键走一遍：验证 Tab 顺序能到达分类头，且 :focus-visible 有描边
    await win.webContents.executeJavaScript(`document.activeElement.blur()`)
    const seq = []
    let hit = null
    for (let i = 0; i < 14; i++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await new Promise((r) => setTimeout(r, 70))
      const cur = await win.webContents.executeJavaScript(`(() => {
        const a = document.activeElement
        const cls = String(a.className && a.className.baseVal !== undefined ? a.className.baseVal : a.className)
        const cs = getComputedStyle(a)
        return { cls, id: a.id || '', focused: document.hasFocus(),
          visible: a.matches(':focus-visible'), outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor }
      })()`)
      seq.push(cur.id || cur.cls)
      if (cur.cls.includes('cat-toggle')) { hit = cur; break }
    }
    console.log('tab probe', JSON.stringify({ seq, hit }))
    if (hit) {
      const imgF = await win.webContents.capturePage()
      fs.writeFileSync(outFile.replace('.png', '-focus.png'), imgF.toPNG())
    }

    // 磁贴方向键导航：从第一格出发，按网格列数换算
    await win.webContents.executeJavaScript(`document.querySelector('.cat .tile').focus();
      window.__keys = [];
      document.addEventListener('keydown', (e) => window.__keys.push(e.key + '/' + e.keyCode), true)`)
    const where = () => win.webContents.executeJavaScript(`(() => {
      const a = document.activeElement
      const all = [...document.querySelectorAll('#list .tile')].filter((t) => t.getClientRects().length)
      const g = a.closest ? a.closest('.grid') : null
      return {
        id: a.dataset ? a.dataset.id : '', idx: all.indexOf(a), isTile: a.classList.contains('tile'),
        ring: a.classList.contains('kb-focus') ? getComputedStyle(a).outlineWidth : 'none',
        gapTop: Math.round(a.getBoundingClientRect().top - (all[0] || a).getBoundingClientRect().top)
      }
    })()`)
    const step = async (keyCode) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await new Promise((r) => setTimeout(r, 80))
      return where()
    }
    const nav = { start: await where() }
    nav.right1 = await step('Right')
    nav.right2 = await step('Right')
    nav.down = await step('Down')
    nav.up = await step('Up')
    nav.left = await step('Left')
    nav.end = await step('End')
    nav.home = await step('Home')
    nav.upAtTop = await step('Up')     // 第一排再往上：不动
    const cols = await win.webContents.executeJavaScript(
      `getComputedStyle(document.querySelector('.cat .grid')).gridTemplateColumns.split(' ').filter(Boolean).length`
    )
    console.log('nav probe', JSON.stringify({
      cols,
      keys: await win.webContents.executeJavaScript(`window.__keys`),
      rightMovesOne: nav.right1.idx === nav.start.idx + 1,
      rightTwice: nav.right2.idx === nav.start.idx + 2,
      downMovesRow: nav.down.idx === nav.start.idx + 2 + cols,
      upMovesRowBack: nav.up.idx === nav.start.idx + 2,
      leftMovesOne: nav.left.idx === nav.start.idx + 1,
      endLast: nav.end.idx === await win.webContents.executeJavaScript(`document.querySelectorAll('#list .tile').length - 1`),
      homeFirst: nav.home.idx === 0,
      stopsAtEdge: nav.upAtTop.idx === 0,
      stillTile: nav.home.isTile, ring: nav.home.ring, ringAtRight: nav.right1.ring
    }))
    {
      const imgN = await win.webContents.capturePage()
      fs.writeFileSync(outFile.replace('.png', '-nav.png'), imgN.toPNG())
    }
  }
  if (process.env.SHOT_IMPORT === '1') {
    await win.webContents.executeJavaScript(`document.querySelector('#btnImport').click()`)
    await new Promise((r) => setTimeout(r, 900))
    const probe = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('.picker-btn')
      const menu = document.querySelector('.picker-menu')
      return {
        scheme: getComputedStyle(document.body).colorScheme,
        pickLabel: btn ? btn.textContent.trim() : '',
        menuBg: menu ? getComputedStyle(menu).backgroundColor : '',
        menuColor: menu ? getComputedStyle(menu).color : ''
      }
    })()`)
    console.log('probe', JSON.stringify(probe))
    const img3 = await win.webContents.capturePage()
    fs.writeFileSync(outFile.replace('.png', '-import.png'), img3.toPNG())
    console.log('saved import dialog')

    if (process.env.SHOT_IMPORT_OPENPICK === '1') {
      await win.webContents.executeJavaScript(`document.querySelector('.picker-btn').click()`)
      await new Promise((r) => setTimeout(r, 500))
      const img5 = await win.webContents.capturePage()
      fs.writeFileSync(outFile.replace('.png', '-pick.png'), img5.toPNG())
      const probe2 = await win.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('.picker-menu')
        return { items: menu ? menu.children.length : 0, bg: menu ? getComputedStyle(menu).backgroundColor : '' }
      })()`)
      console.log('probe2', JSON.stringify(probe2))
      console.log('saved picker open')
      await win.webContents.executeJavaScript(`document.querySelector('.picker-btn').click()`)
      await new Promise((r) => setTimeout(r, 300))
    }

    if (process.env.SHOT_IMPORT_OFF === '1') {
      await win.webContents.executeJavaScript(`(() => {
        const cb = document.querySelectorAll('.check-row input')[0]
        cb.checked = false
        cb.dispatchEvent(new Event('change'))
      })()`)
      await new Promise((r) => setTimeout(r, 500))
      const img4 = await win.webContents.capturePage()
      fs.writeFileSync(outFile.replace('.png', '-import-off.png'), img4.toPNG())
      console.log('saved import dialog (unchecked)')
    }
  }

  app.quit()
})
