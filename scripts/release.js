#!/usr/bin/env node
/**
 * 把 dist/ 里已经打包好的安装包发布到 GitHub Releases。
 *
 *   node scripts/release.js                发布当前版本（正式版）
 *   node scripts/release.js --draft        发成草稿，人工确认后再一键公开
 *   node scripts/release.js --dry-run      只打印计划，不联网写任何数据
 *   node scripts/release.js --notes "..."  自定义发布说明
 *   node scripts/release.js --clobber      同名附件已存在时删掉重传
 *   node scripts/release.js --prune        顺带清掉不在本次清单里的旧附件
 *
 * 凭据顺序：GH_TOKEN / GITHUB_TOKEN 环境变量 → 本机 git 已登录的凭据。
 * 仓库地址从 git remote origin 解析，不写死。
 */

const https = require('https')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const VERSION = pkg.version
const PRODUCT =
  (pkg.build && pkg.build.productName) || pkg.productName || pkg.name
const DIST = path.join(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

const DRY = has('--dry-run')
const DRAFT = has('--draft')
const CLOBBER = has('--clobber')
const PRUNE = has('--prune')
const TAG = valOf('--tag') || `v${VERSION}`
const NOTES_ARG = valOf('--notes')

/* ---------- 基础工具 ---------- */

function run(cmd, args, input) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function getRepo() {
  const url = run('git', ['remote', 'get-url', 'origin'])
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (!m) throw new Error(`无法从 origin 解析仓库：${url || '(空)'}`)
  return { owner: m[1], repo: m[2] }
}

function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const out = run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')
  const m = out.match(/^password=(.*)$/m)
  if (!m) {
    throw new Error(
      '未找到 GitHub 凭据。请设置 GH_TOKEN 环境变量，或先执行一次 git push 让凭据管理器记住登录状态。'
    )
  }
  return m[1].trim()
}

const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`

/* ---------- 清单 ---------- */

// GitHub 不接受附件名里的空格（会被转成点号），产物名统一用下划线。
const safeName = (n) => n.replace(/ /g, '_')

// 产物名以 package.json 的 artifactName 模板为准（默认 ${productName}_Setup_${version}.${ext}），
// 改模板不用动脚本；万一没配或没对上，再退回扫描 dist 目录。
function artifactName() {
  const b = pkg.build || {}
  const tpl = (b.win && b.win.artifactName) || b.artifactName
  if (!tpl) return null
  return tpl
    .replace(/\$\{productName\}/g, PRODUCT)
    .replace(/\$\{version\}/g, VERSION)
    .replace(/\$\{ext\}/g, 'exe')
}

function resolveInstaller() {
  const named = artifactName()
  if (named) {
    const p = path.join(DIST, named)
    if (fs.existsSync(p)) return p
  }
  if (!fs.existsSync(DIST)) {
    throw new Error('找不到 dist 目录，请先执行 npm run dist')
  }
  const hit = fs
    .readdirSync(DIST)
    .find((f) => f.toLowerCase().endsWith('.exe') && f.includes(VERSION))
  if (!hit) {
    throw new Error(
      `dist 里没有 ${VERSION} 的安装包${named ? `（期望 ${named}）` : ''}\n请先执行 npm run dist`
    )
  }
  return path.join(DIST, hit)
}

function buildList(exePath) {
  const base = path.basename(exePath)
  const want = [
    { file: exePath, name: safeName(base) },
    { file: exePath + '.blockmap', name: safeName(base) + '.blockmap' },
    { file: path.join(DIST, 'latest.yml'), name: 'latest.yml' },
  ]
  return want
    .filter((a) => fs.existsSync(a.file))
    .map((a) => ({ ...a, size: fs.statSync(a.file).size }))
}

function defaultNotes(assets) {
  const lines = assets.map((a) => `- \`${a.name}\` (${fmtMB(a.size)})`)
  const exe = assets.find((a) => a.name.toLowerCase().endsWith('.exe'))
  return [
    `## DeskDock ${VERSION}`,
    '',
    '### 安装',
    '',
    `1. 下载 \`${exe ? exe.name : `${PRODUCT}_Setup_${VERSION}.exe`}\``,
    '2. 双击安装。安装包未签名，Windows 会拦一次，点「更多信息 → 仍要运行」',
    '3. 装完从开始菜单或桌面快捷方式启动，首次运行会在托盘常驻',
    '',
    '### 说明',
    '',
    '- 支持 Windows 10 / 11（x64）',
    '- 覆盖安装保留原有配置与图标缓存，不需要先卸载',
    '- 想回到干净状态：托盘菜单 → 更多 → 重置配置',
    '',
    '### 附件',
    '',
    ...lines,
  ].join('\n')
}

/* ---------- HTTP ---------- */

function call({ host, path: p, method = 'GET', headers = {}, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const h = { 'User-Agent': 'deskdock-release', ...headers }
    let payload = null
    if (body && typeof body === 'object' && !body.pipe) {
      payload = Buffer.from(JSON.stringify(body))
      h['Content-Type'] = 'application/json'
    }
    if (payload) h['Content-Length'] = payload.length
    if (body && body.pipe) h['Content-Length'] = body.__size

    const req = https.request({ host, path: p, method, headers: h, timeout: 0 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          /* 非 JSON 响应，保留原文 */
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers })
      })
    })

    req.on('error', reject)

    if (payload) {
      req.end(payload)
    } else if (body && body.pipe) {
      let sent = 0
      const total = body.__size
      let lastPct = -1
      body.on('data', (chunk) => {
        sent += chunk.length
        if (onProgress && total) {
          const pct = Math.floor((sent / total) * 100)
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct
            onProgress(pct, sent, total)
          }
        }
      })
      body.pipe(req)
    } else {
      req.end()
    }
  })
}

function withSize(stream, size) {
  stream.__size = size
  return stream
}

async function api(repo, token, p, opts = {}) {
  const res = await call({
    host: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${p}`,
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  })
  return res
}

/* ---------- 主流程 ---------- */

async function main() {
  const repo = getRepo()
  const assets = buildList(resolveInstaller())
  const notes = NOTES_ARG || defaultNotes(assets)

  console.log(`仓库    ${repo.owner}/${repo.repo}`)
  console.log(`版本    ${VERSION}   标签 ${TAG}${DRAFT ? '   [草稿]' : ''}`)
  console.log(`产物    ${assets.length} 个附件，合计 ${fmtMB(assets.reduce((s, a) => s + a.size, 0))}`)
  assets.forEach((a) => console.log(`        ${a.name}  ${fmtMB(a.size)}`))

  if (DRY) {
    console.log('\n--dry-run：以上为计划，未联网写任何数据。')
    console.log('发布说明预览：\n')
    console.log(notes.split('\n').map((l) => '  ' + l).join('\n'))
    return
  }

  const token = getToken()

  // 已存在同名 release 就复用，避免重复创建
  let release = null
  const found = await api(repo, token, `/releases/tags/${encodeURIComponent(TAG)}`)
  if (found.status === 200) {
    release = found.json
    console.log(`\n复用已有 release：${release.html_url}`)
    // 之前发的草稿，这次不带 --draft 再跑一遍即转公开
    if (release.draft && !DRAFT) {
      const patched = await api(repo, token, `/releases/${release.id}`, {
        method: 'PATCH',
        body: { draft: false },
      })
      if (patched.status !== 200) {
        throw new Error(`草稿转公开失败 ${patched.status}: ${patched.text.slice(0, 200)}`)
      }
      release = patched.json
      console.log('原草稿已转为公开')
    }
  } else if (found.status !== 404) {
    throw new Error(`查询 release 失败 ${found.status}: ${found.text.slice(0, 300)}`)
  } else {
    const created = await api(repo, token, '/releases', {
      method: 'POST',
      body: { tag_name: TAG, name: `${PRODUCT} ${VERSION}`, body: notes, draft: DRAFT },
    })
    if (created.status !== 201) {
      throw new Error(`创建 release 失败 ${created.status}: ${created.text.slice(0, 300)}`)
    }
    release = created.json
    console.log(`\n已创建 release：${release.html_url}`)
  }

  // 已有附件
  const existing = new Map((release.assets || []).map((a) => [a.name, a]))
  const uploadBase = `/repos/${repo.owner}/${repo.repo}/releases/${release.id}/assets`

  for (const a of assets) {
    if (existing.has(a.name)) {
      if (!CLOBBER) {
        console.log(`跳过    ${a.name}（已存在，要覆盖加 --clobber）`)
        continue
      }
      const del = await api(repo, token, `/releases/assets/${existing.get(a.name).id}`, {
        method: 'DELETE',
      })
      if (del.status !== 204) {
        throw new Error(`删除旧附件失败 ${del.status}: ${del.text.slice(0, 200)}`)
      }
      console.log(`已删    ${a.name}（重传）`)
    }

    process.stdout.write(`上传    ${a.name}  0%`)
    const res = await call({
      host: 'uploads.github.com',
      path: `${uploadBase}?name=${encodeURIComponent(a.name)}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        Accept: 'application/vnd.github+json',
      },
      body: withSize(fs.createReadStream(a.file), a.size),
      onProgress: (pct) => process.stdout.write(`\r上传    ${a.name}  ${pct}%`),
    })
    if (res.status !== 201) {
      process.stdout.write('\n')
      throw new Error(`上传失败 ${res.status}: ${res.text.slice(0, 300)}`)
    }
    const url = res.json && res.json.browser_download_url
    process.stdout.write(`\r上传    ${a.name}  完成  ${url || ''}\n`)
  }

  // 清掉本次清单之外的旧附件（改名、换目标后留下的孤儿）
  if (PRUNE) {
    const keep = new Set(assets.map((a) => a.name))
    for (const [name, asset] of existing) {
      if (keep.has(name)) continue
      const del = await api(repo, token, `/releases/assets/${asset.id}`, { method: 'DELETE' })
      console.log(
        del.status === 204 ? `清理    ${name}` : `清理失败 ${name}（${del.status}，可能已被删）`
      )
    }
  }

  console.log(`\n完成：${release.html_url}${DRAFT ? '\n当前是草稿，网页上点「Publish release」即公开。' : ''}`)
}

main().catch((e) => {
  console.error(`\n失败：${e.message}`)
  process.exit(1)
})
