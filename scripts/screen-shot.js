// 用 Electron desktopCapturer 截取整个桌面（含贴边停靠的窗口）
const { app, desktopCapturer, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const out = process.env.SHOT_OUT || path.join(__dirname, '..', '.preview', 'screen.png')

app.whenReady().then(async () => {
  console.log("cursor=", JSON.stringify(screen.getCursorScreenPoint()))
  const all = screen.getAllDisplays()
  const maxW = Math.max(...all.map((x) => x.size.width * (x.scaleFactor || 1)))
  const maxH = Math.max(...all.map((x) => x.size.height * (x.scaleFactor || 1)))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(maxW), height: Math.round(maxH) }
  })
  if (!sources.length) {
    console.log('no source')
    app.quit()
    return
  }
  if (process.env.SHOT_ALL === '1') {
    sources.forEach((s, i) => {
      const f = out.replace(/\.png$/, `-d${i}.png`)
      fs.writeFileSync(f, s.thumbnail.toPNG())
      console.log('saved', f, s.name, 'display_id=' + s.display_id)
    })
    app.quit()
    return
  }
  const d = screen.getPrimaryDisplay()
  // 必须挑主屏对应的那个源，否则多显示器时会截到隔壁屏
  const target = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0]
  const png = target.thumbnail.toPNG()
  fs.writeFileSync(out, png)
  console.log('saved', out, target.name, 'display_id=' + target.display_id)
  app.quit()
})
