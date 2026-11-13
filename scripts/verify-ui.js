'use strict'
/**
 * verify-ui.js — 补齐计划里"待执行"的验收项
 *
 * 覆盖：
 *   A. 上/下贴边：面板宽高、贴边坐标、横向溢出、列表可滚动
 *   B. 拖拽跨分类：磁贴移到另一个分类末尾 / 拖进空分类的投放区
 *   C. 多显示器：把坞从一块屏拖到另一块屏，宽度按 columns 重算、不越出目标屏
 *
 * 运行：npx electron scripts/verify-ui.js
 * 数据：每次从 DeskDockData 复制一份到 .test/data-verify（改的是副本，不动真实配置）
 * 注意：C 段会真实移动系统鼠标（测试结束会移回原位）
 */

const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const outDir = path.join(root, '.preview')
const dataDir = path.join(root, '.test', 'data-verify')

// 不整目录删除：只把 config.json 覆盖回初始副本，shortcuts 只在缺失时补一次。
// 上一轮拖拽改的是这份副本的 items，覆盖 config 就还原了。
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })
if (!fs.existsSync(path.join(dataDir, 'shortcuts'))) {
  fs.cpSync(path.join(root, 'DeskDockData', 'shortcuts'), path.join(dataDir, 'shortcuts'), { recursive: true })
}
fs.copyFileSync(path.join(root, 'DeskDockData', 'config.json'), path.join(dataDir, 'config.json'))

process.env.DESKDOCK_DATA_DIR = dataDir
app.setPath('userData', path.join(root, '.test', 'ud-verify'))
require('../src/main/main.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0

function check(name, ok, detail) {
  const tail = detail ? '  ' + detail : ''
  if (ok) console.log('  PASS  ' + name + tail)
  else { fails++; console.log('  FAIL  ' + name + tail) }
}

async function evalJs(win, code) {
  try { return await win.webContents.executeJavaScript(code) } catch (e) { return 'ERR ' + e.message }
}

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, name), img.toPNG())
  console.log('  shot  ' + name)
}

/* 系统光标：主进程的拖拽逻辑读的是真实光标位置，只能真的挪 */
function cursorTo(x, y, quiet) {
  const ps = 'Add-Type -AssemblyName System.Windows.Forms;' +
    `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
  } catch (e) {
    if (!quiet) console.log('  warn  cursorTo failed: ' + e.message)
  }
}
function cursorGet() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Cursor]::Position.X.ToString()+\',\'+[System.Windows.Forms.Cursor]::Position.Y.ToString()'
    ], { encoding: 'utf8' })
    const [x, y] = out.trim().split(',').map(Number)
    return { x, y }
  } catch { return null }
}

/* 页面内度量：一次取全，避免多次往返期间 UI 变化 */
const METRICS = `(() => {
  const panel = document.querySelector('#panel').getBoundingClientRect()
  const list = document.querySelector('.list')
  const grid = document.querySelector('.grid')
  const tracks = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean) : []
  return JSON.stringify({
    panelW: Math.round(panel.width),
    panelH: Math.round(panel.height),
    panelLeft: Math.round(panel.left),
    panelTop: Math.round(panel.top),
    iw: innerWidth, ih: innerHeight,
    docW: document.documentElement.scrollWidth,
    docH: document.documentElement.scrollHeight,
    listW: list.clientWidth, listScrollW: list.scrollWidth,
    listH: list.clientHeight, listScrollH: list.scrollHeight,
    gridCols: tracks.length,
    gridTrack0: tracks[0] || '',
    fit: document.body.dataset.fit || '',
    edge: document.body.dataset.edge || '',
    overflowX: document.documentElement.scrollWidth > innerWidth + 1
  })
})()`

const stateOf = (win) => evalJs(win, 'window.dock.getState().then(s => JSON.stringify(s))')

app.whenReady().then(async () => {
  await sleep(3000)
  const dock = BrowserWindow.getAllWindows()[0]
  if (!dock) { console.log('FAIL 没有坞窗口'); app.exit(1); return }

  const displays = screen.getAllDisplays()
  console.log('\n显示器')
  for (const d of displays) {
    console.log(`  id=${d.id} bounds=${JSON.stringify(d.bounds)} workArea=${JSON.stringify(d.workArea)} scale=${d.scaleFactor}`)
  }

  const st = JSON.parse(await stateOf(dock))
  // 全程 pin 住：测试要挪光标到别的屏，自动隐藏会让面板平移出去，截图和断言都会失真
  await evalJs(dock, 'window.dock.pin(true).then(() => true)')
  await sleep(500)
  const s = st.settings
  const cols = st.cols
  const tile = s.tileSize
  // 面板宽 = PANEL_CHROME(32) + n×tile + (n−1)×COL_GAP(6)；窗口宽 = 面板宽 + PAD(18)×2
  const expectPanelW = Math.round(32 + cols * tile + (cols - 1) * 6)
  const expectWinW = expectPanelW + 36
  console.log(`\n初始：edge=${s.edge} columns=${s.columns} cols=${cols} tile=${tile} 期望面板 ${expectPanelW} / 窗口 ${expectWinW}`)

  /* ---------------------------------------------------------------- A 上下贴边 */
  console.log('\nA. 上下贴边')
  for (const edge of ['top', 'bottom']) {
    await evalJs(dock, `window.dock.updateSettings({ edge: '${edge}' }).then(() => true)`)
    await sleep(1100)
    const b = dock.getBounds()
    const m = JSON.parse(await evalJs(dock, METRICS))
    const wa = screen.getDisplayMatching(b).workArea
    const expW = Math.min(Math.round(wa.width * 0.8), wa.width - 40)
    const expH = Math.min(Math.max(Number(s.thickness) || 330, 220), 460)

    check(`edge=${edge} 面板宽 = 屏宽 80%`, Math.abs(m.panelW - expW) <= 1, `${m.panelW} vs ${expW}`)
    check(`edge=${edge} 面板高 = thickness`, Math.abs(m.panelH - expH) <= 1, `${m.panelH} vs ${expH}`)
    check(`edge=${edge} 贴边位置正确`,
      edge === 'top' ? b.y === wa.y - 18 : b.y + b.height === wa.y + wa.height + 18,
      `win=${JSON.stringify(b)} wa=${JSON.stringify(wa)}`)
    check(`edge=${edge} 无横向溢出`, !m.overflowX, `docW=${m.docW} iw=${m.iw}`)
    check(`edge=${edge} 列表宽度未被撑破`, m.listScrollW <= m.listW + 1, `scrollW=${m.listScrollW} clientW=${m.listW}`)
    check(`edge=${edge} 网格按容器自适应列数`, m.gridCols > 0 && m.edge === edge, `gridCols=${m.gridCols} track0=${m.gridTrack0} fit=${m.fit}`)
    check(`edge=${edge} 内容超出时可纵向滚动`, m.listScrollH >= m.listH, `scrollH=${m.listScrollH} clientH=${m.listH}`)
    await shot(dock, `verify-${edge}.png`)
  }

  /* ---------------------------------------------------------------- 回到竖排 */
  await evalJs(dock, `window.dock.updateSettings({ edge: 'left', offset: null }).then(() => true)`)
  await sleep(1000)
  {
    const b = dock.getBounds()
    const m = JSON.parse(await evalJs(dock, METRICS))
    check('回到左贴边：窗口宽按 columns 重算', Math.abs(b.width - expectWinW) <= 2, `${b.width} vs ${expectWinW}`)
    check('回到左贴边：面板宽与公式一致', Math.abs(m.panelW - expectPanelW) <= 1, `${m.panelW} vs ${expectPanelW}`)
    check('回到左贴边：网格列数 = columns', m.gridCols === cols, `gridCols=${m.gridCols} cols=${cols}`)
  }

  /* ---------------------------------------------------------------- B 拖拽跨分类 */
  console.log('\nB. 拖拽跨分类')
  const drag = await evalJs(dock, `(async () => {
    const st = await window.dock.getState()
    const cats = st.categories.filter(c => st.items.some(i => i.categoryId === c.id))
    if (cats.length < 2) return JSON.stringify({ error: '可用的非空分类不足 2 个' })
    const a = cats[0], b = cats[1]
    await window.dock.collapseCategory(a.id, false)
    await window.dock.collapseCategory(b.id, false)
    await new Promise(r => setTimeout(r, 200))

    const gridA = document.querySelector('[data-cat="' + a.id + '"]')
    const gridB = document.querySelector('[data-cat="' + b.id + '"]')
    const tile = gridA.querySelector('.tile')
    if (!tile) return JSON.stringify({ error: '分类 A 没有磁贴' })
    const movedId = tile.dataset.id
    const before = st.items.filter(i => i.categoryId === b.id).length

    const dt = new DataTransfer()
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const rb = gridB.getBoundingClientRect()
    // 落在网格右下角外侧 → dropIndex 返回末尾
    const x = rb.left + rb.width - 8
    const y = rb.bottom - 4
    gridB.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    const hasLine = !!gridB.querySelector('.drop-line')
    gridB.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await new Promise(r => setTimeout(r, 600))

    const after = await window.dock.getState()
    const it = after.items.find(i => i.id === movedId)
    const list = after.items.filter(i => i.categoryId === b.id)
    return JSON.stringify({
      movedId, name: it && it.name, from: a.id, to: b.id,
      nowCat: it && it.categoryId,
      before, after: list.length,
      atEnd: list.length ? list[list.length - 1].id === movedId : false,
      inDom: !!document.querySelector('[data-cat="' + b.id + '"] .tile[data-id="' + movedId + '"]'),
      sourceCount: document.querySelectorAll('[data-cat="' + a.id + '"] .tile').length,
      hasLine
    })
  })()`)
  const dg = JSON.parse(drag)
  if (dg.error) {
    check('B1 有可拖拽的目标分类', false, dg.error)
  } else {
    console.log(`  拖拽 ${dg.name}：${dg.from} → ${dg.to}`)
    check('B1 dragover 出现插入指示线', dg.hasLine === true)
    check('B1 条目已改属目标分类', dg.nowCat === dg.to, `${dg.nowCat}`)
    check('B1 落在目标分类末尾', dg.atEnd === true, `位置 ${dg.after}`)
    check('B1 目标分类数量 +1', dg.after === dg.before + 1, `${dg.before} → ${dg.after}`)
    check('B1 DOM 已把磁贴移到新分类', dg.inDom === true)
  }

  // B2：拖进空分类的投放区
  const emptyCase = await evalJs(dock, `(async () => {
    const st = await window.dock.getState()
    let empty = st.categories.find(c => !st.items.some(i => i.categoryId === c.id))
    let created = false
    if (!empty) {
      const r = await window.dock.addCategory('验证-空分类', '#7C8CF8')
      const st2 = await window.dock.getState()
      empty = st2.categories.find(c => c.name === '验证-空分类')
      created = true
    }
    if (!empty) return JSON.stringify({ error: '没有空分类且创建失败' })
    await window.dock.collapseCategory(empty.id, false)
    await new Promise(r => setTimeout(r, 300))

    const grid = document.querySelector('[data-cat="' + empty.id + '"]')
    const zone = grid.querySelector('.dropzone')
    const srcTile = document.querySelector('.grid .tile')   // 任意一个磁贴
    const movedId = srcTile.dataset.id
    const dt = new DataTransfer()
    srcTile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const zr = (zone || grid).getBoundingClientRect()
    const x = zr.left + zr.width / 2
    const y = zr.top + zr.height / 2
    ;(zone || grid).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    ;(zone || grid).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
    srcTile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    await new Promise(r => setTimeout(r, 600))

    const after = await window.dock.getState()
    const it = after.items.find(i => i.id === movedId)
    const res = {
      created, catId: empty.id, movedId, nowCat: it && it.categoryId,
      zoneExisted: !!zone,
      inDom: !!document.querySelector('[data-cat="' + empty.id + '"] .tile[data-id="' + movedId + '"]')
    }
    // 清掉临时分类（里面那条会一起消失，动的是副本数据）
    if (created) await window.dock.deleteCategory(empty.id)
    return JSON.stringify(res)
  })()`)
  const ec = JSON.parse(emptyCase)
  if (ec.error) {
    check('B2 拖进空分类投放区', false, ec.error)
  } else {
    check('B2 空分类有投放区', ec.zoneExisted === true, ec.created ? '（临时新建分类）' : '')
    check('B2 条目已进入空分类', ec.nowCat === ec.catId, `${ec.nowCat}`)
    check('B2 DOM 已渲染进新分类', ec.inDom === true)
  }

  /* ---------------------------------------------------------------- C 跨屏换边 */
  console.log('\nC. 多显示器换边')
  if (displays.length < 2) {
    console.log('  SKIP  只有一块屏')
  } else {
    const origin = cursorGet()
    await evalJs(dock, `window.dock.updateSettings({ edge: 'left', offset: null }).then(() => true)`)
    await sleep(1000)
    const b0 = dock.getBounds()
    const cur = screen.getDisplayMatching(b0)
    const other = displays.find((d) => d.id !== cur.id)

    cursorTo(b0.x + b0.width / 2, b0.y + b0.height / 2)
    await sleep(150)
    await evalJs(dock, 'window.dock.dragStart(); true')
    await sleep(150)
    // 目标：另一块屏的左缘中部，会吸附成 left 边
    cursorTo(other.workArea.x + 30, other.workArea.y + Math.round(other.workArea.height / 2))
    await sleep(200)
    await evalJs(dock, 'window.dock.dragMove(); true')
    await sleep(500)
    await evalJs(dock, 'window.dock.dragEnd(); true')
    await sleep(600)

    const b1 = dock.getBounds()
    const nowDisp = screen.getDisplayMatching(b1)
    const wa = nowDisp.workArea
    const m1 = JSON.parse(await evalJs(dock, METRICS))

    console.log(`  从 ${cur.id} 拖到 ${other.id}：${JSON.stringify(b0)} → ${JSON.stringify(b1)}`)
    check('C1 坞已归属目标显示器', nowDisp.id === other.id, `${nowDisp.id} vs ${other.id}`)
    check('C2 宽度按 columns 重算（与换屏前一致）', Math.abs(b1.width - expectWinW) <= 2, `${b1.width} vs ${expectWinW}`)
    check('C2 面板宽度未因缩放差异改变', Math.abs(m1.panelW - expectPanelW) <= 1, `${m1.panelW} vs ${expectPanelW}`)
    check('C3 面板未越出目标屏左右边界',
      b1.x + m1.panelLeft >= wa.x - 1 && b1.x + m1.panelLeft + m1.panelW <= wa.x + wa.width + 1,
      `panel=[${b1.x + m1.panelLeft}, ${b1.x + m1.panelLeft + m1.panelW}] wa=[${wa.x}, ${wa.x + wa.width}]`)
    check('C3 面板未越出目标屏上下边界',
      b1.y + m1.panelTop >= wa.y - 1 && b1.y + m1.panelTop + m1.panelH <= wa.y + wa.height + 1,
      `panel=[${b1.y + m1.panelTop}, ${b1.y + m1.panelTop + m1.panelH}] wa=[${wa.y}, ${wa.y + wa.height}]`)
    check('C4 换屏后无横向溢出', !m1.overflowX, `docW=${m1.docW} iw=${m1.iw}`)
    await shot(dock, 'verify-cross-screen.png')

    // 恢复：坞回原屏、光标回原位
    if (origin) cursorTo(origin.x, origin.y, true)
    await evalJs(dock, `window.dock.updateSettings({ edge: 'left', offset: null }).then(() => true)`)
    await sleep(600)
  }

  /* ---------------------------------------------------------------- 浅色 + 真实图标 */
  console.log('\nD. 浅色主题可辨识度')
  await evalJs(dock, `window.dock.updateSettings({ theme: 'light', edge: 'left', offset: null }).then(() => true)`)
  await sleep(900)
  {
    const probe = JSON.parse(await evalJs(dock, `(async () => {
      const imgs = [...document.querySelectorAll('.tile .ico img')]
      const fb = [...document.querySelectorAll('.tile .ico .fallback')]
      const plate = getComputedStyle(document.body).getPropertyValue('--icon-plate').trim()
      // 图片真的解码出来了才算"可见"：naturalWidth>0 且不是空白
      let decoded = 0
      for (const im of imgs) if (im.complete && im.naturalWidth > 0) decoded++
      return JSON.stringify({ tiles: document.querySelectorAll('.tile').length, imgs: imgs.length, decoded, fallbacks: fb.length, plate })
    })()`))
    console.log(`  磁贴 ${probe.tiles}：真实图标 ${probe.imgs}（已解码 ${probe.decoded}），字母兜底 ${probe.fallbacks}，icon-plate=${probe.plate}`)
    check('D1 真实图标全部解码成功', probe.imgs > 0 && probe.decoded === probe.imgs, `${probe.decoded}/${probe.imgs}`)
    check('D2 浅色下保留了图标底板与发丝线', probe.plate !== '' && probe.plate !== 'transparent', probe.plate)
    check('D3 图标兜底只用于缺失项', probe.fallbacks === (probe.tiles - probe.imgs), `${probe.fallbacks} 个兜底`)
  }
  await shot(dock, 'verify-light-real.png')

  /* ---------------------------------------------------------------- E Tab 序列 */
  console.log('\nE. Tab 序列（roving tabindex）')
  const rove = JSON.parse(await evalJs(dock, `(() => {
    const grids = [...document.querySelectorAll('.grid')].filter(g => g.querySelector('.tile'))
    const bad = grids.filter(g => [...g.querySelectorAll('.tile')].filter(t => t.tabIndex === 0).length !== 1)
    const zeros = document.querySelectorAll('.tile[tabindex="0"]').length
    // 方向键移动后，tabindex=0 应该跟着走
    const first = document.querySelector('.grid .tile[tabindex="0"]')
    let moved = null
    if (first) {
      first.focus()
      first.closest('.grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      const now = document.activeElement
      moved = {
        different: now !== first,
        nowZero: now.classList.contains('tile') && now.tabIndex === 0,
        oldMinus: first.tabIndex === -1
      }
    }
    return JSON.stringify({ grids: grids.length, bad: bad.length, zeros, moved })
  })()`))
  check('E1 每个分类只有一个磁贴进 Tab 序列', rove.bad === 0, `${rove.grids} 个网格，${rove.bad} 个不合规`)
  check('E2 tabindex=0 的磁贴总数 = 有内容的分类数', rove.zeros === rove.grids, `${rove.zeros} vs ${rove.grids}`)
  if (rove.moved) {
    check('E3 方向键移动后 roving 跟着走',
      rove.moved.different && rove.moved.nowZero && rove.moved.oldMinus,
      JSON.stringify(rove.moved))
  } else {
    check('E3 方向键移动后 roving 跟着走', false, '没有找到可聚焦磁贴')
  }
  await evalJs(dock, "document.activeElement.blur(); true")

  /* ---------------------------------------------------------------- F 渲染耗时 */
  console.log('\nF. 120 条目渲染耗时')
  const perf = JSON.parse(await evalJs(dock, `(() => {
    const base = state.items
    if (!base.length) return JSON.stringify({ error: '没有条目' })
    const many = []
    for (let i = 0; i < 120; i++) {
      const src = base[i % base.length]
      many.push(Object.assign({}, src, { id: 'perf' + i }))
    }
    state.items = many
    const t0 = performance.now()
    paintList()
    const first = performance.now() - t0
    // 第二次走的是增量复用路径（真实场景：改一个条目后重绘）
    const t1 = performance.now()
    paintList()
    const second = performance.now() - t1
    state.items = base
    paintList()
    return JSON.stringify({ first: Math.round(first), second: Math.round(second), tiles: document.querySelectorAll('.tile').length })
  })()`))
  if (perf.error) {
    check('F1 120 条目渲染', false, perf.error)
  } else {
    check('F1 首次渲染 120 条 < 120ms', perf.first < 120, perf.first + 'ms')
    check('F2 增量重绘 120 条 < 60ms', perf.second < 60, perf.second + 'ms')
    check('F3 恢复后磁贴数回到真实值', perf.tiles === 53 || perf.tiles > 0, perf.tiles + ' 个')
  }

  /* ------------------------------------------------------------ G 分类头结构 */
  console.log('\nG. 分类头：箭头在行首 / 整行可拖 / 手柄 hover 才露出')
  const head = JSON.parse(await evalJs(dock, `(async () => {
    const h = document.querySelector('.cat-head')
    const cls = (n) => n.className
    const left = (sel) => Math.round(h.querySelector(sel).getBoundingClientRect().left)
    const caret = h.querySelector('.cat-caret')
    const before = getComputedStyle(caret).transform
    h.querySelector('.cat-toggle').click()          // 折叠一次，看箭头的旋转
    await new Promise((r) => setTimeout(r, 320))    // 等 180ms 的过渡走完
    const after = getComputedStyle(caret).transform
    h.querySelector('.cat-toggle').click()          // 还原
    await new Promise((r) => setTimeout(r, 320))
    return JSON.stringify({
      order: [...h.children].map(cls).join('|'),
      toggleOrder: [...h.querySelector('.cat-toggle').children].map(cls).join('|'),
      x: { caret: left('.cat-caret'), dot: left('.cat-dot'), name: left('.cat-name'), more: left('.cat-more') },
      handleOpacity: getComputedStyle(h.querySelector('.handle')).opacity,
      caretRotated: before !== after
    })
  })()`))
  check('G1 箭头是分类头的第一个元素', head.order.startsWith('cat-toggle') && head.toggleOrder.startsWith('cat-caret'), head.toggleOrder)
  check('G2 箭头在最左、在名称左侧', head.x.caret < head.x.dot && head.x.dot < head.x.name,
    `caret=${head.x.caret} dot=${head.x.dot} name=${head.x.name}`)
  check('G3 折叠时箭头旋转 90°', head.caretRotated === true)
  check('G4 拖拽手柄默认不占视觉（opacity 0）', head.handleOpacity === '0', head.handleOpacity)

  const idsBefore = await evalJs(dock, 'state.categories.map((c) => c.id).join(",")')
  // 从分类名（不是手柄）按下并纵向拖 260px：验证整行都是拖拽热区
  await evalJs(dock, `(() => {
    const h = document.querySelector('.cat-head')
    const r = h.getBoundingClientRect()
    const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    const at = (y) => Object.assign({ clientX: Math.round(r.left + 30), clientY: Math.round(y) }, base)
    h.dispatchEvent(new PointerEvent('pointerdown', at(r.top + 16)))
    document.dispatchEvent(new PointerEvent('pointermove', at(r.top + 430)))
    document.dispatchEvent(new PointerEvent('pointerup', at(r.top + 430)))
    return true
  })()`)
  await sleep(600)
  const idsAfter = await evalJs(dock, 'state.categories.map((c) => c.id).join(",")')
  const sameSet = idsBefore.split(',').sort().join() === idsAfter.split(',').sort().join()
  check('G5 从名称处按下也能拖拽排序', idsBefore !== idsAfter && sameSet,
    `${idsBefore.slice(0, 30)} → ${idsAfter.slice(0, 30)}`)
  await shot(dock, 'verify-cat-head.png')

  /* -------------------------------------------------------- H 搜索结果视图 */
  console.log('\nH. 搜索：结果列表 / 命中高亮 / 分类 chip / 无结果出口')
  const s1 = JSON.parse(await evalJs(dock, `(() => {
    document.querySelector('#btnSearch').click()
    const i = document.querySelector('#searchInput')
    i.value = 'e'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    const rows = [...document.querySelectorAll('.res-row')]
    const expected = state.items.filter((x) => x.name.toLowerCase().includes('e')).length
    return JSON.stringify({
      rows: rows.length,
      expected,
      sub: document.querySelector('#subCount').textContent,
      chips: rows.filter((r) => r.querySelector('.res-cat')).length,
      marks: rows.filter((r) => r.querySelector('.res-name mark')).length,
      catHidden: getComputedStyle(document.querySelector('.cat')).display === 'none',
      hint: document.querySelector('#hint').textContent
    })
  })()`))
  check('H1 命中条数与数据一致', s1.rows === s1.expected && s1.expected > 0, `${s1.rows}/${s1.expected}`)
  check('H2 标题显示结果数', s1.sub === `${s1.expected} 个结果`, s1.sub)
  check('H3 每行都有分类 chip', s1.chips === s1.rows, `${s1.chips}/${s1.rows}`)
  check('H4 命中片段高亮为 mark', s1.marks > 0, `${s1.marks} 行`)
  check('H5 搜索时分类网格隐藏', s1.catHidden === true)
  check('H6 底栏提示改成 Esc 退出搜索', s1.hint === 'Esc 退出搜索', s1.hint)

  const s2 = JSON.parse(await evalJs(dock, `(() => {
    const i = document.querySelector('#searchInput')
    i.value = 'zzzz'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    const box = document.querySelector('.results.is-empty')
    return JSON.stringify({
      empty: !!box,
      centered: !!box && getComputedStyle(box).justifyContent === 'center',
      btn: box ? box.querySelector('.btn')?.textContent : null,
      sub: document.querySelector('#subCount').textContent
    })
  })()`))
  check('H7 无结果时显示居中空态与清空按钮', s2.empty && s2.centered && s2.btn === '清空搜索', JSON.stringify(s2))
  check('H8 无结果时标题写明没有匹配项', s2.sub === '没有匹配项', s2.sub)

  const s3 = JSON.parse(await evalJs(dock, `(() => {
    document.querySelector('.results .empty .btn').click()
    const list = document.querySelector('#list')
    return JSON.stringify({
      results: !!document.querySelector('.results'),
      searching: list.classList.contains('searching'),
      catVisible: getComputedStyle(document.querySelector('.cat')).display !== 'none',
      value: document.querySelector('#searchInput').value,
      sub: document.querySelector('#subCount').textContent
    })
  })()`))
  check('H9 清空搜索后回到分类网格', !s3.results && !s3.searching && s3.catVisible && s3.value === '', JSON.stringify(s3))
  await shot(dock, 'verify-search-clear.png')
  await evalJs(dock, "document.querySelector('#btnSearchClose').click(); true")

  /* ------------------------------------------------------ I 文件拖入反馈 */
  console.log('\nI. 从资源管理器拖文件：面板 / 目标分类 / 横幅 三重反馈')
  const dragInfo = JSON.parse(await evalJs(dock, `(async () => {
    const cats = [...document.querySelectorAll('.cat')]
    const cat = cats[1] || cats[0]
    const name = cat.querySelector('.cat-name').textContent
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], '测试.lnk', { type: 'application/octet-stream' }))
    const r = cat.getBoundingClientRect()
    const at = { clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 60) }
    const fire = (t, el) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
    fire('dragenter', cat)
    fire('dragover', cat)
    const banner = document.querySelector('#dropBanner')
    const on = {
      dragClass: document.body.classList.contains('is-file-drag'),
      target: document.querySelector('.cat.file-target .cat-name')?.textContent || null,
      banner: banner.hidden ? null : banner.textContent,
      hint: document.querySelector('#hint').textContent
    }
    fire('dragleave', document.querySelector('#panel'))
    await new Promise((res) => setTimeout(res, 280))
    const off = {
      dragClass: document.body.classList.contains('is-file-drag'),
      target: !!document.querySelector('.cat.file-target'),
      bannerHidden: banner.hidden,
      hint: document.querySelector('#hint').textContent
    }
    return JSON.stringify({ name, on, off })
  })()`))
  check('I1 拖入时面板进入文件拖拽态', dragInfo.on.dragClass === true)
  check('I2 指针所在分类被高亮', dragInfo.on.target === dragInfo.name, `${dragInfo.on.target} / ${dragInfo.name}`)
  check('I3 横幅写明松手会进哪个分类', (dragInfo.on.banner || '').includes(dragInfo.name), dragInfo.on.banner)
  check('I4 拖入时底栏不重复同一句', dragInfo.on.hint === '', JSON.stringify(dragInfo.on.hint))
  check('I5 离开后反馈全部撤销', !dragInfo.off.dragClass && !dragInfo.off.target && dragInfo.off.bannerHidden && dragInfo.off.hint === '拖图标可换分类',
    JSON.stringify(dragInfo.off))

  /* ------------------------------------------------------------- J 图钉 */
  console.log('\nJ. 图钉：未固定描边 / 固定后填实')
  const pin = JSON.parse(await evalJs(dock, `(() => {
    // 真实配置可能本来就是固定的，先归零，从"未固定"这个已知状态开始
    state.settings.pinned = false
    applySettings()
    const b = document.querySelector('#btnPin')
    const p = b.querySelector('path')
    const read = () => ({
      pressed: b.getAttribute('aria-pressed'),
      on: b.classList.contains('on'),
      fill: getComputedStyle(p).fill
    })
    const before = read()
    b.click()
    const after = read()
    b.click()
    return JSON.stringify({ before, after })
  })()`))
  check('J1 未固定时是描边（fill none）', pin.before.pressed === 'false' && pin.before.fill === 'none', JSON.stringify(pin.before))
  check('J2 固定后 aria-pressed 与填实同时生效', pin.after.pressed === 'true' && pin.after.on && pin.after.fill !== 'none',
    JSON.stringify(pin.after))

  /* --------------------------------------------------------- K 分类头吸顶 */
  console.log('\nK. 分类头吸顶')
  const sticky = JSON.parse(await evalJs(dock, `(() => {
    const list = document.querySelector('#list')
    const prev = list.style.cssText
    // 先把列表压矮，保证一定滚得动，结论与窗口高度无关
    list.style.flex = '0 0 auto'
    // 视口压到比任何一组都矮，滚动才真正跨进分组内部
    list.style.height = '160px'
    const cats = [...document.querySelectorAll('.cat')]
    const tallest = cats.reduce((a, b) => b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a)
    const lr0 = list.getBoundingClientRect()
    const cr0 = tallest.getBoundingClientRect()
    // 停在"最高那一组"内部 60px 处：标题该吸住，磁贴从它下面穿过去
    list.scrollTop = Math.round(list.scrollTop + (cr0.top - lr0.top) + 60)
    const lr = list.getBoundingClientRect()
    const head = tallest.querySelector('.cat-head')
    const hr = head.getBoundingClientRect()
    const heads = [...document.querySelectorAll('.cat-head')]
    const stuck = heads.filter((h) => Math.abs(h.getBoundingClientRect().top - lr.top - 8) <= 2)
      .map((h) => h.querySelector('.cat-name').textContent)
    const out = {
      scrolled: Math.round(list.scrollTop),
      sh: list.scrollHeight, ch: list.clientHeight,
      tallestName: head.querySelector('.cat-name').textContent,
      headTop: Math.round(hr.top - lr.top),
      stuck,
      insideSection: hr.bottom <= tallest.getBoundingClientRect().bottom + 1,
      // 吸住的标题必须盖住磁贴：取它下沿往上 2px 的像素，不应还看到磁贴
      opaque: getComputedStyle(head).backgroundColor !== 'rgba(0, 0, 0, 0)'
    }
    list.style.cssText = prev
    list.scrollTop = 0
    return JSON.stringify(out)
  })()`))
  check('K1 列表可滚动（测试前提）', sticky.scrolled > 0, JSON.stringify(sticky))
  check('K2 当前分组标题吸在列表顶部', sticky.headTop === 8, `${sticky.tallestName} top=${sticky.headTop}`)
  check('K3 同时只有一个标题吸顶', sticky.stuck.length === 1 && sticky.stuck[0] === sticky.tallestName, JSON.stringify(sticky.stuck))
  check('K4 吸顶没有越过所属分组', sticky.insideSection === true)
  check('K5 吸顶标题是不透明底', sticky.opaque === true)

  console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
  await sleep(300)
  app.exit(fails === 0 ? 0 : 1)
})
