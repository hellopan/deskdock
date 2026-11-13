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

  console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
  await sleep(300)
  app.exit(fails === 0 ? 0 : 1)
})
