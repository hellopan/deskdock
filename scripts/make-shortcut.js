// 一次性脚本：创建桌面 / 开始菜单快捷方式（不依赖管理员权限与 COM）
const { app, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const target = 'D:\\00-Softwares\\DeskDock\\DeskDock.exe'

app.whenReady().then(() => {
  const desk = app.getPath('desktop')
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const opts = {
    target,
    cwd: path.dirname(target),
    icon: target,
    iconIndex: 0,
    description: '桌面坞 DeskDock',
    appUserModelId: 'com.pzb.deskdock'
  }
  for (const dir of [desk, startMenu]) {
    if (!fs.existsSync(dir)) continue
    const file = path.join(dir, '桌面坞.lnk')
    try {
      const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', opts)
      console.log(ok ? 'created' : 'failed', file)
    } catch (e) {
      console.log('error', file, e.message)
    }
  }
  app.quit()
})
