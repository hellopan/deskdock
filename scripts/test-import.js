/**
 * 临时验证脚本：验证"导入时保留原分类"的逻辑（跑在 electron 主进程里）
 *   DESKDOCK_DATA_DIR=<临时目录> npx electron scripts/test-import.js
 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DATA = process.env.DESKDOCK_DATA_DIR
const SRC = process.env.TEST_LNK_DIR // 一批真实 .lnk 的目录
const DESK = process.env.TEST_DESKTOP // 模拟"桌面"

function log(...a) { process.stdout.write(a.join(' ') + '\n') }

app.whenReady().then(async () => {
  const store = require('../src/main/store')
  store.load()
  const cats = store.get().categories
  const inbox = cats.find((c) => c.name.includes('未分类')) || cats[0]
  const group = store.addCategory('测试组')

  const files = fs.readdirSync(DESK).filter((f) => /\.(lnk|url)$/i.test(f)).slice(0, 3)
  const paths = files.map((f) => path.join(DESK, f))
  log('测试文件:', files.join(' | '))

  // 1) 首次导入到"测试组"
  let r = await store.importFromDesktop(paths, group.id, false, true)
  log('① 首次导入 → imported=%d kept=%d', r.imported, r.kept)
  const firstIds = r.items.slice()

  // 2) 再次导入，分类选"未分类"，但仍应保留"测试组"
  r = await store.importFromDesktop(paths, inbox.id, false, true)
  const after = store.get().items.filter((it) => firstIds.includes(it.id))
  log('② 重复导入(保留原分类) → imported=%d kept=%d；条目仍在新分类里的数量=%d',
    r.imported, r.kept, after.filter((it) => it.categoryId === group.id).length)
  log('   条目总数=%d（应仍为 %d）', store.get().items.length, firstIds.length)

  // 3) 模拟文件丢失，再导入一次 → 应补回且分类不变
  const lose = after[0]
  fs.unlinkSync(store.absolute(lose.file))
  r = await store.importFromDesktop([path.join(DESK, files[0])], inbox.id, false, true)
  const fixed = store.get().items.find((it) => it.id === lose.id)
  log('③ 文件丢失后导入 → kept=%d repaired=%d；missing=%s；分类仍是测试组=%s',
    r.kept, r.repaired, fixed.missing, fixed.categoryId === group.id)

  // 4) 关闭"保留原分类" → 应新增重复条目
  const before = store.get().items.length
  r = await store.importFromDesktop([paths[0]], inbox.id, false, false)
  log('④ 关闭保留原分类 → imported=%d；条目数 %d → %d', r.imported, before, store.get().items.length)

  log('DONE')
  app.exit(0)
})
