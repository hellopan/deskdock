'use strict'
/* renderer.js — 桌面坞界面逻辑 */

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const api = window.dock
/* ICON 在 icons.js 里定义（脚本先于本文件加载） */
let state = null
let query = ''
// 图标缓存要跟着"来源"走：.lnk 的真实目标晚一点才解析出来，
// 解析完 target 变了就得重新取一次，否则一直显示通用快捷方式图标
const iconCache = new Map()   // id -> dataURL
const iconKey = new Map()     // id -> 取图时用的 target|iconLoc

function iconSig(item) {
  return (item.target || '') + '|' + (item.iconLoc || '')
}
const requestedIcons = new Set()

/* ------------------------------------------------------------ 基础动作 */

function toast(text, type) {
  const wrap = $('#toasts')
  const t = el('div', 'toast' + (type ? ' ' + type : ''), text)
  wrap.appendChild(t)
  setTimeout(() => {
    t.style.transition = 'opacity .2s ease, transform .2s ease'
    t.style.opacity = '0'
    t.style.transform = 'translateY(6px)'
    setTimeout(() => t.remove(), 220)
  }, 2400)
}

function applySettings() {
  if (!state || !state.settings) return
  const s = state.settings
  document.body.dataset.theme = s.theme || 'dark'
  document.body.dataset.edge = s.edge || 'left'
  document.body.classList.toggle('no-label', s.showLabels === false)
  document.documentElement.style.setProperty('--icon', (s.iconSize || 44) + 'px')
  document.documentElement.style.setProperty('--tile', (s.tileSize || 74) + 'px')
  document.documentElement.style.setProperty('--peek', (s.peek || 4) + 'px')
  document.documentElement.style.setProperty('--cd-dur', (cooldownMs() || 2000) + 'ms')
  // 竖排（左右贴边）时列数由主进程按内容算好；上下贴边给 0，交给 CSS 自动排列
  const cols = Number(state.cols) || 0
  document.documentElement.style.setProperty('--cols', String(Math.max(1, cols)))
  document.body.dataset.fit = cols > 0 ? 'cols' : 'auto'
  $('#btnPin').classList.toggle('on', !!s.pinned)
  $('#btnPin').setAttribute('aria-pressed', String(!!s.pinned))
}

/* --------------------------------------------------------------- 渲染 */

function itemsOf(catId) {
  return state.items.filter((i) => i.categoryId === catId)
}

/* 点击后的"技能冷却"：图标上跑一圈扇形扫描，扫过的部分恢复本色。
   冷却时长来自设置项 cooldownMs，冷却期间再点击直接忽略（不会重复启动程序）。 */
function cooldownMs() {
  const v = Number(state.settings.cooldownMs)
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : 0
}

function playCooldown(ico) {
  if (!ico) return
  const ms = cooldownMs()
  if (!ms) return
  ico.classList.remove('cooling')
  void ico.offsetWidth   // 强制重排，重启动画
  ico.classList.add('cooling')
  clearTimeout(ico._cdTimer)
  ico._cdTimer = setTimeout(() => ico.classList.remove('cooling'), ms + 40)
}

function stopCooldown(ico) {
  if (!ico) return
  clearTimeout(ico._cdTimer)
  ico.classList.remove('cooling')
}

/* 磁贴节点只建一次，之后由 updateTile 原地更新；事件里一律读 dataset.id，
   不闭包捕获条目对象，避免状态换了一轮还在用旧值 */
function createTile(item) {
  const t = el('button', 'tile')
  t.type = 'button'
  t.draggable = true
  t.tabIndex = -1   // 由 setRoving 决定谁进 Tab 序列
  t.dataset.id = item.id
  const ico = el('div', 'ico')
  const label = el('div', 'label')
  t.append(ico, label)

  t.addEventListener('click', async () => {
    // 冷却期内第二次点击直接丢弃：既不重开程序，也不重启动画
    if (ico.classList.contains('cooling')) return
    playCooldown(ico)
    const r = await api.openItem(t.dataset.id)
    if (r && r.ok === false && r.message) {
      stopCooldown(ico)   // 没打开成功就别罚站，允许立刻重试
      toast('打开失败：' + r.message, 'err')
    }
  })
  t.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    api.itemMenu(t.dataset.id)
  })
  t.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-dock-item', t.dataset.id)
    e.dataTransfer.effectAllowed = 'move'
    t.classList.add('dragging')
  })
  t.addEventListener('dragend', () => {
    t.classList.remove('dragging')
    clearDropLine()
  })
  return t
}

/** 把条目数据落到已有节点上；只有内容真的变了才写 DOM */
function updateTile(t, item) {
  const missing = !!item.missing
  if (t.classList.contains('missing') !== missing) t.classList.toggle('missing', missing)
  const title = missing
    ? `${item.name}\n⚠️ 快捷方式文件已丢失，可在 设置 → 数据 → 修复失效项 处理`
    : `${item.name}\n右键更多操作`
  if (t.title !== title) t.title = title
  // 关掉"显示名称"后标签是 display:none，没有 aria-label 就成无名按钮了
  if (t.getAttribute('aria-label') !== item.name) t.setAttribute('aria-label', item.name)
  const label = t.querySelector('.label')
  if (label.dataset.name !== item.name) fillLabel(label, item.name)
  paintIcon(t, item)
}

/* 68px 磁贴里一个长单词只能硬切，WorkBuddy 会断成 "WorkBudd / y"（孤字）。
   在大小写交界处插 <wbr> 给它一个"像样的"断点：Work / Buddy。
   用节点拼而不是 innerHTML —— 名称来自文件名，不能当 HTML 解析。 */
function fillLabel(label, name) {
  label.dataset.name = name
  label.textContent = ''
  const parts = name.split(/(?<=[a-z0-9])(?=[A-Z])/)
  parts.forEach((part, i) => {
    if (i) label.appendChild(document.createElement('wbr'))
    label.appendChild(document.createTextNode(part))
  })
}

/** 图标按 target|iconLoc 的签名判断要不要重取，避免每次渲染都重新解码图片 */
function paintIcon(t, item) {
  const sig = iconSig(item)
  if (t.dataset.sig === sig) return
  t.dataset.sig = sig
  const ico = t.querySelector('.ico')
  ico.innerHTML = ''
  const cached = iconCache.get(item.id)
  if (cached && iconKey.get(item.id) === sig) {
    const img = el('img')
    img.src = cached
    img.alt = ''
    ico.appendChild(img)
  } else {
    ico.appendChild(el('div', 'fallback', (item.name[0] || '?').toUpperCase()))
    requestIcon(item, ico)
  }
}

async function requestIcon(item, holder) {
  const token = item.id + '|' + iconSig(item)
  if (requestedIcons.has(token)) return
  requestedIcons.add(token)
  const data = await api.getIcon(item.id)
  if (data) {
    iconCache.set(item.id, data)
    iconKey.set(item.id, iconSig(item))
    if (holder.isConnected) {
      holder.innerHTML = ''
      const img = el('img')
      img.src = data
      holder.appendChild(img)
    }
  } else {
    // 这次没取到（比如目标还没解析完），允许下次重试
    requestedIcons.delete(token)
  }
}

/* 分类头与网格也只建一次：折叠/排序/拖放的事件在创建时绑定，
   数据一律按 dataset.id 现查，所以不需要在每次渲染时重新绑定 */
function createCat(cat) {
  const sec = el('section', 'cat')
  sec.dataset.id = cat.id

  const head = el('div', 'cat-head')
  const handle = el('span', 'handle')
  handle.innerHTML = ICON.grip
  handle.title = '拖动排序'
  handle.setAttribute('aria-hidden', 'true')
  const dot = el('span', 'cat-dot')
  const name = el('span', 'cat-name')
  const count = el('span', 'cat-count')
  const spacer = el('span', 'cat-spacer')
  const more = el('button', 'cat-more')
  more.type = 'button'
  more.innerHTML = ICON.more
  more.title = '分类操作'
  const caret = el('span', 'cat-caret')
  caret.setAttribute('aria-hidden', 'true')
  caret.innerHTML = ICON.chevron

  /* 折叠开关用真正的 button：Tab 能聚焦、Enter/Space 原生激活、
     屏幕阅读器能读到 aria-expanded。点击仍冒泡到 head 上统一处理，
     这样点整行任意空白处也照样折叠。 */
  const toggle = el('button', 'cat-toggle')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'true')
  toggle.append(dot, name, count, spacer, caret)
  head.append(handle, toggle, more)

  head.addEventListener('click', (e) => {
    if (e.target.closest('.cat-more') || handle.contains(e.target)) return
    if (suppressCatClick) return
    toggleCategory(sec, !sec.classList.contains('collapsed'))
  })
  more.addEventListener('click', (e) => {
    e.stopPropagation()
    api.categoryMenu(sec.dataset.id)
  })
  handle.addEventListener('pointerdown', (e) => startCatDrag(e, sec))

  const grid = el('div', 'grid')
  grid.dataset.cat = cat.id
  grid.id = 'grid-' + cat.id
  toggle.setAttribute('aria-controls', grid.id)
  bindGrid(grid, sec)

  sec.append(head, grid)
  return { sec, grid, name, count, dot, more, toggle }
}

/* 折叠状态只有一处写口：class 与 aria-expanded 一起改，避免两处不同步 */
function setCollapsed(sec, on) {
  sec.classList.toggle('collapsed', !!on)
  const t = sec.querySelector('.cat-toggle')
  if (t) t.setAttribute('aria-expanded', String(!on))
}

/* 折叠并落盘。搜索时分类是强制展开的，这种情况下不写回配置。 */
function toggleCategory(sec, next) {
  setCollapsed(sec, next)
  api.collapseCategory(sec.dataset.id, next)
}

function bindGrid(grid, sec) {
  /* 拖放：接收其他分类拖来的图标 */
  grid.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-dock-item')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (sec.classList.contains('collapsed')) setCollapsed(sec, false)
    grid.classList.add('drop-over')
    const { index } = dropIndex(grid, e.clientX, e.clientY)
    showDropLine(grid, index)
  })
  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) {
      grid.classList.remove('drop-over')
      clearDropLine()
    }
  })
  grid.addEventListener('drop', async (e) => {
    const id = e.dataTransfer.getData('application/x-dock-item')
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    grid.classList.remove('drop-over')
    const { index } = dropIndex(grid, e.clientX, e.clientY)
    clearDropLine()
    await api.moveItem(id, grid.dataset.cat, index)
  })
}

function updateCat(rec, cat, items, searching) {
  if (rec.name.textContent !== cat.name) rec.name.textContent = cat.name
  rec.dot.style.background = cat.color
  const n = String(items.length)
  if (rec.count.textContent !== n) rec.count.textContent = n
  rec.more.setAttribute('aria-label', `「${cat.name}」的分类操作`)
  // 只读给屏幕阅读器：整行是一个按钮，读成"编程开发，12 个快捷方式，已折叠"
  rec.toggle.setAttribute('aria-label', `${cat.name}，${items.length} 个快捷方式`)
  // 搜索结果一律展开，否则"搜到 3 个"却看不到，还要手动点开
  setCollapsed(rec.sec, !!cat.collapsed && !searching)
  syncGrid(rec, items)
}

/**
 * 网格增量更新：
 * 1) 倒序遍历目标顺序，把每个磁贴插到"下一个"之前，天然得到正序，不用算下标；
 * 2) 先摘掉不属于本分类的磁贴——如果它只是被拖到了别的分类，后面那一组会把它接过去复用。
 */
function syncGrid(rec, items) {
  const grid = rec.grid
  const want = new Set(items.map((i) => i.id))

  const dz = grid.querySelector('.dropzone')
  if (items.length) {
    if (dz) dz.remove()
  } else if (!dz) {
    const zone = el('div', 'dropzone')
    zone.appendChild(el('span', 'dz-text', '拖快捷方式到这里'))
    grid.appendChild(zone)
  }

  for (const child of [...grid.children]) {
    if (child.classList.contains('tile') && !want.has(child.dataset.id)) child.remove()
  }

  let next = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    let t = view.tiles.get(item.id)
    if (!t) {
      t = createTile(item)
      view.tiles.set(item.id, t)
    }
    updateTile(t, item)
    if (next) {
      if (t.parentElement !== grid || t.nextElementSibling !== next) grid.insertBefore(t, next)
    } else if (t.parentElement !== grid || t.nextElementSibling) {
      grid.appendChild(t)
    }
    next = t
  }
  // 焦点还在本网格里就保住它，否则把入口还给第一个磁贴
  const cur = document.activeElement
  setRoving(grid, cur && grid.contains(cur) && cur.classList.contains('tile') ? cur : null)
}

/* 每个网格只放一个磁贴进 Tab 序列（roving tabindex）：
   53 个磁贴全是 tabindex=0 的话，键盘用户得按 53 次 Tab 才能走出列表。
   方向键在组内移动时，把 0 交给新位置。 */
function setRoving(grid, active) {
  const tiles = [...grid.querySelectorAll('.tile')]
  if (!tiles.length) return
  const keep = active && tiles.includes(active) ? active : tiles[0]
  for (const t of tiles) t.tabIndex = t === keep ? 0 : -1
}

function clearDropLine() {
  document.querySelectorAll('.drop-line').forEach((n) => n.remove())
}

function showDropLine(grid, index) {
  clearDropLine()
  const tiles = [...grid.querySelectorAll('.tile')].filter((t) => !t.classList.contains('dragging'))
  const line = el('div', 'drop-line')
  if (index >= tiles.length) grid.appendChild(line)
  else grid.insertBefore(line, tiles[index])
}

function dropIndex(grid, x, y) {
  const tiles = [...grid.querySelectorAll('.tile')].filter((t) => !t.classList.contains('dragging'))
  const line = grid.querySelector('.drop-line')
  let index = 0
  for (let i = 0; i < tiles.length; i++) {
    const r = tiles[i].getBoundingClientRect()
    if (y >= r.top && y <= r.bottom) {
      if (x < r.left + r.width / 2) return { index: index }
      index++
      continue
    }
    if (y < r.top) return { index: index }
    index++
  }
  if (line) line.remove()
  return { index: Math.max(0, index) }
}

/* 增量渲染用的节点表：分类 / 磁贴都按 id 复用，
   整表重建会丢焦点、丢滚动位置、每次重新解码图标，条目一多就能看到闪一下 */
const view = {
  cats: new Map(),    // 分类 id -> createCat 返回的记录
  tiles: new Map(),   // 条目 id -> 磁贴节点
  msg: null           // 空态 / 搜索无结果，独立挂在列表里
}

function resetList() {
  $('#list').innerHTML = ''
  view.cats.clear()
  view.tiles.clear()
  view.msg = null
}

function setListMessage(node) {
  if (view.msg) {
    view.msg.remove()
    view.msg = null
  }
  if (!node) return
  $('#list').appendChild(node)
  view.msg = node
}

function render() {
  const t0 = performance.now()
  try {
    paintList()
  } finally {
    // 开发模式：慢渲染打一行，条目多到 120 时能立刻看出退化；打包版不打印
    const dt = performance.now() - t0
    if (dt > 40 && state && !state.isPackaged) {
      console.log('[render] ' + dt.toFixed(1) + 'ms · ' + state.items.length + ' 项')
    }
  }
}

function paintList() {
  const list = $('#list')
  const q = query.trim().toLowerCase()
  const searching = !!q
  const total = state.items.length

  $('#subCount').textContent = searching
    ? `搜索 "${query.trim()}"`
    : `${total} 个快捷方式 · ${state.categories.length} 个分类`

  // 能重新渲染说明这一轮数据已经落定，拖拽插入线不该留着
  clearDropLine()

  if (!total) {
    resetList()
    const box = el('div', 'empty full')
    box.innerHTML = '<b>坞里还是空的</b><br>点下面的按钮，把桌面上的快捷方式一次收进来<br>也可以直接把 .lnk 文件拖到窗口里'
    const btn = el('button', 'btn primary sm', '从桌面导入快捷方式')
    btn.addEventListener('click', importFlow)
    box.appendChild(btn)
    setListMessage(box)
    return
  }

  const visible = []
  for (const cat of state.categories) {
    let items = itemsOf(cat.id)
    if (searching) items = items.filter((i) => i.name.toLowerCase().includes(q))
    if (searching && !items.length) continue
    visible.push({ cat, items })
  }

  // 倒序摆放分类：每个都插到"下一个"之前，最终就是正序
  let next = null
  for (let i = visible.length - 1; i >= 0; i--) {
    const { cat, items } = visible[i]
    let rec = view.cats.get(cat.id)
    if (!rec) {
      rec = createCat(cat)
      view.cats.set(cat.id, rec)
    }
    updateCat(rec, cat, items, searching)
    if (next) {
      if (rec.sec.parentElement !== list || rec.sec.nextElementSibling !== next) list.insertBefore(rec.sec, next)
    } else if (rec.sec.parentElement !== list || rec.sec.nextElementSibling) {
      list.appendChild(rec.sec)
    }
    next = rec.sec
  }

  // 分类被删或搜索过滤掉了，节点和缓存一起清
  const shown = new Set(visible.map((v) => v.cat.id))
  for (const [id, rec] of view.cats) {
    if (shown.has(id)) continue
    rec.sec.remove()
    view.cats.delete(id)
  }

  setListMessage(searching && !visible.length
    ? el('div', 'empty', `没有找到包含 “${query.trim()}” 的快捷方式`)
    : null)

  // 已经不在坞里、也没被别的分类接手的磁贴
  for (const [id, t] of view.tiles) if (!t.isConnected) view.tiles.delete(id)
  // 键盘焦点环跟着节点走，节点没了就一起清掉
  if (kbTile && !kbTile.isConnected) kbTile = null
}

/* --------------------------------------------------- 分类拖动排序 */

let catDrag = null
let suppressCatClick = false

function startCatDrag(e, sec) {
  if (e.button !== 0) return
  e.preventDefault()
  const list = $('#list')
  const rect = sec.getBoundingClientRect()
  const ph = el('div', 'cat-drag-ph')
  ph.style.height = Math.max(30, rect.height) + 'px'
  catDrag = { sec, ph, list, started: false, y0: e.clientY }

  const onMove = (ev) => {
    if (!catDrag) return
    if (!catDrag.started) {
      if (Math.abs(ev.clientY - catDrag.y0) < 5) return
      catDrag.started = true
      sec.classList.add('drag-src')
      list.insertBefore(ph, sec)
      document.body.classList.add('dragging-cat')
    }
    // 根据鼠标位置移动占位块
    const sections = [...list.querySelectorAll('.cat')].filter((s) => s !== sec)
    let placed = false
    for (const s of sections) {
      const r = s.getBoundingClientRect()
      if (ev.clientY < r.top + r.height / 2) {
        list.insertBefore(ph, s)
        placed = true
        break
      }
    }
    if (!placed) list.appendChild(ph)
    // 自动滚动
    const lr = list.getBoundingClientRect()
    if (ev.clientY < lr.top + 30) list.scrollTop -= 12
    else if (ev.clientY > lr.bottom - 30) list.scrollTop += 12
  }

  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    document.body.classList.remove('dragging-cat')
    if (!catDrag) return
    const { started } = catDrag
    const draggedId = sec.dataset.id
    if (started) {
      suppressCatClick = true
      setTimeout(() => { suppressCatClick = false }, 60)
      let pos = 0
      for (const child of [...list.children]) {
        if (child === ph) break
        if (child.classList.contains('cat') && child !== sec) pos++
      }
      const ids = [...list.querySelectorAll('.cat')].filter((s) => s !== sec).map((s) => s.dataset.id)
      ids.splice(Math.min(pos, ids.length), 0, draggedId)
      api.reorderCategories(ids)
    }
    ph.remove()
    sec.classList.remove('drag-src')
    catDrag = null
  }

  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}

/* ------------------------------------------------------------- 弹窗 */

let modalPrevFocus = null

function closeModal() {
  $('#mask').hidden = true
  $('#modal').innerHTML = ''
  document.querySelectorAll('.picker-menu').forEach((n) => n.remove())
  // 弹窗关掉后把焦点还给打开它的那个按钮，键盘用户不会掉到页面开头
  if (modalPrevFocus && modalPrevFocus.isConnected) modalPrevFocus.focus({ preventScroll: true })
  modalPrevFocus = null
}

function openModal(build) {
  const modal = $('#modal')
  modal.innerHTML = ''
  // 自绘下拉的浮层挂在 body 上，换/关弹窗时要一起清掉
  document.querySelectorAll('.picker-menu').forEach((n) => n.remove())
  modalPrevFocus = document.activeElement
  const mask = $('#mask')
  mask.hidden = false
  mask.onclick = (e) => { if (e.target === mask) closeModal() }
  build(modal)
  const head = modal.querySelector('.modal-head')
  modal.setAttribute('aria-label', head ? head.textContent : '对话框')
  // 焦点送进弹窗，否则 Tab 还在背后的列表里走
  const first = modal.querySelector('input:not([type="hidden"]), button, [tabindex]')
  if (first) first.focus({ preventScroll: true })
}

/** Tab 在弹窗内循环，不跑到底下的列表去 */
function trapModalFocus(e) {
  if ($('#mask').hidden || e.key !== 'Tab') return
  const nodes = [...$('#modal').querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null)
  if (!nodes.length) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

function askText(title, initial, placeholder) {
  return new Promise((resolve) => {
    openModal((m) => {
      m.appendChild(el('div', 'modal-head', title))
      const body = el('div', 'modal-body')
      const input = document.createElement('input')
      input.className = 'field-input'
      input.value = initial || ''
      input.placeholder = placeholder || ''
      input.maxLength = 40
      body.appendChild(input)
      m.appendChild(body)
      const foot = el('div', 'modal-foot')
      const cancel = el('button', 'btn', '取消')
      const ok = el('button', 'btn primary', '确定')
      const done = (v) => { closeModal(); resolve(v) }
      cancel.addEventListener('click', () => done(null))
      ok.addEventListener('click', () => done(input.value.trim() || null))
      input.addEventListener('keydown', (e) => {
        // 组合期 Enter 是上屏候选词、Esc 是取消候选，都不能当成"确定/取消"
        if (e.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') done(input.value.trim() || null)
        if (e.key === 'Escape') done(null)
      })
      foot.append(cancel, ok)
      m.appendChild(foot)
      setTimeout(() => { input.focus(); input.select() }, 30)
    })
  })
}

const COLORS = ['#5B8CFF', '#39C0A0', '#B07BFF', '#F5A24B', '#4FC3E8', '#F2728C', '#8FBF3F', '#C9A227']

function pickColor(title, current) {
  return new Promise((resolve) => {
    openModal((m) => {
      m.appendChild(el('div', 'modal-head', title))
      const body = el('div', 'modal-body')
      const wrap = el('div', 'swatches')
      let picked = current
      for (const c of COLORS) {
        const sw = el('div', 'sw' + (c === current ? ' on' : ''))
        sw.style.background = c
        sw.addEventListener('click', () => {
          [...wrap.children].forEach((x) => x.classList.remove('on'))
          sw.classList.add('on')
          picked = c
        })
        wrap.appendChild(sw)
      }
      body.appendChild(wrap)
      m.appendChild(body)
      const foot = el('div', 'modal-foot')
      const cancel = el('button', 'btn', '取消')
      const ok = el('button', 'btn primary', '确定')
      cancel.addEventListener('click', () => { closeModal(); resolve(null) })
      ok.addEventListener('click', () => { closeModal(); resolve(picked) })
      foot.append(cancel, ok)
      m.appendChild(foot)
    })
  })
}

/* --------------------------------------------------------- 添加分类 */

async function addCategoryFlow() {
  const name = await askText('新建分类', '', '例如：设计工具')
  if (!name) return
  await api.addCategory(name)
  toast('已创建「' + name + '」', 'ok')
}

/* --------------------------------------------------------- 桌面导入 */

/** 名称归一化，用来判断桌面文件是不是坞里已有的那个 */
function importKey(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function catName(id) {
  const c = state.categories.find((x) => x.id === id)
  return c ? c.name : '未分类'
}

/**
 * 自绘下拉选择器。
 * 不用原生 <select>：它的弹出列表是系统控件，深色主题下会变成"白底白字"看不见选项，
 * 而且 CSS 管不到。这里自己画一个跟面板同色的浮层。
 */
function makePicker(options, initialValue, onPick) {
  const wrap = el('div', 'picker')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'picker-btn'
  const label = el('span', 'picker-label')
  const caret = el('span', 'picker-caret')
  btn.append(label, caret)
  wrap.appendChild(btn)

  let value = initialValue
  let menu = null

  const setLabel = () => {
    const hit = options.find((o) => o.value === value)
    label.textContent = hit ? hit.label : '请选择'
    label.title = label.textContent
  }
  setLabel()

  function onDocDown(e) {
    if (!menu) return
    if (menu.contains(e.target) || wrap.contains(e.target)) return
    close()
  }

  function close() {
    if (!menu) return
    menu.remove()
    menu = null
    wrap.classList.remove('open')
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('resize', close)
  }

  function open() {
    close()
    menu = el('div', 'picker-menu')
    menu.style.minWidth = Math.max(140, btn.getBoundingClientRect().width) + 'px'
    for (const o of options) {
      const item = el('div', 'picker-item' + (o.value === value ? ' on' : ''), o.label)
      item.addEventListener('click', () => {
        value = o.value
        setLabel()
        close()
        if (onPick) onPick(value)
      })
      menu.appendChild(item)
    }
    document.body.appendChild(menu)

    // 用 fixed 定位挂在 body 上，避免被 .modal-body 的滚动区裁掉
    const r = btn.getBoundingClientRect()
    const mh = menu.offsetHeight
    const width = menu.offsetWidth
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px'
    if (window.innerHeight - r.bottom - 8 < mh && r.top > mh + 8) {
      menu.style.top = r.top - mh - 6 + 'px'
    } else {
      menu.style.top = r.bottom + 6 + 'px'
    }
    wrap.classList.add('open')
    document.addEventListener('mousedown', onDocDown, true)
    window.addEventListener('resize', close)
  }

  btn.addEventListener('click', () => { if (menu) close(); else open() })

  return {
    el: wrap,
    get value() { return value },
    close
  }
}

async function importFlow() {
  const found = await api.scanDesktop()
  if (!found.length) {
    toast('桌面上没有找到可导入的快捷方式')
    return
  }
  const defaultCat = state.categories.find((c) => c.name.includes('未分类')) || state.categories[state.categories.length - 1]

  // 坞里已有条目（按显示名），用于"已配置过分类的仍回原分类"
  const existing = new Map()
  for (const it of state.items) {
    const k = importKey(it.name)
    if (k && !existing.has(k)) existing.set(k, it)
  }

  openModal((m) => {
    m.appendChild(el('div', 'modal-head', `从桌面导入（找到 ${found.length} 个）`))

    const body = el('div', 'modal-body')
    const list = el('div', 'pick-list')
    const checks = []
    const tags = []
    for (const f of found) {
      const lab = el('label', 'pick')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = true
      cb.dataset.path = f.path
      checks.push(cb)
      const nm = el('span', 'pname', f.name)
      lab.append(cb, nm)

      const hit = existing.get(importKey(f.name))
      if (hit) {
        const t = el('span', 'ptag keep', hit.missing ? `补回「${catName(hit.categoryId)}」` : `已在「${catName(hit.categoryId)}」`)
        t.dataset.category = catName(hit.categoryId)
        t.dataset.missing = hit.missing ? '1' : '0'
        lab.appendChild(t)
        tags.push(t)
        lab.title = hit.missing
          ? `坞里已有同名条目，文件丢了，这次会补回文件并保留「${catName(hit.categoryId)}」分类`
          : `坞里已有同名条目，保留原分类「${catName(hit.categoryId)}」，不会重复添加`
      }
      if (f.fromPublic) lab.appendChild(el('span', 'ptag', '公共桌面'))
      list.appendChild(lab)
    }
    body.appendChild(list)

    const sel = el('div', 'select-row')
    const selLabel = el('span', 'select-label', '')
    const picker = makePicker(
      state.categories.map((c) => ({ value: c.id, label: c.name })),
      defaultCat.id
    )
    sel.append(selLabel, picker.el)
    body.appendChild(sel)

    // 保留原分类（默认开）
    const keepRow = el('label', 'check-row')
    const cbKeep = document.createElement('input')
    cbKeep.type = 'checkbox'
    cbKeep.checked = state.settings.importKeepCategory !== false
    keepRow.append(cbKeep, document.createTextNode('已配置过分类的快捷方式，仍放回原分类'))
    body.appendChild(keepRow)

    const hint = el('div', 'import-hint')
    body.appendChild(hint)

    const syncLabels = () => {
      const keep = cbKeep.checked
      selLabel.textContent = keep ? '新条目放入' : '全部放入'
      for (const t of tags) {
        t.hidden = !keep
      }
      const n = tags.length
      hint.textContent = n
        ? keep
          ? `其中 ${n} 个在坞里已有记录，会保留原分类、不重复添加；其余新条目放进上面选的分类。`
          : `已关闭保留原分类：这 ${n} 个会在所选分类里再添加一份（原条目不动，可能出现重复）。`
        : '桌面上这些都是新条目，会放进上面选的分类。'
    }
    cbKeep.addEventListener('change', syncLabels)
    syncLabels()

    const checkRow = el('label', 'check-row')
    const cbMove = document.createElement('input')
    cbMove.type = 'checkbox'
    cbMove.checked = true
    checkRow.append(cbMove, document.createTextNode('导入后把桌面上的原件移除（推荐，桌面就干净了）'))
    body.appendChild(checkRow)

    const tip = el('div', 'path-text')
    tip.style.marginTop = '10px'
    tip.textContent = '所有文件都会先完整复制到坞的数据目录，再移除桌面原件，不会丢。想复原可在设置里「把所有快捷方式放回桌面」。'
    body.appendChild(tip)
    m.appendChild(body)

    const foot = el('div', 'modal-foot')
    const btnAll = el('button', 'btn sm', '全选/全不选')
    btnAll.style.marginRight = 'auto'
    btnAll.addEventListener('click', () => {
      const allOn = checks.every((c) => c.checked)
      checks.forEach((c) => { c.checked = !allOn })
    })
    const cancel = el('button', 'btn', '取消')
    const ok = el('button', 'btn primary', '导入')
    cancel.addEventListener('click', closeModal)
    ok.addEventListener('click', async () => {
      const paths = checks.filter((c) => c.checked).map((c) => c.dataset.path)
      if (!paths.length) return toast('一个都没选', 'err')
      ok.disabled = true
      ok.textContent = '导入中…'
      const keep = cbKeep.checked
      const r = await api.importFromDesktop(paths, picker.value, cbMove.checked, keep)
      if (state.settings.importKeepCategory !== keep) {
        state.settings.importKeepCategory = keep
        api.updateSettings({ importKeepCategory: keep })
      }
      closeModal()
      const parts = []
      if (r.imported) parts.push(`新增 ${r.imported} 个`)
      if (r.kept) parts.push(`保留原分类 ${r.kept} 个`)
      const msg = parts.length ? `已导入：${parts.join('，')}` : '没有可导入的条目'
      toast(msg, 'ok')
      if (r.repaired) toast(`其中 ${r.repaired} 个丢了文件的已按原条目补回`, 'ok')
      if (r.removed) toast(`桌面已清理 ${r.removed} 个`, 'ok')
      if (r.failed && r.failed.length) toast(`${r.failed.length} 个失败`, 'err')
    })
    foot.append(btnAll, cancel, ok)
    m.appendChild(foot)
  })
}

/* -------------------------------------------------------------- 事件 */

/* 方向键移动焦点时，Chromium 不会给 .focus() 的结果套 :focus-visible，
   必须自己标一个类，否则键盘用户看不到焦点跑到哪了 */
let kbTile = null
function setKbRing(t) {
  if (kbTile && kbTile !== t) kbTile.classList.remove('kb-focus')
  kbTile = t
  if (t) t.classList.add('kb-focus')
}

/* 方向键在磁贴间移动焦点：按当前网格的实际列数换算，跨分类连续。
   只在焦点已经在磁贴上时接管，否则把方向键留给列表滚动。 */
function focusByArrow(e) {
  const cur = document.activeElement
  if (!cur || !cur.classList.contains('tile')) return false
  // 兼容两种键名：标准是 ArrowRight，旧式 / 部分输入法给的是 Right
  let key = ''
  if (e.key === 'Home' || e.key === 'End') key = e.key
  else if (/^(Arrow)?Up$/.test(e.key)) key = 'ArrowUp'
  else if (/^(Arrow)?Down$/.test(e.key)) key = 'ArrowDown'
  else if (/^(Arrow)?Left$/.test(e.key)) key = 'ArrowLeft'
  else if (/^(Arrow)?Right$/.test(e.key)) key = 'ArrowRight'
  else return false
  // 折叠分类里的磁贴是 display:none，focus() 会静默失败，先排除掉
  const all = [...document.querySelectorAll('#list .tile')].filter((t) => t.getClientRects().length)
  const i = all.indexOf(cur)
  if (i < 0) return false
  const grid = cur.closest('.grid')
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1
  let next = null
  if (key === 'ArrowRight') next = all[i + 1]
  else if (key === 'ArrowLeft') next = all[i - 1]
  else if (key === 'ArrowDown') next = all[i + cols]
  else if (key === 'ArrowUp') next = all[i - cols]
  else if (key === 'Home') next = all[0]
  else if (key === 'End') next = all[all.length - 1]
  if (!next || next === cur) return false
  next.focus()
  setKbRing(next)
  const g = next.closest('.grid')
  if (g) setRoving(g, next)
  return true
}

function bind() {
  // 设置是独立窗口：坞保持可见，改尺寸/主题能当场看到效果
  $('#btnSettings').addEventListener('click', () => api.openSettings())
  $('#list').addEventListener('keydown', (e) => { if (focusByArrow(e)) e.preventDefault() })
  // 一旦用鼠标，就收起方向键留下的焦点环
  document.addEventListener('pointerdown', () => setKbRing(null), true)
  $('#btnImport').addEventListener('click', importFlow)
  $('#btnAddCat').addEventListener('click', addCategoryFlow)
  $('#btnPin').addEventListener('click', async () => {
    const next = !state.settings.pinned
    state.settings.pinned = next
    applySettings()
    await api.pin(next)
    toast(next ? '已固定常显' : '已取消固定')
  })

  const searchbar = $('#searchbar')
  const searchInput = $('#searchInput')
  $('#btnSearch').addEventListener('click', () => {
    const show = searchbar.hidden
    searchbar.hidden = !show
    $('#btnSearch').classList.toggle('on', show)
    if (show) {
      searchInput.focus()
    } else {
      query = ''
      searchInput.value = ''
      render()
    }
  })
  /* 输入法组合期（拼拼音时）按 Esc 是取消候选词，不能当成"关闭"；
     同理组合中途的 input 事件带着拼音字母，实时过滤会把列表刷成空的 */
  const composing = (e) => e.isComposing || e.keyCode === 229

  let searching = false
  searchInput.addEventListener('compositionstart', () => { searching = true })
  searchInput.addEventListener('compositionend', () => {
    searching = false
    query = searchInput.value
    render()
  })
  searchInput.addEventListener('input', () => {
    if (searching) return
    query = searchInput.value
    render()
  })
  $('#btnSearchClose').addEventListener('click', () => {
    searchbar.hidden = true
    $('#btnSearch').classList.remove('on')
    query = ''
    searchInput.value = ''
    render()
  })

  /* 顶部标题栏：沿边拖动（拖到别的边会自动换方向吸附） */
  const header = $('#header')
  let dragging = false
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    api.dragEnd()
  }
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return
    dragging = true
    try { header.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    api.dragStart()
  })
  header.addEventListener('pointermove', () => { if (dragging) api.dragMove() })
  header.addEventListener('pointerup', () => endDrag())
  // 换边时窗口会改尺寸，pointer 事件偶尔会漏；这几种情况都要收尾，
  // 否则 dragState 一直挂着，鼠标一动就继续拽着坞跑
  header.addEventListener('pointercancel', () => endDrag())
  window.addEventListener('pointerup', () => endDrag())
  window.addEventListener('blur', () => endDrag())

  /* 从资源管理器拖文件进来 */
  const panel = $('#panel')
  panel.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  })
  panel.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return
    e.preventDefault()
    e.stopPropagation()
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    // 落到指针所在的分类，找不到就放第一个
    let catId = state.categories[0].id
    const sec = e.target.closest ? e.target.closest('.cat') : null
    if (sec) catId = sec.dataset.id
    const r = await api.addFiles(paths, catId)
    toast(`已添加 ${r.imported} 个快捷方式`, 'ok')
  })

  /* 传送带事件 */
  api.on('settings:changed', ({ settings }) => {
    // 主进程已落盘，渲染层只负责把值落到 DOM；不重绘列表，避免打断交互
    if (!settings) return
    state.settings = settings
    applySettings()
  })
  api.on('state:changed', (s) => {
    state = s
    applySettings()
    render()
  })
  api.on('dock:visibility', ({ visible }) => {
    document.body.classList.toggle('is-hidden', !visible)
  })
  api.on('dock:layout', (p) => {
    if (p && typeof p.cols === 'number' && p.cols !== state.cols) state.cols = p.cols
    // 拖拽换边时主进程只发 layout，不发完整状态，这里要把 edge 同步过来
    if (p && p.edge && p.edge !== state.settings.edge) state.settings.edge = p.edge
    applySettings()
  })
  api.on('ui:open-settings', () => api.openSettings())
  api.on('ui:toast', (t) => toast(t.text, t.type))
  api.on('ui:rename-item', async (id) => {
    const item = state.items.find((i) => i.id === id)
    if (!item) return
    const name = await askText('重命名快捷方式', item.name)
    if (!name) return
    const r = await api.renameItem(id, name)
    if (r && r.ok === false) toast(r.message || '重命名失败', 'err')
  })
  api.on('ui:rename-cat', async (id) => {
    const cat = state.categories.find((c) => c.id === id)
    if (!cat) return
    const name = await askText('重命名分类', cat.name)
    if (!name) return
    await api.renameCategory(id, name)
  })
  api.on('ui:color-cat', async (id) => {
    const cat = state.categories.find((c) => c.id === id)
    if (!cat) return
    const color = await pickColor('选择分类颜色', cat.color)
    if (!color) return
    await api.setCategoryColor(id, color)
  })

  document.addEventListener('keydown', (e) => {
    trapModalFocus(e)
    if (e.key === 'Escape') {
      if (composing(e)) return
      if (!$('#mask').hidden) return closeModal()
      if (!$('#searchbar').hidden) return $('#btnSearchClose').click()
      api.hide()
    }
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if ($('#searchbar').hidden) $('#btnSearch').click()
      else $('#searchInput').focus()
    }
  })

  /* 禁用默认右键菜单 */
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile') || e.target.closest('.cat-head')) return
    e.preventDefault()
  })
  document.addEventListener('dragstart', (e) => {
    if (!e.target.closest('.tile')) e.preventDefault()
  })
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  state = await api.getState()
  applySettings()
  document.body.classList.toggle('is-hidden', state.visible === false)
  bind()
  render()
}

boot()
