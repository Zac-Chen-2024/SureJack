import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSrt } from '../../src/subtitles/srt.js'

describe('parseSrt', () => {
  it('解析标准单行 cue，时间码转毫秒正确', () => {
    const srt = `1
00:00:01,073 --> 00:00:02,196
但他的室友军师很暖
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startMs).toBe(1073)
    expect(lines[0]!.endMs).toBe(2196)
    expect(lines[0]!.words).toEqual([
      { text: '但他的室友军师很暖', offsetMs: 1073, durationMs: 1123, isPunctuation: false },
    ])
  })

  it('时间码 00:01:02,500 → 62500ms', () => {
    const srt = `1\n00:01:02,500 --> 00:01:03,000\n测试\n`
    expect(parseSrt(srt)[0]!.startMs).toBe(62500)
  })

  it('时间码 01:00:00,000 → 3600000ms', () => {
    const srt = `1\n01:00:00,000 --> 01:00:01,000\n测试\n`
    expect(parseSrt(srt)[0]!.startMs).toBe(3600000)
  })

  it('剥 BOM——首字符是 U+FEFF 时不污染第一条字幕文本', () => {
    const srt = '﻿1\n00:00:00,000 --> 00:00:01,000\n第一句\n'
    const lines = parseSrt(srt)
    expect(lines[0]!.words[0]!.text).toBe('第一句')
    expect(lines[0]!.words[0]!.text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('多行正文 cue 用真实换行 \\n 连接，不是空格', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
第一行
第二行
`
    const lines = parseSrt(srt)
    expect(lines[0]!.words[0]!.text).toBe('第一行\n第二行')
  })

  it('\\r\\n 行尾也能解析', () => {
    const srt = '1\r\n00:00:00,000 --> 00:00:01,000\r\n你好\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\n世界\r\n'
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words[0]!.text).toBe('你好')
    expect(lines[1]!.words[0]!.text).toBe('世界')
  })

  it('空文本 cue 被跳过', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000

2
00:00:01,000 --> 00:00:02,000
有内容
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.words[0]!.text).toBe('有内容')
  })

  it('空输入 → 空数组，不崩', () => {
    expect(parseSrt('')).toEqual([])
    expect(parseSrt('   \n\n  ')).toEqual([])
  })

  it('多个 cue 依次解析，顺序保持', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,073
网恋对象的嘴巴很毒

2
00:00:01,073 --> 00:00:02,196
但他的室友军师很暖
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words[0]!.text).toBe('网恋对象的嘴巴很毒')
    expect(lines[1]!.words[0]!.text).toBe('但他的室友军师很暖')
  })

  it('端到端：解析真实文件 Material/Text/军师.srt', () => {
    const text = readFileSync('Material/Text/军师.srt', 'utf-8')
    const lines = parseSrt(text)
    expect(lines.length).toBeGreaterThan(600)
    expect(lines[0]!.words[0]!.text).toBe('网恋对象的嘴巴很毒')
    expect(lines[0]!.startMs).toBe(0)
    expect(lines[0]!.endMs).toBe(1073)
  })

  it('两条 cue 之间缺空行——序号+时间码不能被塞进上一条的正文（I1/T11.5）', () => {
    // 中间故意不留空行：Hello world 后直接接下一条的序号"2"
    const srt = `1
00:00:00,000 --> 00:00:01,000
Hello world
2
00:00:02,000 --> 00:00:04,000
Second line
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words[0]!.text).toBe('Hello world')
    expect(lines[0]!.endMs).toBe(1000)
    expect(lines[1]!.words[0]!.text).toBe('Second line')
    expect(lines[1]!.startMs).toBe(2000)
    // 关键断言：第一条正文里绝不能出现第二条的序号/时间码
    expect(lines[0]!.words[0]!.text).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(lines[0]!.words[0]!.text).not.toContain('2\n')
  })

  it('多条 cue 连续缺空行，全部正确重新切分', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
第一句
2
00:00:01,000 --> 00:00:02,000
第二句
3
00:00:02,000 --> 00:00:03,000
第三句
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.words[0]!.text)).toEqual(['第一句', '第二句', '第三句'])
  })

  it('缺空行且没有序号行（时间码直接紧跟上一条正文）也能正确切分', () => {
    const srt = `1
00:00:00,000 --> 00:00:01,000
第一句
00:00:01,000 --> 00:00:02,000
第二句
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.words[0]!.text).toBe('第一句')
    expect(lines[1]!.words[0]!.text).toBe('第二句')
  })

  it('点分隔毫秒 00:00:01.073 也能解析成 1073ms', () => {
    const srt = `1
00:00:01.073 --> 00:00:02.196
点分隔的时间码
`
    const lines = parseSrt(srt)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startMs).toBe(1073)
    expect(lines[0]!.endMs).toBe(2196)
    expect(lines[0]!.words[0]!.text).toBe('点分隔的时间码')
  })
})
