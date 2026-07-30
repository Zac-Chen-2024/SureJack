import { useProjects } from '../../store/projects'
import { useSubtitles, findCurrentLineIndex } from '../../store/subtitles'
import { useFilmPlayback } from '../../hooks/useFilmPlayback'
import {
  IconChevronLeft, IconChevronDown, IconDownload, IconPlay, IconLoader,
} from '../ui/Icon'

/**
 * 手机版成片播放器：**边到边全屏，控制项浮在画面上**（照概念图 Screen 1）。
 *
 * 和桌面 FilmPlayer 是同一套播放逻辑（useFilmPlayback：播母带 + 浏览器叠
 * BGM + 循环相位同步 + 母带过期蒙层），只是外壳完全不同——桌面是带边框
 * 的一块、下面挂一条控制栏；手机上画面就是整块屏幕，顶栏、中央播放键、
 * 进度条都半透明地叠在画面上，像剪映那样。
 *
 * ── 字幕不在这里画 ────────────────────────────────────────────────────
 * 母带里字幕【已经烧死】了，播出来就带着。这里只叠一个"字幕 N / 总数"的
 * 计数（跟着播放头走），绝不再用 JS 渲染一遍字幕文字——那样会和烧死的
 * 那层重影，正是桌面版极力避免的事。
 *
 * ── 顶栏那颗药丸 = 回项目列表 ────────────────────────────────────────
 * 手机上"切项目"就是回到列表再挑一个，所以药丸（返回箭头 + 项目名 +
 * 下拉小箭头）整颗点下去都走 onBack，不另做一个下拉浮层。
 */

function fmt (s: number): string {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export function MobileFilmPlayer ({ onBack }: { onBack: () => void }) {
  const project = useProjects((s) => s.current())
  const setCurrentMs = useSubtitles((s) => s.setCurrentMs)
  const lines = useSubtitles((s) => s.lines)
  const currentMs = useSubtitles((s) => s.currentMs)
  const seekNonce = useSubtitles((s) => s.seekNonce)
  /*
   * 第二个参数【必须接上 seekNonce】：点字幕列表某一行要跳到那个时间点。
   * 原来这里传 null，于是手机上点字幕毫无反应（桌面版一直是接着的）。
   * 只认 nonce 变化——否则播放中每帧 currentMs 都在变，会被当成跳转指令。
   */
  const pb = useFilmPlayback(setCurrentMs, seekNonce > 0 ? { ms: currentMs, nonce: seekNonce } : null)

  if (!project || !pb.src) return null

  const lineIdx = findCurrentLineIndex(lines, currentMs)
  const subLabel = lines.length > 0
    ? `字幕 ${Math.max(lineIdx, 0) + 1} / ${lines.length}`
    : null

  return (
    <div className="absolute inset-0 bg-black">
      {/* 画面：铺满，object-contain 保证 9:16 不被裁 */}
      <video
        ref={pb.videoRef}
        src={pb.src}
        poster={pb.poster ?? undefined}
        playsInline
        // auto：连第一帧一起拿到（配合 src 的 #t=0.001），未播放时显示画面本身
        preload="auto"
        // object-top：9:16 的画面在更高的竖屏里顶对齐（贴最上沿），
        // 黑边留到底部，正好被进度条/底栏盖住——画面顶格、不再离顶有距离
        className="absolute inset-0 size-full object-contain object-top"
        onLoadedMetadata={(e) => pb.onLoadedMeta(e.currentTarget.duration)}
        onTimeUpdate={(e) => pb.onTimeUpdate(e.currentTarget.currentTime)}
        onEnded={pb.handleStop}
        onPause={pb.handleStop}
        onPlay={pb.handlePlay}
        onWaiting={pb.handleWaiting}
        onPlaying={pb.handlePlaying}
      />

      {/* 背景音乐：另叠一条，接进 Web Audio 图混音（音量走 gain，iOS 才有效）。
          key 换源即重建，避免相位串味；onBgmReady 负责接图/上音量/续播。 */}
      {pb.bgmSrc && (
        <audio
          key={pb.bgmSrc}
          ref={pb.bgmRef}
          src={pb.bgmSrc}
          loop
          preload="metadata"
          onLoadedMetadata={pb.onBgmReady}
        />
      )}

      {/* 点画面任意处 = 播放/暂停。压在控制层之下，不挡顶栏/进度条/底栏 */}
      <button
        type="button"
        aria-label={pb.playing ? '暂停' : '播放'}
        onClick={pb.toggle}
        className="absolute inset-0 z-10"
      />

      {/* ── 顶栏：返回药丸 + 下载 ─────────────────────────────────────── */}
      <div
        className="absolute inset-x-0 z-20 flex items-center justify-between px-4"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}
      >
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-full border border-white/15 bg-black/65 px-3.5 py-2 text-sm font-semibold text-white"
        >
          <IconChevronLeft className="size-4" strokeWidth={2.2} />
          <span className="max-w-[46vw] truncate">{project.name}</span>
          <IconChevronDown className="size-3.5 opacity-70" strokeWidth={2} />
        </button>

        <a
          href={`/api/projects/${project.id}/film/download`}
          aria-label="下载视频"
          title="下载视频"
          className="flex size-10 items-center justify-center rounded-full bg-accent text-ink-950 shadow-lg shadow-black/30"
        >
          <IconDownload className="size-5" strokeWidth={2.2} />
        </a>
      </div>

      {/* ── 中央播放键：仅暂停时出现 ─────────────────────────────────── */}
      {!pb.playing && (
        <div className="pointer-events-none absolute left-1/2 top-[44%] z-20 -translate-x-1/2 -translate-y-1/2">
          <div className="flex size-[74px] items-center justify-center rounded-full border-[1.5px] border-white/35 bg-black/50">
            <IconPlay className="ml-1 size-8 fill-white text-white" />
          </div>
        </div>
      )}

      {/* ── 字幕计数：跟随播放头，不重绘字幕文字 ─────────────────────── */}
      {subLabel && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 text-center"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 168px)' }}
        >
          <span className="rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white/80">
            {subLabel}
          </span>
        </div>
      )}

      {/* ── 进度条：贴在底栏之上 ─────────────────────────────────────── */}
      <div
        className="absolute inset-x-5 z-20 flex items-center gap-3 text-[11px] font-semibold tabular-nums text-white/90"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 120px)' }}
      >
        <span>{fmt(pb.cur)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(pb.dur, 0.01)}
          step={0.01}
          value={pb.cur}
          onChange={(e) => pb.seekTo(Number(e.target.value))}
          aria-label="播放进度"
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/25"
          style={{ accentColor: 'var(--color-accent)' }}
        />
        <span>{fmt(pb.dur)}</span>
      </div>

      {/* ── 合成中蒙层：改了文案/字幕/语速正在重烧母带 ───────────────── */}
      {pb.composing && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/75">
          <IconLoader className="size-7 animate-spin text-accent" />
          <div className="text-sm font-medium text-ink-50">正在合成新版本…</div>
          <div className="w-2/3 max-w-[220px]">
            <div className="h-1 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pb.progress}%` }} />
            </div>
            <div className="mt-1.5 text-center text-[11px] tabular-nums text-ink-300">{pb.progress}%</div>
          </div>
          <p className="px-8 text-center text-[11px] leading-relaxed text-ink-400">
            可以切到别的项目，合成在后台继续；好了这里会自动换成新片。
          </p>
        </div>
      )}
    </div>
  )
}
