'use strict'
/* settings.js — 独立设置窗口
 *
 * 以前设置是坞面板里的一个覆盖层，一打开就把坞盖住，
 * 调尺寸、主题、列数时看不到坞，只能关掉设置再瞄一眼。
 * 现在它是自己的窗口：坞留在原地，改一下当场看到变化。
 *
 * 控件一律"建一次、只改值"：每个控件把自己的同步函数塞进 bindings，
 * 设置变化时只把新值写回控件，不重建 DOM，也不打断正在拖的滑杆。
 */

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const api = window.dock

let state = null
let bindings = []
let settingsTab = 'look'
const tabScroll = new Map()

/* ------------------------------------------------------------ 小工具 */

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

let modalPrevFocus = null

function closeModal() {
  $('#mask').hidden = true
  $('#modal').innerHTML = ''
  if (modalPrevFocus && modalPrevFocus.isConnected) modalPrevFocus.focus({ preventScroll: true })
  modalPrevFocus = null
}

function openModal(build) {
  const modal = $('#modal')
  modal.innerHTML = ''
  modalPrevFocus = document.activeElement
  const mask = $('#mask')
  mask.hidden = false
  mask.onclick = (e) => { if (e.target === mask) closeModal() }
  build(modal)
  const head = modal.querySelector('.modal-head')
  modal.setAttribute('aria-label', head ? head.textContent : '对话框')
  const first = modal.querySelector('input:not([type="hidden"]), button, [tabindex]')
  if (first) first.focus({ preventScroll: true })
}

/** Tab 在弹窗内循环，不跑到背后的设置项上 */
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

function confirmBox(title, text, okText) {
  return new Promise((resolve) => {
    openModal((m) => {
      m.appendChild(el('div', 'modal-head', title))
      const body = el('div', 'modal-body')
      body.appendChild(el('div', '', text))
      m.appendChild(body)
      const foot = el('div', 'modal-foot')
      const cancel = el('button', 'btn', '取消')
      const ok = el('button', 'btn primary', okText || '确定')
      cancel.addEventListener('click', () => { closeModal(); resolve(false) })
      ok.addEventListener('click', () => { closeModal(); resolve(true) })
      foot.append(cancel, ok)
      m.appendChild(foot)
    })
  })
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pickBackup(list, cb) {
  openModal((m) => {
    m.appendChild(el('div', 'modal-head', '选择要恢复的备份'))
    const body = el('div', 'modal-body')
    const box = el('div', 'backup-list')
    list.slice(0, 20).forEach((b) => {
      const item = el('button', 'backup-item', `${fmtTime(b.at)} · ${(b.size / 1024).toFixed(1)} KB`)
      item.addEventListener('click', () => { closeModal(); cb(b.file) })
      box.appendChild(item)
    })
    body.appendChild(box)
    m.appendChild(body)
    const foot = el('div', 'modal-foot')
    const cancel = el('button', 'btn', '取消')
    cancel.addEventListener('click', closeModal)
    foot.appendChild(cancel)
    m.appendChild(foot)
  })
}

/* --------------------------------------------------------- 主题与变量 */

let lastChrome = ''

function applySettings() {
  if (!state || !state.settings) return
  const s = state.settings
  const theme = s.theme === 'light' ? 'light' : 'dark'
  document.body.dataset.theme = theme
  document.body.classList.toggle('no-label', s.showLabels === false)
  document.documentElement.style.setProperty('--icon', (s.iconSize || 44) + 'px')
  document.documentElement.style.setProperty('--tile', (s.tileSize || 74) + 'px')
  // 窗口底色跟着主题走，缩放时不会闪一下白底
  if (theme !== lastChrome) {
    lastChrome = theme
    api.setChrome(theme)
  }
}

/* --------------------------------------------------------- 控件工厂 */

function row(label, desc) {
  const r = el('div', 'row')
  const box = el('div', 'rtext')
  box.appendChild(el('div', 'rlabel', label))
  if (desc) box.appendChild(el('div', 'rdesc', desc))
  r.appendChild(box)
  return r
}

function switchRow(label, desc, checked, onChange, key) {
  const r = row(label, desc)
  const sw = el('label', 'switch')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = !!checked
  const track = el('span', 'track')
  const knob = el('span', 'knob')
  sw.append(input, track, knob)
  input.addEventListener('change', () => onChange(input.checked))
  r.appendChild(sw)
  r._input = input
  if (key) bindings.push((s) => { input.checked = !!s[key] })
  return r
}

function rangeRow(label, min, max, step, value, fmt, onChange, key) {
  const wrap = el('div', 'row col')
  const top = el('div', 'row row-flat')
  const lb = el('div', 'rlabel', label)
  const val = el('div', 'range-val', fmt(value))
  top.append(lb, val)
  const input = document.createElement('input')
  input.type = 'range'
  input.min = min
  input.max = max
  input.step = step
  input.value = value
  input.addEventListener('input', () => { val.textContent = fmt(Number(input.value)) })
  input.addEventListener('change', () => onChange(Number(input.value)))
  wrap.append(top, input)
  wrap._input = input
  wrap._val = val
  if (key) {
    bindings.push((s) => {
      const v = Number(s[key]) || 0
      input.value = v
      val.textContent = fmt(v)
    })
  }
  return wrap
}

/** 步进器：像"每排几个"这种每步都有可见后果的数值，比滑杆更好按 */
function stepperRow(label, desc, min, max, value, onChange, key) {
  const r = row(label, desc)
  const box = el('div', 'stepper')
  const minus = el('button', 'step-btn', '−')
  const num = el('span', 'step-val', String(value))
  const plus = el('button', 'step-btn', '+')
  minus.type = 'button'
  plus.type = 'button'
  minus.title = '减少一个'
  plus.title = '增加一个'
  minus.setAttribute('aria-label', '减少一个')
  plus.setAttribute('aria-label', '增加一个')
  num.setAttribute('aria-live', 'polite')

  const commit = (next) => {
    const v = Math.max(min, Math.min(max, next))
    num.textContent = String(v)
    minus.disabled = v <= min
    plus.disabled = v >= max
    onChange(v)
  }
  minus.addEventListener('click', () => commit(Number(num.textContent) - 1))
  plus.addEventListener('click', () => commit(Number(num.textContent) + 1))

  minus.disabled = value <= min
  plus.disabled = value >= max
  box.append(minus, num, plus)
  r.appendChild(box)
  // 整行被置灰后重新启用时，加减按钮的边界态要按当前值重算
  r._paint = (v) => {
    const n = Math.max(min, Math.min(max, Number(v) || value))
    num.textContent = String(n)
    minus.disabled = n <= min
    plus.disabled = n >= max
  }
  if (key) {
    bindings.push((s) => {
      const v = Math.max(min, Math.min(max, Number(s[key]) || value))
      num.textContent = String(v)
      minus.disabled = v <= min
      plus.disabled = v >= max
    })
  }
  return r
}

/** 置灰/恢复一行，并可附一句"为什么现在不能用"；说明只建一次，避免重复叠加 */
function setRowDisabled(r, disabled, note) {
  r.classList.toggle('is-disabled', disabled)
  r.querySelectorAll('button, input').forEach((n) => { n.disabled = disabled })
  let n = r.querySelector('.rnote')
  if (disabled && note) {
    if (!n) {
      n = el('div', 'rnote')
      const box = r.querySelector('.rtext')
      if (box) box.appendChild(n)
      else r.appendChild(n)
    }
    n.textContent = note
  } else if (n) {
    n.remove()
  }
  return r
}

function segRow(label, options, value, onChange, key) {
  const r = row(label)
  const seg = el('div', 'seg')
  const btns = []
  for (const opt of options) {
    const b = el('button', opt.value === value ? 'on' : '', opt.label)
    b.type = 'button'
    b.addEventListener('click', () => {
      btns.forEach((c) => c.classList.toggle('on', c === b))
      onChange(opt.value)
    })
    btns.push(b)
    seg.appendChild(b)
  }
  r.appendChild(seg)
  if (key) {
    bindings.push((s) => {
      btns.forEach((b, i) => b.classList.toggle('on', options[i].value === s[key]))
    })
  }
  return r
}

function group(title) {
  const g = el('div', 'group')
  g.appendChild(el('div', 'group-title', title))
  return g
}

/* --------------------------------------------------------- 页签框架 */
/* 四个页签：设置项按"改了会立刻看到什么"分组，而不是按代码里的模块顺序堆成一页长滚动。 */

const TABS = [
  { id: 'look', label: '外观', build: buildLookTab },
  { id: 'act', label: '行为', build: buildActionTab },
  { id: 'data', label: '数据', build: buildDataTab },
  { id: 'about', label: '关于', build: buildAboutTab }
]

function renderTabs() {
  const bar = $('#settingsTabs')
  bar.innerHTML = ''
  for (const t of TABS) {
    const active = t.id === settingsTab
    const b = el('button', 'tab' + (active ? ' on' : ''), t.label)
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(active))
    // 只有当前页签在 Tab 序列里，其余靠左右方向键切换（WAI-ARIA 的 tabs 模式）
    b.tabIndex = active ? 0 : -1
    b.addEventListener('click', () => switchTab(t.id))
    bar.appendChild(b)
  }
}

/** ←/→/Home/End 切页签；切完把焦点交给新的选中项（重建了按钮，必须重新聚焦） */
function onTabsKeydown(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
  e.preventDefault()
  const i = TABS.findIndex((t) => t.id === settingsTab)
  let next = i
  if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length
  else if (e.key === 'ArrowRight') next = (i + 1) % TABS.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = TABS.length - 1
  switchTab(TABS[next].id)
  const on = $('#settingsTabs .tab.on')
  if (on) on.focus({ preventScroll: true })
}

function switchTab(id) {
  if (id === settingsTab) return
  tabScroll.set(settingsTab, $('#settingsBody').scrollTop)
  settingsTab = id
  renderTabs()
  renderTab()
}

function renderTab() {
  const body = $('#settingsBody')
  body.innerHTML = ''
  bindings = []     // 每次重建都重新登记，旧控件的同步函数不再调用
  const wrap = el('div', 'wrap')
  const tab = TABS.find((t) => t.id === settingsTab) || TABS[0]
  tab.build(wrap)
  body.appendChild(wrap)
  body.scrollTop = tabScroll.get(tab.id) || 0
}

/** 只同步值，不重建控件（重建会打断正在拖的滑杆、丢键盘焦点） */
function syncControls() {
  if (!state || !state.settings) return
  for (const fn of bindings) {
    if (!fn) continue
    try { fn(state.settings) } catch { /* 控件已随切页销毁 */ }
  }
}

async function refreshState() {
  state = await api.getState()
  applySettings()
  renderTab()
}

const fmtPx = (v) => v + 'px'
const fmtMs = (v) => v + 'ms'
const fmtCd = (v) => (Number(v) > 0 ? (Number(v) / 1000).toFixed(2).replace(/\.?0+$/, '') + 's' : '关闭')
let lastCooldown = 2000

/* ---------------------------------------------- 页签：外观 */
function buildLookTab(body) {
  const s = state.settings
  const vertical = s.edge === 'left' || s.edge === 'right'

  const g = group('尺寸与外观')
  g.appendChild(segRow('主题', [
    { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }
  ], s.theme, (v) => api.updateSettings({ theme: v }), 'theme'))
  g.appendChild(rangeRow('图标大小', 32, 64, 2, s.iconSize, fmtPx, (v) => api.updateSettings({ iconSize: v }), 'iconSize'))
  g.appendChild(rangeRow('磁贴宽度', 60, 104, 2, s.tileSize, fmtPx, (v) => api.updateSettings({ tileSize: v }), 'tileSize'))
  const colsRow = stepperRow('每排图标个数', vertical ? '决定坞的宽度，改完立即生效' : '贴上/下边时按屏幕宽度自动排列', 4, 10, s.columns || 6, (v) => {
    state.settings.columns = v
    api.updateSettings({ columns: v })
  }, 'columns')
  g.appendChild(colsRow)
  g.appendChild(switchRow('显示名称', '关闭后只显示图标', s.showLabels !== false, (v) => api.updateSettings({ showLabels: v }), 'showLabels'))
  body.appendChild(g)

  // 换边后"每排个数"的可用性跟着变；只改禁用态，不重建整页（不打断焦点）
  const syncCols = (st) => {
    const v = st.edge === 'left' || st.edge === 'right'
    setRowDisabled(colsRow, !v, '当前贴上/下边，每排个数由屏幕宽度决定')
    if (v && colsRow._paint) colsRow._paint(st.columns)
  }
  syncCols(s)
  bindings.push(syncCols)

  body.appendChild(previewBlock())
  body.appendChild(cooldownBlock(s))
}

/** 预览：滑块改了尺寸后能当场看到，不必关掉设置再瞄一眼 */
const PV_GLYPH = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="3.4" ry="8"/>' +
    '<path d="M4.4 9.4h15.2M4.4 14.6h15.2"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.6"/><path d="M7 9.4l2.6 2.6L7 14.6M12.4 15h4.4"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 20l1.2-4.6L16.4 4.2a2 2 0 012.8 0l.6.6a2 2 0 010 2.8L8.6 18.8 4 20z"/>' +
    '<path d="M14.8 5.8l3.4 3.4"/></svg>'
}

/* 预览用真实磁贴的骨架：图标板 + 两行名称。
   以前是"首字 + 纯色块"，跟坞里长得不像，改了尺寸也看不出效果。 */
function previewBlock() {
  const g = group('预览')
  const box = el('div', 'preview')
  for (const [color, name, glyph] of [
    ['#3B82F6', '浏览器', 'globe'],
    ['#12A150', '终端', 'terminal'],
    ['#8B5CF6', '设计工具', 'pen']
  ]) {
    const t = el('div', 'pv-tile')
    const ico = el('div', 'pv-ico')
    ico.style.color = color
    ico.innerHTML = PV_GLYPH[glyph]
    t.append(ico, el('div', 'pv-label', name))
    box.appendChild(t)
  }
  g.appendChild(box)
  g.appendChild(el('div', 'preview-note', '改上面的尺寸，坞会立刻跟着变；把鼠标移到图标上能看到悬停态'))
  return g
}

/** 冷却：开关 + 时长，关掉时滑杆置灰（原来是"0 = 关闭"的滑杆，不好发现） */
function cooldownBlock(s) {
  const on = Number(s.cooldownMs) > 0
  if (on) lastCooldown = Number(s.cooldownMs)

  const g = group('点击冷却')
  let range = null
  let sw = null

  // 开关和滑杆共用一份落值逻辑：先本地立即反馈，等服务端回包再校正
  const apply = (v) => {
    const enabled = v > 0
    if (enabled) lastCooldown = v
    range._input.value = enabled ? v : lastCooldown
    range._val.textContent = fmtCd(range._input.value)
    sw._input.checked = enabled
    setRowDisabled(range, !enabled, '冷却已关闭')
  }

  range = rangeRow('冷却时长', 500, 5000, 250, lastCooldown, fmtCd, (v) => {
    lastCooldown = v
    api.updateSettings({ cooldownMs: v })
  })
  sw = switchRow('开启冷却', '刚点开的程序，短时间内再点不会重复启动', on, (v) => {
    apply(v ? (lastCooldown || 2000) : 0)
    api.updateSettings({ cooldownMs: v ? (lastCooldown || 2000) : 0 })
  })
  g.append(sw, range)
  apply(on ? Number(s.cooldownMs) : 0)

  bindings.push((st) => apply(Number(st.cooldownMs) || 0))
  return g
}

/* ---------------------------------------------- 页签：行为 */
function buildActionTab(body) {
  const s = state.settings
  const vertical = s.edge === 'left' || s.edge === 'right'

  const g = group('贴边与尺寸')
  g.appendChild(segRow('贴边位置', [
    { value: 'left', label: '左' }, { value: 'right', label: '右' },
    { value: 'top', label: '上' }, { value: 'bottom', label: '下' }
  ], s.edge, (v) => api.updateSettings({ edge: v }), 'edge'))
  const thickRow = rangeRow('坞的高度', 220, 460, 10, s.thickness, fmtPx, (v) => api.updateSettings({ thickness: v }), 'thickness')
  g.appendChild(thickRow)
  const syncThick = (st) => {
    const v = st.edge === 'left' || st.edge === 'right'
    setRowDisabled(thickRow, v, '当前贴左/右边，宽度由「每排图标个数」决定')
  }
  syncThick(s)
  bindings.push(syncThick)
  body.appendChild(g)

  const g2 = group('显示与隐藏')
  const delayRow = rangeRow('隐藏延时', 200, 2000, 50, s.hideDelay, fmtMs, (v) => api.updateSettings({ hideDelay: v }), 'hideDelay')
  const hideSwitch = switchRow('自动隐藏', '鼠标离开后收起，只留一条感应条', s.autoHide, (v) => {
    api.updateSettings({ autoHide: v })
  }, 'autoHide')
  g2.appendChild(switchRow('固定常显', '开启后不再自动隐藏', s.pinned, (v) => {
    state.settings.pinned = v
    api.pin(v)
  }, 'pinned'))
  g2.appendChild(hideSwitch)
  g2.appendChild(delayRow)
  const syncDelay = (st) => setRowDisabled(delayRow, !st.autoHide, '自动隐藏已关闭')
  syncDelay(s)
  bindings.push(syncDelay)
  body.appendChild(g2)

  const g3 = group('启动')
  const supported = !!(state.login && state.login.supported)
  const loginRow = switchRow('开机自启', '登录 Windows 后自动在后台待命', s.launchAtLogin, async (v) => {
    const r = await api.setLogin(v)
    if (!r.ok) {
      loginRow._input.checked = !v
      toast(r.message || '设置失败', 'err')
    } else {
      state.settings.launchAtLogin = v
      toast(v ? '已开启开机自启' : '已关闭开机自启', 'ok')
    }
  }, 'launchAtLogin')
  // 说明写"是什么"，禁用原因只写在 note 里 —— 两处都讲开发模式会重复
  if (!supported) setRowDisabled(loginRow, true, '开发模式下不可用，安装版才生效')
  g3.appendChild(loginRow)
  body.appendChild(g3)
}

/* ---------------------------------------------- 页签：数据 */
function buildDataTab(body) {
  const g = group('数据目录')
  g.appendChild(row('存储位置', '配置和快捷方式副本都存在这里；重装、覆盖升级、卸载都不会动它'))
  g.appendChild(el('div', 'path-text', state.dataDir))
  const btns = el('div', 'row row-actions')
  btns.append(
    actionBtn('打开数据目录', () => api.openDataDir()),
    actionBtn('快捷方式文件夹', () => api.openShortcutsDir()),
    actionBtn('备份文件夹', () => api.openBackupDir())
  )
  g.appendChild(btns)
  body.appendChild(g)

  const g2 = group('备份与修复')
  g2.appendChild(row('自动备份', '每次改动前自动留一份配置快照（最多 40 份）'))
  const acts = el('div', 'row row-actions')
  acts.append(
    actionBtn('立即备份', async () => {
      const r = await api.backupData()
      toast(r.ok ? '已备份当前配置' : '备份失败', r.ok ? 'ok' : 'err')
    }),
    actionBtn('从备份恢复', async () => {
      const list = await api.listBackups()
      if (!list.length) return toast('还没有可用的备份', 'err')
      pickBackup(list, async (file) => {
        const r = await api.restoreBackup(file)
        if (r.ok) {
          toast(`已恢复：${r.items} 个快捷方式 / ${r.categories} 个分类`, 'ok')
          refreshState()
        } else {
          toast(r.message || '恢复失败', 'err')
        }
      })
    }),
    actionBtn('修复失效项', async () => {
      const r = await api.repairMissing()
      if (!r.total) return toast('没有失效的快捷方式', 'ok')
      toast(`修复 ${r.repaired} 个，仍有 ${r.unrepaired} 个无法自动修复`, r.unrepaired ? 'err' : 'ok')
      refreshState()
    })
  )
  g2.appendChild(acts)
  if (state.missingCount > 0) {
    g2.appendChild(el('div', 'warn-text', `当前有 ${state.missingCount} 个快捷方式指向的文件不存在，点「修复失效项」可以按原路径重建。`))
  }
  body.appendChild(g2)

  const g3 = group('危险区')
  g3.appendChild(row('清空坞', `会把这 ${state.items.length} 个快捷方式复制回桌面，然后清空坞里的条目；之后可以从桌面重新导入`))
  const danger = el('button', 'btn danger sm mt-2', '把所有快捷方式放回桌面')
  danger.type = 'button'
  danger.addEventListener('click', async () => {
    const ok = await confirmBox('确认放回桌面？', `会把这 ${state.items.length} 个快捷方式复制回桌面，并清空坞里的条目。之后可以从桌面重新导入。`)
    if (!ok) return
    const r = await api.restoreAll()
    toast(`已放回桌面 ${r.count} 个`, 'ok')
    refreshState()
  })
  g3.appendChild(danger)
  body.appendChild(g3)
}

function actionBtn(label, fn) {
  const b = el('button', 'btn sm', label)
  b.type = 'button'
  b.addEventListener('click', fn)
  return b
}

/* ---------------------------------------------- 页签：关于 */
function buildAboutTab(body) {
  const g = group('关于')
  g.appendChild(el('div', 'about-name', '桌面坞 DeskDock'))
  g.appendChild(el('div', 'about-meta', `版本 ${state.appVersion}${state.isPackaged ? '' : ' · 开发模式'}`))
  body.appendChild(g)

  const g2 = group('操作提示')
  const tips = el('div', 'tips')
  for (const [k, v] of [
    ['呼出', '鼠标滑到屏幕边缘停一下，坞会自动出现'],
    ['换边', '拖动坞顶部的标题栏到另一条边，松手即吸附'],
    ['分类', '点标题折叠/展开；拖分类行右侧的握把（或右键 → 上移/下移）可调整顺序'],
    ['搜索', 'Ctrl+F 直接搜；Esc 逐层退出搜索、坞'],
    ['设置', '这个窗口开着时坞会保持展开，关掉后恢复自动隐藏']
  ]) {
    const tip = el('div', 'tip')
    tip.append(el('span', 'tip-k', k), el('span', 'tip-v', v))
    tips.appendChild(tip)
  }
  g2.appendChild(tips)
  body.appendChild(g2)

  const quit = el('button', 'btn sm mt-2', '退出桌面坞')
  quit.type = 'button'
  quit.addEventListener('click', () => api.quit())
  body.appendChild(quit)
}

/* ------------------------------------------------------------- 事件 */

function bind() {
  $('#btnMin').addEventListener('click', () => api.minimizeWindow())
  $('#btnClose').addEventListener('click', () => api.closeSettings())
  $('#settingsTabs').addEventListener('keydown', onTabsKeydown)

  document.addEventListener('keydown', (e) => {
    trapModalFocus(e)
    if (e.key !== 'Escape') return
    // 组合期按 Esc 是取消候选词，不能把整个设置窗口关掉
    if (e.isComposing || e.keyCode === 229) return
    if (!$('#mask').hidden) return closeModal()
    api.closeSettings()
  })

  // 设置窗口里不需要网页默认的右键菜单
  document.addEventListener('contextmenu', (e) => {
    if (e.target.tagName !== 'INPUT') e.preventDefault()
  })

  api.on('settings:changed', ({ settings }) => {
    if (!settings) return
    state.settings = settings
    applySettings()
    // 不重建控件：重建会把正在拖的滑杆和键盘焦点冲掉
    syncControls()
  })

  api.on('state:changed', (s) => {
    state = s
    applySettings()
    // 数据页展示数量与路径，直接重建；其余页只写值，别冲掉正在拖的滑杆
    if (settingsTab === 'data') renderTab()
    else syncControls()
  })

  api.on('settings:tab', (id) => {
    if (!id || id === settingsTab) return
    tabScroll.set(settingsTab, $('#settingsBody').scrollTop)
    settingsTab = id
    renderTabs()
    renderTab()
  })
}

async function boot() {
  state = await api.getState()
  applySettings()
  bind()
  renderTabs()
  renderTab()
  const on = $('#settingsTabs .tab.on')
  if (on) on.focus({ preventScroll: true })
}

boot()
