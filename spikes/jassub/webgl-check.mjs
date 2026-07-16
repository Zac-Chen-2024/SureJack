import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage()
console.log(await p.evaluate(() => {
  const c = document.createElement('canvas')
  const gl2 = c.getContext('webgl2'), gl = c.getContext('webgl')
  const oc = new OffscreenCanvas(10,10)
  return JSON.stringify({
    webgl2: !!gl2, webgl: !!gl,
    renderer: gl2 ? gl2.getParameter(gl2.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl2.RENDERER) : null,
    offscreen_webgl2: !!oc.getContext('webgl2'),
    offscreen_2d: !!oc.getContext('2d'),
  })
}))
await b.close()
