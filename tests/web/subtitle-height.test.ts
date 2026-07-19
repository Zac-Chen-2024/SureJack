import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProjects } from '../../web/src/store/projects'

/**
 * 字幕高度的草稿机制。
 *
 * 改字幕高度会改 ASS、让母带指纹失效——十几分钟的重烧。所以拖动期间
 * 【一个请求都不能发】，只有点确认才落库。这里守的就是这一条：
 * 它一破，用户在滑块上来回找位置的十几秒能排出十几条渲染。
 */
describe('字幕高度：拖动只改草稿', () => {
  /*
   * ⚠️ 必须先放一个【当前项目】进去。
   *
   * 踩过：一开始没设 currentId，于是变异测试（让 setDraftMarginV 顺手落库）
   * 【照样全绿】——因为 patchProject 头一行就是 `if (!id) return`，
   * 根本走不到 fetch。那条断言看着在守"不发请求"，其实只是在守
   * "没选项目时不发请求"，而那是另一回事。
   */
  beforeEach(() => {
    useProjects.setState({
      draftMarginV: null,
      currentId: 'p1',
      items: [{
        id: 'p1', name: '测试项目', scriptText: '', aspectRatio: '9:16',
        createdAt: '', updatedAt: '', ttsState: 'ready', ttsDurationMs: 1000,
        bgmVolume: 0.15, subtitleMode: 'karaoke', bgmLibraryId: null,
        subtitleMarginV: 300,
      } as never],
    })
    vi.unstubAllGlobals()
  })

  it('【设草稿不发任何请求】这是不重烧的全部保证', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    useProjects.getState().setDraftMarginV(400)
    useProjects.getState().setDraftMarginV(450)
    useProjects.getState().setDraftMarginV(520)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(useProjects.getState().draftMarginV).toBe(520)
  })

  it('取消就是把草稿丢掉，不留痕迹', () => {
    useProjects.getState().setDraftMarginV(400)
    useProjects.getState().setDraftMarginV(null)
    expect(useProjects.getState().draftMarginV).toBe(null)
  })

  /*
   * 不清的话：界面显示着 A 项目那个没确认的高度，用户点确认，
   * 改掉的却是 B 项目——而且他看到的预览线一直是对的，
   * 完全没有任何迹象能让人发现改错了对象。
   */
  it('【切项目必须清掉草稿】否则会把 A 的改动确认到 B 头上', () => {
    useProjects.getState().setDraftMarginV(400)
    useProjects.getState().select('另一个项目')
    expect(useProjects.getState().draftMarginV).toBe(null)
  })
})
