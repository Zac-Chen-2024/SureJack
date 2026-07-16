/**
 * 客观验证「两端同一个 libass」这一核心架构主张。
 *
 * 做法：让 JASSUB 在浏览器 canvas 上渲染 t=3.0s 的字幕，截图；
 * 再让 ffmpeg 抽出同一时刻的帧；两张图逐像素比对。
 *
 * 「看起来差不多」不算通过——如果两端真是同一个 libass、同一个 ASS、
 * 同一个字体文件、同一个分辨率，字幕像素应当高度吻合。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

const PORT = 8099
const RENDER_AT = 3.0
const ROOT = new URL('.', import.meta.url).pathname

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.ass': 'text/plain', '.ttc': 'font/collection', '.map': 'application/json',
  '.woff2': 'font/woff2', '.json': 'application/json',
}

function serve () {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0])
    try {
      const body = readFileSync(join(ROOT, path === '/' ? 'index.html' : path))
      res.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        // JASSUB 的 worker 需要这两个头才能用 SharedArrayBuffer
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise(resolve => server.listen(PORT, () => resolve(server)))
}

/** 抽 ffmpeg 的帧，返回 {w, h, rgb: Buffer} */
function ffmpegFrame (ts) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(ts), '-i', join(ROOT, '../karaoke/out.mp4'),
      '-vframes', '1', '-pix_fmt', 'rgb24',
      '-f', 'image2pipe', '-vcodec', 'ppm', '-',
    ])
    const chunks = []
    p.stdout.on('data', c => chunks.push(c))
    p.stderr.on('data', c => process.stderr.write(c))
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}`))
      const ppm = Buffer.concat(chunks)
      // P6\n<w> <h>\n255\n<raw rgb>
      let pos = 0, fields = []
      while (fields.length < 4) {
        const nl = ppm.indexOf(0x0a, pos)
        fields.push(...ppm.subarray(pos, nl).toString().trim().split(/\s+/))
        pos = nl + 1
      }
      resolve({ w: +fields[1], h: +fields[2], rgb: ppm.subarray(pos) })
    })
  })
}

/** 数一张 RGB 图里的黄色和白色像素 */
function countColors (rgb, stride = 3) {
  let yellow = 0, white = 0
  for (let i = 0; i + 2 < rgb.length; i += stride) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    if (r > 180 && g > 180) {
      if (b < 100) yellow++
      else if (b > 180) white++
    }
  }
  return { yellow, white }
}

const server = await serve()
const browser = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] })
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } })

page.on('console', m => console.log('  [浏览器]', m.text()))

await page.goto(`http://127.0.0.1:${PORT}/index.html?t=${RENDER_AT}`)
await page.waitForFunction('window.__spike && (window.__spike.ready || window.__spike.error)', null, { timeout: 60000 })

const state = await page.evaluate('window.__spike')
if (state.error) {
  console.error('❌ JASSUB 初始化失败：\n' + state.error)
  await browser.close(); server.close(); process.exit(1)
}

console.log(`字体：${(state.fontBytes / 1048576).toFixed(1)} MB，加载耗时 ${state.fontMs} ms`)

// 截 canvas，而不是整页——避免页面布局引入偏移
const shot = await page.locator('#c').screenshot({ path: join(ROOT, 'jassub.png') })
await browser.close()
server.close()

// 用 ffmpeg 把 PNG 转成 raw RGB，方便和 ffmpeg 的帧同口径比较
const toRgb = (pngPath) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', pngPath,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
  const chunks = []
  p.stdout.on('data', c => chunks.push(c))
  p.on('close', c => c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('转换失败')))
})

const jassubRgb = await toRgb(join(ROOT, 'jassub.png'))
const burned = await ffmpegFrame(RENDER_AT)

console.log(`\n分辨率  JASSUB: 1080x1920   ffmpeg 烧录: ${burned.w}x${burned.h}`)

const a = countColors(jassubRgb)
const b = countColors(burned.rgb)

console.log('\n            黄色(已唱)   白色(未唱)')
console.log('  ' + '-'.repeat(38))
console.log(`  JASSUB    ${String(a.yellow).padStart(9)}   ${String(a.white).padStart(9)}`)
console.log(`  ffmpeg    ${String(b.yellow).padStart(9)}   ${String(b.white).padStart(9)}`)

if (a.yellow === 0 && a.white === 0) {
  console.log('\n❌ JASSUB 一个字幕像素都没渲染出来')
  console.log('   最可能的原因：.ttc 字体集合没被正确解析（见 RESULTS.md 中 Spike 1 的遗留问题）')
  process.exit(1)
}

const dy = Math.abs(a.yellow - b.yellow) / Math.max(b.yellow, 1)
const dw = Math.abs(a.white - b.white) / Math.max(b.white, 1)
console.log(`\n  黄色差异 ${(dy * 100).toFixed(1)}%   白色差异 ${(dw * 100).toFixed(1)}%`)

if (dy < 0.05 && dw < 0.05) {
  console.log('\n✅ 通过：两端像素高度吻合（差异 <5%）')
  console.log('   「同一个 libass、同一个 ASS、同一个字体 → 同样的像素」这一主张成立')
  writeFileSync(join(ROOT, 'VERDICT.txt'), 'GO\n')
} else {
  console.log('\n⚠️  两端渲染存在差异，需要人工看图判断是否可接受')
  console.log('   对比：spikes/jassub/jassub.png  vs  spikes/karaoke/frame_3.0s.png')
  writeFileSync(join(ROOT, 'VERDICT.txt'), 'NEEDS-REVIEW\n')
}
