'use strict'

// Exercise user-visible outcomes of interrupted transitions with isolated data.
const { app, BrowserWindow, screen, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const data = path.join(root, '.test', 'data-motion')
fs.mkdirSync(data, { recursive: true })
fs.copyFileSync(path.join(root, 'DeskDockData', 'config.json'), path.join(data, 'config.json'))
if (!fs.existsSync(path.join(data, 'shortcuts'))) {
  fs.cpSync(path.join(root, 'DeskDockData', 'shortcuts'), path.join(data, 'shortcuts'), { recursive: true })
}
process.env.DESKDOCK_DATA_DIR = data
app.setPath('userData', path.join(root, '.test', 'ud-motion'))
require('../src/main/main.js')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(label, result) {
  console.log(`${result ? 'PASS' : 'FAIL'} ${label}`)
  if (!result) failures++
}
app.whenReady().then(async () => {
  await sleep(2400)
  const dock = BrowserWindow.getAllWindows()[0]
  const run = code => dock.webContents.executeJavaScript(code)
  await run(`document.querySelector('#btnAddCat').click(); true`)
  await sleep(400)
  check('Dialog opens and receives focus', await run(`!document.querySelector('#mask').hidden && !!document.activeElement.closest('#modal')`))
  await run(`(() => {
    document.querySelector('#modal .btn').click()
    document.querySelector('#btnAddCat').click()
  })()`)
  await sleep(400)
  check('Reopening during dismissal keeps the new dialog open', await run(`!document.querySelector('#mask').hidden && !!document.querySelector('#modal input')`))
  await run(`document.querySelector('#modal .btn').click(); true`)
  await sleep(300)
  check('Dismissal removes content and restores focus', await run(`document.querySelector('#mask').hidden && !document.querySelector('#modal').children.length && !document.activeElement.closest('#modal')`))

  const collapsed = await run(`(async () => {
    const section = document.querySelector('.cat')
    const toggle = section.querySelector('.cat-toggle')
    const before = section.classList.contains('collapsed')
    for (let i = 0; i < 3; i++) { toggle.click(); await new Promise(r => setTimeout(r, 35)) }
    await new Promise(r => setTimeout(r, 450))
    return section.classList.contains('collapsed') !== before &&
      toggle.getAttribute('aria-expanded') === String(before) &&
      section.getAnimations().length === 0 && !section.style.height
  })()`)
  check('Rapid category toggles settle to the last requested state', collapsed)

  await run(`window.dock.openSettings()`)
  await sleep(1400)
  const settings = BrowserWindow.getAllWindows().find(w => w !== dock)
  const settingRun = code => settings.webContents.executeJavaScript(code)
  check('Settings default height is 920 within the available display', Math.abs(settings.getBounds().height - Math.min(920, Math.max(420, screen.getDisplayMatching(settings.getBounds()).workArea.height - 96))) <= 2)
  const dockRadius = await run(`getComputedStyle(document.querySelector('#panel')).borderTopLeftRadius`)
  check('Settings and dock share all four corner radii', await settingRun(`(() => {
    const css = getComputedStyle(document.querySelector('.win'))
    return ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(key => css[key] === ${JSON.stringify(dockRadius)})
  })()`) && settings._cornerRadius === parseFloat(dockRadius))
  await settingRun(`document.querySelector('[data-tab="about"]').click(); true`)
  const originalOpenExternal = shell.openExternal
  let openedURL = ''
  shell.openExternal = async url => { openedURL = url }
  await settingRun(`document.querySelector('.about-link').click(); true`)
  await sleep(100)
  shell.openExternal = originalOpenExternal
  check('About page opens the project repository in the system browser', openedURL === 'https://github.com/hellopan/deskdock')
  await settingRun(`document.querySelector('[data-tab="look"]').click(); true`)
  check('Settings are owned by the dock and remain in its topmost layer', settings.getParentWindow() === dock && settings.isAlwaysOnTop())
  check('Tabs sit vertically to the left of the settings content', await settingRun(`(() => {
    const bar = document.querySelector('.tabs')
    const tabs = [...bar.querySelectorAll('.tab')]
    return bar.getAttribute('aria-orientation') === 'vertical' && tabs.length === 4 &&
      bar.getBoundingClientRect().right <= document.querySelector('.body').getBoundingClientRect().left &&
      tabs.every((tab, i) => !i || tab.getBoundingClientRect().top >= tabs[i - 1].getBoundingClientRect().bottom)
  })()`))
  check('Settings content has no duplicate page title', await settingRun(`!document.querySelector('.page-heading, .page-title, #settingsBody h1')`))
  const initialLayout = await run(`window.dock.getState().then(s => ({ edge: s.settings.edge, columns: s.settings.columns, tileSize: s.settings.tileSize }))`)
  await run(`window.dock.updateSettings({ edge: 'left', columns: 19, tileSize: 60 })`)
  await sleep(300)
  check('Column stepper reaches 20 and disables further increases', await settingRun(`(() => {
    const row = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('每排图标个数'))
    const plus = row.querySelectorAll('.step-btn')[1]
    plus.click()
    plus.click()
    return row.querySelector('.step-val').textContent === '20' && plus.disabled
  })()`))
  await sleep(350)
  const twenty = await run(`window.dock.getState().then(s => ({ configured: s.settings.columns, actual: s.cols }))`)
  const availableWidth = screen.getDisplayMatching(dock.getBounds()).workArea.width
  let expectedColumns = 20
  while (expectedColumns > 1 && 32 + expectedColumns * 60 + (expectedColumns - 1) * 6 > availableWidth - 60) expectedColumns--
  check('Dock renders up to 20 columns within the available screen width', twenty.configured === 20 && twenty.actual === expectedColumns)
  const store = require('../src/main/store')
  store.load()
  check('20 columns survive configuration reload', store.get().settings.columns === 20)
  fs.mkdirSync(path.join(root, '.preview'), { recursive: true })
  fs.writeFileSync(path.join(root, '.preview', 'settings-1.4.6.png'), (await settings.webContents.capturePage()).toPNG())
  await run(`window.dock.updateSettings(${JSON.stringify(initialLayout)})`)
  await sleep(200)
  const tabs = await settingRun(`(async () => {
    const first = document.querySelector('.tab')
    for (const id of ['act', 'data', 'about', 'look']) {
      document.querySelector('[data-tab="' + id + '"]').click()
      await new Promise(r => setTimeout(r, 25))
    }
    await new Promise(r => setTimeout(r, 450))
    const bar = document.querySelector('.tabs')
    const selected = bar.querySelector('[aria-selected="true"]')
    return first === document.querySelector('.tab') && selected.dataset.tab === 'look' &&
      document.querySelector('#settingsBody').getAttribute('aria-labelledby') === 'tab-look' && !!document.querySelector('.preview') &&
      Math.abs(parseFloat(bar.style.getPropertyValue('--selection-x')) - selected.offsetLeft) < 1 &&
      Math.abs(parseFloat(bar.style.getPropertyValue('--selection-y')) - selected.offsetTop) < 1 &&
      document.querySelectorAll('.tab[tabindex="0"]').length === 1
  })()`)
  check('Rapid tab switches retain controls, selection and matching content', tabs)
  check('Keyboard tab navigation updates content and focus', await settingRun(`(() => {
    const bar = document.querySelector('.tabs')
    bar.querySelector('.on').focus()
    bar.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}))
    return document.activeElement.dataset.tab === 'act' && document.querySelector('#settingsBody').getAttribute('aria-labelledby') === 'tab-act' && !!document.querySelector('input[aria-label="坞的高度"]')
  })()`))
  check('Settings contain no explanatory text blocks', await settingRun(`!document.querySelector('.rdesc, .rnote, .page-subtitle, .preview-note, .tips')`))
  await settingRun(`(() => {
    const height = document.querySelector('input[aria-label="坞的高度"]')
    height.value = '940'
    height.dispatchEvent(new Event('change'))
  })()`)
  for (const edge of ['left', 'top', 'bottom', 'right']) {
    await run(`window.dock.updateSettings({ edge: '${edge}' })`)
    await sleep(350)
    const bounds = dock.getBounds()
    const expected = Math.min(940, screen.getDisplayMatching(bounds).workArea.height - 40)
    check(`Custom height applies when docked ${edge}`, await run(`Math.abs(document.querySelector('#panel').getBoundingClientRect().height - ${expected}) <= 2`))
  }
  settings.setSize(600, 440)
  await sleep(300)
  check('Minimum settings size has no horizontal overflow', await settingRun(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.body').scrollWidth <= document.querySelector('.body').clientWidth`))

  dock.webContents.debugger.attach('1.3')
  await dock.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  check('Reduced motion dismisses without waiting for animation', await run(`(() => {
    document.querySelector('#btnAddCat').click()
    document.querySelector('#modal .btn').click()
    return matchMedia('(prefers-reduced-motion: reduce)').matches && document.querySelector('#mask').hidden
  })()`))
  dock.webContents.debugger.detach()
  console.log(failures ? `${failures} failures` : 'All motion checks passed')
  app.exit(failures ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })
