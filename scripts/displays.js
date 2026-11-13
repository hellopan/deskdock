'use strict'
// 调试用：打印当前显示器布局（DIP 坐标）
const { app, screen } = require('electron')

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  console.log('primaryId=' + primary.id)
  console.log(JSON.stringify(all.map((d) => ({
    id: d.id,
    label: d.label,
    scaleFactor: d.scaleFactor,
    bounds: d.bounds,
    workArea: d.workArea,
    primary: d.id === primary.id
  })), null, 2))
  app.quit()
})
