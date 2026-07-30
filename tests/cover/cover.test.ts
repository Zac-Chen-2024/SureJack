import { describe, it, expect } from 'vitest'
import {
  escapeDrawtext, coverTitleOf, coverDrawtextFilter, coverClipArgs, COVER_FRAMES,
} from '../../src/cover/cover.js'

const ASPECT = { name: '9:16', width: 1080, height: 1920 }

describe('封面标题', () => {
  it('项目自己填了就用自己的', () => {
    expect(coverTitleOf({ name: '周周撸铁', coverTitle: '后续来啦' })).toBe('后续来啦')
  })

  /*
   * 老项目一条都没填过封面标题（迁移时 ALTER TABLE 回填的是空串），
   * 它们必须自动拿到以项目名为标题的封面——这是"老项目也要有封面"的全部实现。
   */
  it('【没填就用项目名】老项目全靠这条', () => {
    expect(coverTitleOf({ name: '周周撸铁', coverTitle: '' })).toBe('周周撸铁')
    expect(coverTitleOf({ name: '周周撸铁', coverTitle: '   ' })).toBe('周周撸铁')
    expect(coverTitleOf({ name: '周周撸铁' })).toBe('周周撸铁')
  })
})

describe('drawtext 转义', () => {
  /*
   * 冒号是滤镜图的参数分隔符。标题里出现一个冒号而不转义，整条 -vf 会被
   * 切错，ffmpeg 报的还是"看不懂的选项"这种毫无指向的错——用户只看到
   * "合成失败"，没人猜得到是标题里那个冒号。
   */
  it('冒号、反斜杠、单引号、百分号都要转义', () => {
    expect(escapeDrawtext('他说：走')).toBe('他说：走')          // 中文全角冒号不用转
    expect(escapeDrawtext('他说:走')).toBe('他说\\:走')
    expect(escapeDrawtext("it's")).toBe("it\\'s")
    expect(escapeDrawtext('a\\b')).toBe('a\\\\b')
    expect(escapeDrawtext('100%')).toBe('100\\%')
  })

  it('普通中文标题原样通过', () => {
    expect(escapeDrawtext('后续来啦')).toBe('后续来啦')
  })
})

describe('版式比例', () => {
  /*
   * 这几个数是对参考图逐像素拟合出来的（spikes/cover/），不是随手填的：
   * 思源黑体 Medium、字号 0.16508×宽、描边 0.03846×字号、垂直居中再下移
   * 0.0096×字号，实测外轮廓 IoU 0.961、字心 0.941。
   * 钉死它们——谁顺手改一下，封面就和参考不再重合，而这种偏差只有把两张图
   * 叠在一起才看得出来。
   */
  it('1260 宽时字号 208、描边 8、下移 2', () => {
    const f = coverDrawtextFilter('后续来啦', { name: 'x', width: 1260, height: 2242 })
    expect(f).toContain('fontsize=208')
    expect(f).toContain('borderw=8')
    expect(f).toContain('y=(h-text_h)/2+2')
    expect(f).toContain('x=(w-text_w)/2')
  })

  it('换分辨率时字号和描边一起缩', () => {
    const f = coverDrawtextFilter('后续来啦', ASPECT)
    expect(f).toContain('fontsize=178')   // 1080 × 0.16508
    expect(f).toContain('borderw=7')      // 178 × 0.03846
  })
})

describe('封面片段的编码参数', () => {
  const base = {
    imagePath: '/x.jpg', title: '甲', aspect: ASPECT, outPath: '/o.mp4',
    audio: { sampleRate: 24000, channelLayout: 'mono' },
  }

  it('只有两帧', () => {
    const a = coverClipArgs(base)
    expect(a[a.indexOf('-frames:v') + 1]).toBe(String(COVER_FRAMES))
  })

  /*
   * 拼接走 concat + -c copy，两段的音频参数必须完全一致。写死 44100/stereo
   * 碰上 Azure 配音的 24000/mono，拼出来的片子后半段没声音——而封面那两帧
   * 是有声音的（静音也算），所以文件时长看着完全正常。
   */
  it('【音频参数照抄正片】不能写死', () => {
    expect(coverClipArgs(base).join(' '))
      .toContain('anullsrc=channel_layout=mono:sample_rate=24000')
    expect(coverClipArgs({ ...base, audio: { sampleRate: 44100, channelLayout: 'stereo' } }).join(' '))
      .toContain('anullsrc=channel_layout=stereo:sample_rate=44100')
  })

  /* 母带是 libx264/fast/crf21/yuv420p/30fps/aac192k，差一项 -c copy 就拼不上 */
  it('编码参数和母带逐项一致', () => {
    const a = coverClipArgs(base).join(' ')
    expect(a).toContain('-c:v libx264 -preset fast -crf 21')
    expect(a).toContain('-pix_fmt yuv420p')
    expect(a).toContain('-c:a aac -b:a 192k')
    expect(a).toContain('-r 30')
  })
})
