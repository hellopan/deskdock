'use strict'
/**
 * settings-shot.js — 开发期验证「独立设置窗口」
 *
 * 用真实数据跑一遍：打开设置 → 各页签截图 → 换主题 → 关掉设置，
 * 同时断言"设置开着时坞不收起 / 关掉后恢复自动隐藏"。
 *
 * 运行：npx electron scripts/settings-shot.js
 * 数据：先复制一份 DeskDockData 到 .test/data-settings，不碰真实配置
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
const outDir = path.join(root, '.preview')
const dataDir = path.join(root, '.test', 'data-settings')
const srcDir = path.join(root, 'DeskDockData')

fs.mkdirSync(outDir, { recursive: true })
if (!fs.existsSync(dataDir)) {
  fs.cpSync(srcDir, dataDir, { recursive: true })
}

process.env.DESKDOCK_DATA_DIR = dataDir
app.setPath('userData', path.join(root, '.test', 'ud-settings-shot'))

require('../src/main/main.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, name), img.toPNG())
  console.log('[shot]', name)
}

async function evalJs(win, code) {
  try { return await win.webContents.executeJavaScript(code) } catch (e) { return 'ERR ' + e.message }
}

app.whenReady().then(async () => {
  await sleep(2800)
  const dock = BrowserWindow.getAllWindows()[0]
  if (!dock) { console.log('FAIL: no dock window'); app.exit(1); return }

  console.log('dock bounds', JSON.stringify(dock.getBounds()))

  // 从坞的齿轮打开设置（和用户的实际路径一致）
  await evalJs(dock, "document.querySelector('#btnSettings').click(); true")
  await sleep(2000)

  const sw = BrowserWindow.getAllWindows().find((w) => w !== dock)
  if (!sw) { console.log('FAIL: no settings window'); app.exit(1); return }
  console.log('settings bounds', JSON.stringify(sw.getBounds()))
  console.log('settings title', await evalJs(sw, 'document.title'))
  console.log('settings tab', await evalJs(sw, "document.querySelector('#settingsTabs .tab.on')?.textContent"))
  console.log('viewport', await evalJs(sw, 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,docW:document.documentElement.scrollWidth,bodyW:document.body.scrollWidth})'))
  console.log('overflow', await evalJs(sw, `(()=>{const b=document.querySelector('.body');const w=document.querySelector('.wrap');return JSON.stringify({clientW:b.clientWidth,offsetW:b.offsetWidth,scrollW:b.scrollWidth,clientH:b.clientHeight,scrollH:b.scrollHeight,wrapW:w.offsetWidth,wrapRect:Math.round(w.getBoundingClientRect().right)})})()`))

  // 设置开着超过隐藏延时，坞仍应可见
  await sleep(1200)
  console.log('dock visible while settings open:', dock.isVisible(),
    '| body class:', await evalJs(dock, 'document.body.className'))

  await shot(sw, 'settings-look.png')

  for (const [tab, file] of [['行为', 'settings-act.png'], ['数据', 'settings-data.png'], ['关于', 'settings-about.png']]) {
    const ok = await evalJs(sw, `(()=>{const b=[...document.querySelectorAll('#settingsTabs .tab')].find(x=>x.textContent.trim()===${JSON.stringify(tab)}); if(!b) return false; b.click(); return true})()`)
    await sleep(450)
    console.log('tab', tab, ok)
    await shot(sw, file)
  }

  // 禁用态的行：滑块不能还是饱和蓝，否则看着"还能拖"
  await evalJs(sw, "(()=>{const b=[...document.querySelectorAll('#settingsTabs .tab')].find(x=>x.textContent.trim()==='行为'); b&&b.click(); return true})()")
  await sleep(300)
  // 滑块伪元素的色值读不出来（getComputedStyle 对 ::-webkit-slider-thumb 返回透明），
  // 这里只确认禁用行存在；颜色由 settings-act.png 取样核对
  const dis = JSON.parse(await evalJs(sw, `(() => {
    const rows = [...document.querySelectorAll('.row.is-disabled')]
    return JSON.stringify({ disabled: rows.length, opacity: rows[0] ? getComputedStyle(rows[0]).opacity : null })
  })()`))
  console.log('disabled rows', JSON.stringify(dis))

  // 换主题：窗口底色、坞、设置内容都要跟着变
  await evalJs(sw, "(()=>{const b=[...document.querySelectorAll('#settingsTabs .tab')].find(x=>x.textContent.trim()==='外观'); b&&b.click(); return true})()")
  await sleep(400)
  await evalJs(sw, "(()=>{const s=[...document.querySelectorAll('.seg button')].find(b=>b.textContent==='浅色'); s&&s.click(); return true})()")
  await sleep(1000)
  console.log('theme now:', await evalJs(sw, 'document.body.dataset.theme'))
  await shot(sw, 'settings-light.png')
  await shot(dock, 'dock-light.png')

  // 回深色
  await evalJs(sw, "(()=>{const s=[...document.querySelectorAll('.seg button')].find(b=>b.textContent==='深色'); s&&s.click(); return true})()")
  await sleep(800)

  // 核心体验：改「每排图标个数」，坞窗口宽度应立刻跟着变
  // 起点先固定成 10：副本里的 columns 可能被上一轮改成 4，那样"点 4 次减号"会被禁用态吃掉
  await evalJs(dock, "window.dock.updateSettings({ columns: 10 }).then(() => true)")
  await sleep(900)
  const before = dock.getBounds()
  await evalJs(sw, "(()=>{const row=[...document.querySelectorAll('.row')].find(r=>r.textContent.includes('每排图标个数'));const minus=row&&row.querySelectorAll('.step-btn')[0];for(let i=0;i<4&&minus;i++)minus.click();return true})()")
  await sleep(900)
  const after = dock.getBounds()
  const colsNow = await evalJs(dock, 'window.dock.getState().then(s => s.settings.columns)')
  console.log('dock width before/after cols->6:', before.width, after.width, '| columns now', colsNow,
    '| window count', BrowserWindow.getAllWindows().length)

  // 最小化设置：坞回到自动隐藏；还原后坞重新亮出来
  sw.minimize()
  await sleep(1400)
  console.log('dock class after minimize:', await evalJs(dock, 'document.body.className'))
  sw.restore()
  await sleep(1200)
  console.log('dock class after restore:', JSON.stringify(await evalJs(dock, 'document.body.className')))

  // 关掉设置：坞应恢复自动隐藏（光标不在坞上）
  await evalJs(sw, "document.querySelector('#btnClose').click(); true")
  await sleep(1400)
  console.log('settings window gone:', !BrowserWindow.getAllWindows().some((w) => w !== dock))
  console.log('dock body class after close:', await evalJs(dock, 'document.body.className'))

  // 再开一次：验证窗口未被复用成已销毁对象
  await evalJs(dock, "document.querySelector('#btnSettings').click(); true")
  await sleep(1800)
  const sw2 = BrowserWindow.getAllWindows().find((w) => w !== dock)
  console.log('reopen:', !!sw2, sw2 ? JSON.stringify(sw2.getBounds()) : '')
  if (sw2) await shot(sw2, 'settings-reopen.png')

  await sleep(300)
  console.log('done')
  app.exit(0)
})
