import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'mcp__magic-lantern__project'
const PANE = 'magic-lantern'

const CANVAS = { width: 1280, height: 720 }
const RENDER_SCRIPT_BUDGET_MS = 3000
// A motion frame's pictures are captured in sheets: one page stacking up to
// SHEET_PICTURES copies of the frame, each paused at its own moment, shot by
// one Chrome launch and cut into pictures by ffmpeg. Launching Chrome is what
// costs, so a sheet holds as many pictures as Chrome screenshots in one go.
const SHEET_PICTURES = 20
const SHEET_MAX_HEIGHT = 16_000
// A motion picture is swapped many times a second, so it is captured at a density that
// keeps its RGBA pixels under 2 MiB: terminals drawn with the Iced UI library upload a
// larger picture in the background and show nothing in its place until it lands, which
// flickers on every swap. Stills, shown once, keep the full density.
const MOTION_MAX_PIXELS = Math.floor((1.8 * 1024 * 1024) / 4)
const SHEET_SCRIPT_BUDGET_MS = 1000
const RENDER_TIMEOUT_MS = 60_000
// Chrome runs this many renders at once.
const RENDER_CONCURRENCY = 4

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// The pane's layout: the picture centred with this many columns free on each side, and
// under it, rows for a blank, the spoken line (up to three rows), a blank, the progress
// segments, a blank and the controls: Pause and a button per frame while it plays (two
// rows where a narrow pane wraps them), Replay and Close once it has ended.
const PICTURE_MARGIN_COLUMNS = 2
const ROWS_UNDER_PICTURE = 10
// One progress segment per frame, at most this many cells long; a single frame gets one
// longer bar, which reads as the clip's own progress.
const SEGMENT_MAX_CELLS = 10
const SINGLE_BAR_CELLS = 40
const ACCENT = '#f0a24a'

// Playback advances on a clock tick, which also moves the current segment's fill; the
// pause between one frame's line and the next frame is counted in ticks.
const TICK_MS = 100
const GAP_MS = 400
// Where a line cannot play, a frame stays as long as the line takes to read.
const WORDS_PER_SECOND = 2.5

// The voice that reads a narration is the best one macOS has for its language,
// which the speech framework knows and `say` does not: left to itself, `say`
// speaks every language in the one system voice. A Premium or Enhanced voice the
// person downloaded wins over the language's default, which is a compact one even
// then; among voices of one quality the default stays, so a Mac with compact voices
// only never speaks in a novelty voice. The voice goes to `say` by its identifier:
// names repeat across languages, and `say` speaks a name it does not know in another
// voice without failing. The language arrives as an argument, never inside the script.
const DEFAULT_VOICE_SCRIPT = `function run(argv) {
  ObjC.import('AVFoundation')
  const language = argv[0].toLowerCase()
  const fallback = $.AVSpeechSynthesisVoice.voiceWithLanguage(argv[0])
  let best = fallback.isNil() ? undefined : fallback
  const voices = $.AVSpeechSynthesisVoice.speechVoices
  for (let i = 0; i < voices.count; i++) {
    const voice = voices.objectAtIndex(i)
    if (voice.language.js.toLowerCase() !== language) continue
    if (!best || voice.quality > best.quality) best = voice
  }
  return best ? best.identifier.js : ''
}`
// Narration is spoken to a WAV file ahead of playback, so a line can be
// stopped mid-sentence when the pane closes.
const SPEECH_FORMAT = 'LEI16@22050'
// That format's bytes a second (16-bit mono at 22050 Hz), and the WAV header `say`
// writes: not the bare 44 bytes, but padded so the samples start at 4 KiB, whatever
// the voice or the length of the line.
const SPEECH_BYTES_PER_SECOND = 44_100
const WAV_HEADER_BYTES = 4096

// Appended to a motion frame's page: it pauses every animation at the moment
// the URL's fragment names, in milliseconds (`#t=480`).
const CAPTURE_SCRIPT = `<script>
const at = Number(new URLSearchParams(location.hash.slice(1)).get('t'))
for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = at }
</script>`

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const CHROME_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
const FFMPEG_COMMANDS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']

const DESCRIPTION = `Project a short narrated slideshow in a pane beside the conversation: a few frames you compose as HTML, shown in order, each with one line a voice speaks while it is on screen. Load the magic-lantern:projecting skill first: it says when a projection fits.

Each frame is a whole HTML document drawn at width x height CSS pixels (default 1280x720): one idea per frame, large type, few words on screen, since the narration carries the sentence. Keep each narration line to one or two spoken sentences. 3 to 8 frames.

A frame can move: give it motion { seconds, fps } and animate its HTML with CSS animations or the Web Animations API, starting at time 0. The animation is captured at that frame rate and played once while its line is spoken, then holds its last picture.

The call returns once the frames are rendered and playback has started; the pane closes by itself after the last frame, and closing it stops the voice.`

type Motion = { seconds: number; fps: number }
type Frame = { html: string; narration: string; motion?: Motion }
type ExplainInput = { title: string; language: string; frames: Frame[]; width?: number; height?: number; voice?: string }

const INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'language', 'frames'],
  properties: {
    title: { type: 'string', description: 'The pane title: what the projection is about, a few words.' },
    language: { type: 'string', description: 'The language the narration is written in, as a BCP 47 tag (en-US, en-GB, it-IT); it picks the voice.' },
    frames: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['html', 'narration'],
        properties: {
          html: { type: 'string', description: 'A whole HTML document for this frame.' },
          narration: { type: 'string', description: 'What the voice says while this frame is on screen, as plain text.' },
          motion: {
            type: 'object',
            required: ['seconds', 'fps'],
            description: "Play the frame's animation instead of a still picture.",
            properties: {
              seconds: { type: 'number', minimum: 0.1, maximum: 4, description: 'How long the animation runs.' },
              fps: { type: 'integer', minimum: 1, maximum: 60, description: 'Pictures a second, captured and played.' },
            },
          },
        },
      },
    },
    width: { type: 'integer', minimum: 320, maximum: 2560, description: 'The width every frame is drawn in, in CSS pixels; default 1280.' },
    height: { type: 'integer', minimum: 180, maximum: 2560, description: 'The height every frame is drawn in, in CSS pixels; default 720.' },
    voice: { type: 'string', description: "A system voice by its exact name, in place of the language's own." },
  },
}

/** How a motion frame played: what the terminal took, and how fast. */
type ClipStats = {
  frame: number
  fps: number
  pictures: number
  captureMs: number
  sent: number
  taken: number
  denied: number
  firstDenial?: string
  startedAt?: number
  endedAt?: number
  achievedFps?: number
}

type PlaybackFrame = {
  path: string
  narration: string
  /** The spoken line as WAV bytes, base64; absent where `say` could not speak it. */
  speech?: string
  clip?: { paths: string[]; fps: number; stats: ClipStats }
  /** How long the frame plays: its spoken line, or its clip where that runs longer. */
  durationMs: number
}

type Playback = {
  title: string
  dir: string
  canvas: { width: number; height: number }
  frames: PlaybackFrame[]
  index: number
  /** The picture on screen: the frame's own, or the clip's latest. */
  shown: string
  // speaking: the line plays; moving: the clip plays; waiting: ticks left
  // before the next frame.
  isSpeaking: boolean
  isMoving: boolean
  waitTicks: number
  /** When the current frame started, and how far through it playback is, 0 to 1. */
  frameStartedAt: number
  progress: number
  /** The last frame has played: the pane holds it, with Replay and Close. */
  isEnded: boolean
  /** The pane is not drawn yet: the terminal is too narrow for a pane nobody asked for. */
  isAwaitingOpen: boolean
  /** Playback is manually paused; clock advances are skipped. */
  isPaused: boolean
  /** Aborted when the pane closes: stops the line being spoken. */
  stop: AbortController
}

let playback: Playback | undefined

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

const fileUrl = (path: string, fragment = '') => `file://${encodeURI(path)}${fragment}`

let chrome: string | undefined
const findChrome = async ($: EngineInterface) => {
  if (chrome) return chrome
  for (const path of CHROME_PATHS) {
    if (await $.fs.exists(path)) return (chrome = path)
  }
  for (const command of CHROME_COMMANDS) {
    const answered = await $.process.run([command, '--version']).catch(() => undefined)
    if (answered?.exitCode === 0) return (chrome = command)
  }
  return undefined
}

let ffmpeg: string | undefined
const findFfmpeg = async ($: EngineInterface) => {
  if (ffmpeg) return ffmpeg
  for (const command of FFMPEG_COMMANDS) {
    const answered = await $.process.run([command, '-version']).catch(() => undefined)
    if (answered?.exitCode === 0) return (ffmpeg = command)
  }
  return undefined
}

const sheetPage = (urls: string[], canvas: { width: number; height: number }) =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}iframe{display:block;border:0;width:${canvas.width}px;height:${canvas.height}px}</style>` +
  urls.map(url => `<iframe src="${url}"></iframe>`).join('')

const defaultVoice = async ($: EngineInterface, language: string) => {
  const ran = await $.process
    .run(['osascript', '-l', 'JavaScript', '-e', DEFAULT_VOICE_SCRIPT, language])
    .catch(() => undefined)
  const name = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  return name || undefined
}

const speakToFile = async ($: EngineInterface, voice: string, text: string, base: string) => {
  await $.fs.write(`${base}.txt`, text)
  const ran = await $.process
    .run(['say', '-v', voice, '-f', `${base}.txt`, '-o', `${base}.wav`, `--data-format=${SPEECH_FORMAT}`], { timeoutMs: RENDER_TIMEOUT_MS })
    .catch(() => undefined)
  if (ran?.exitCode !== 0) return undefined
  const read = await $.fs.read(`${base}.wav`, { as: 'bytes' }).catch(() => undefined)
  return read?.base64
}

const render = async (
  $: EngineInterface,
  browser: string,
  url: string,
  pngPath: string,
  canvas: Playback['canvas'],
  budgetMs: number,
  scale = 1,
) => {
  const ran = await $.process
    .run(
      [
        browser,
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${canvas.width},${canvas.height}`,
        `--force-device-scale-factor=${scale}`,
        `--virtual-time-budget=${budgetMs}`,
        `--screenshot=${pngPath}`,
        url,
      ],
      { timeoutMs: RENDER_TIMEOUT_MS },
    )
    .catch((error: unknown) => reason(error))
  if (typeof ran === 'string') return ran
  if (ran.exitCode !== 0) return `exit ${ran.exitCode}: ${ran.stderr.slice(-300)}`
  return undefined
}

/**
 * The density a motion frame is captured at: the largest whole number of pixel rows
 * whose picture stays within MOTION_MAX_PIXELS, so a sheet of them cuts evenly.
 */
const motionScale = (canvas: Playback['canvas']) => {
  const rows = Math.min(canvas.height, Math.floor(Math.sqrt((MOTION_MAX_PIXELS * canvas.height) / canvas.width)))
  return rows / canvas.height
}

/** Shoots one sheet and cuts it into its pictures, numbered from `first`. */
const renderSheet = async (
  $: EngineInterface,
  browser: string,
  cutter: string,
  sheet: { page: string; png: string; count: number; first: number; pattern: string },
  canvas: Playback['canvas'],
) => {
  const sheetCanvas = { width: canvas.width, height: canvas.height * sheet.count }
  const shot = await render($, browser, fileUrl(sheet.page), sheet.png, sheetCanvas, SHEET_SCRIPT_BUDGET_MS, motionScale(canvas))
  if (shot) return shot
  const cut = await $.process
    .run([cutter, '-v', 'error', '-y', '-i', sheet.png, '-vf', `untile=1x${sheet.count}`, '-start_number', String(sheet.first), sheet.pattern], { timeoutMs: RENDER_TIMEOUT_MS })
    .catch((error: unknown) => reason(error))
  if (typeof cut === 'string') return cut
  if (cut.exitCode !== 0) return `ffmpeg exit ${cut.exitCode}: ${cut.stderr.slice(-300)}`
  return undefined
}

/** Runs the jobs at most `limit` at a time, answers in their order. */
const pooled = async <T,>(jobs: (() => Promise<T>)[], limit: number) => {
  const answers: T[] = new Array(jobs.length)
  let nextJob = 0
  const worker = async () => {
    while (nextJob < jobs.length) {
      const i = nextJob++
      answers[i] = await jobs[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return answers
}

const ticks = (ms: number) => Math.ceil(ms / TICK_MS)
const readingTimeMs = (text: string) => (text.split(' ').length / WORDS_PER_SECOND) * 1000

/** How long a WAV in SPEECH_FORMAT plays, from its base64 bytes. */
const speechMs = (base64: string) => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = (base64.length * 3) / 4 - padding
  return (Math.max(0, bytes - WAV_HEADER_BYTES) / SPEECH_BYTES_PER_SECOND) * 1000
}

/** Back to the first frame, as the tool call left it. */
const rewind = (current: Playback) => {
  current.stop.abort()
  current.stop = new AbortController()
  current.index = -1
  current.shown = current.frames[0]!.path
  current.isSpeaking = false
  current.isMoving = false
  current.waitTicks = 0
  current.progress = 0
  current.isEnded = false
  current.isPaused = false
}

/** Freezes playback on the frame shown: the line stops, the clip holds its picture. */
const pause = (current: Playback) => {
  current.stop.abort()
  current.stop = new AbortController()
  current.isSpeaking = false
  current.isMoving = false
  current.isPaused = true
}

/**
 * Puts frame `index` on screen and starts its line and its clip; the clock moves on
 * once both have ended. Nothing in it waits, so no tick can come between.
 */
const startFrame = ($: EngineInterface, current: Playback, index: number, now: number) => {
  const frame = current.frames[index]
  if (!frame) return
  current.index = index
  current.shown = frame.clip?.paths[0] ?? frame.path
  current.frameStartedAt = now
  current.progress = 0
  $.ui.invalidate('ui.render')

  // A pause, a jump or a replay aborts this frame's signal and sets playback up
  // itself: the line and the clip they cut short then leave it alone, however late
  // they answer.
  const stopped = current.stop.signal
  if (frame.speech) {
    current.isSpeaking = true
    void $.audio.play({ base64: frame.speech, mime: 'audio/wav' }, { signal: stopped }).then(
      () => {
        if (stopped.aborted) return
        current.isSpeaking = false
        current.waitTicks = ticks(GAP_MS)
      },
      () => {
        if (stopped.aborted) return
        current.isSpeaking = false
        current.waitTicks = ticks(readingTimeMs(frame.narration))
      },
    )
  } else {
    current.waitTicks = ticks(readingTimeMs(frame.narration))
  }

  const clip = frame.clip
  if (!clip) return
  current.isMoving = true
  clip.stats.startedAt = now
  let picture = 1
  const timer = $.clock.every(Math.round(1000 / clip.fps), async () => {
    if (playback !== current || current.index !== index || stopped.aborted) {
      timer.cancel()
      return
    }
    if (picture >= clip.paths.length) {
      timer.cancel()
      current.isMoving = false
      const stats = clip.stats
      stats.endedAt = await $.clock.now()
      const seconds = (stats.endedAt - (stats.startedAt ?? stats.endedAt)) / 1000
      stats.achievedFps = seconds > 0 ? Math.round((stats.taken / seconds) * 10) / 10 : undefined
      await $.fs.write(`${current.dir}/clip-${stats.frame}-stats.json`, JSON.stringify(stats, null, 2))
      return
    }
    const path = clip.paths[picture++]!
    current.shown = path
    clip.stats.sent += 1
    void $.ui.blit({ requestId: PANE, key: 'frame', source: { file: path, format: 'png' } }).then(answer => {
      if (answer.deny) {
        clip.stats.denied += 1
        clip.stats.firstDenial ??= answer.deny
      } else {
        clip.stats.taken += 1
      }
    })
  })
}

/**
 * Cuts short what plays and plays frame `target` from its start, on screen at once. The
 * time is read first: from there to the frame starting nothing waits, so a tick cannot
 * move playback on in between.
 */
const jumpToFrame = async ($: EngineInterface, current: Playback, target: number) => {
  const now = await $.clock.now()
  if (playback !== current) return
  current.stop.abort()
  current.stop = new AbortController()
  current.isSpeaking = false
  current.isMoving = false
  current.waitTicks = 0
  current.isPaused = false
  current.isEnded = false
  startFrame($, current, Math.max(0, Math.min(target, current.frames.length - 1)), now)
}

// The clock that moves playback on: a tick does nothing unless slides play, and
// advances them once the line and the clip have ended and the pause has run. A reload
// of the plugins can stop it without the mod's start running again, so every place
// that starts or resumes a projection makes sure one is ticking; a clock that finds a
// newer one started stops itself.
let clockId = 0
let lastTickAt = 0
const ensureClock = async ($: EngineInterface) => {
  if ((await $.clock.now()) - lastTickAt < TICK_MS * 5) return
  const id = ++clockId
  lastTickAt = await $.clock.now()
  const clock = $.clock.every(TICK_MS, async () => {
    if (id !== clockId) {
      clock.cancel()
      return
    }
      const now = await $.clock.now()
      lastTickAt = now
      const current = playback
      if (!current || current.isAwaitingOpen || current.isEnded || current.isPaused) return
      if (playback !== current) return
      const playing = current.frames[current.index]
      if (playing) {
        const progress = Math.min(1, (now - current.frameStartedAt) / Math.max(1, playing.durationMs))
        if (Math.round(progress * 100) !== Math.round(current.progress * 100)) {
          current.progress = progress
          $.ui.invalidate('ui.render')
        }
      }
      if (current.isSpeaking || current.isMoving) return
      if (current.waitTicks > 0) {
        current.waitTicks -= 1
        return
      }
      const index = current.index + 1
      if (index >= current.frames.length) {
        current.isEnded = true
        current.progress = 1
        $.ui.invalidate('ui.render')
        return
      }
      startFrame($, current, index, now)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'project', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({ name: 'magic-lantern', description: 'Open the magic lantern pane and project what is waiting in it' })
    await ensureClock($)
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ExplainInput & { tool_use_id: string }
    if (!input.frames?.length) return { deny: 'Give at least one frame.' }
    const voice = input.voice ?? (await defaultVoice($, input.language))
    if (!voice) return { deny: `macOS has no voice for ${input.language}. Give another language tag, or a voice by name.` }
    const browser = await findChrome($)
    if (!browser) return { deny: 'No Chrome or Chromium found to render the frames.' }

    const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
    const dir = `${temp}/magic-lantern/${input.tool_use_id}`
    const canvas = { width: input.width ?? CANVAS.width, height: input.height ?? CANVAS.height }

    const cutter = input.frames.some(frame => frame.motion) ? await findFfmpeg($) : undefined
    if (input.frames.some(frame => frame.motion) && !cutter) {
      return { deny: 'Motion frames need ffmpeg, to cut the captured sheets into pictures. Install it, or give the frames without motion.' }
    }

    const frames: PlaybackFrame[] = []
    const renders: { frame: number; run: () => Promise<string | undefined> }[] = []
    for (const [i, frame] of input.frames.entries()) {
      const base = `${dir}/frame-${i + 1}`
      await $.fs.write(`${base}.html`, frame.html)
      renders.push({ frame: i + 1, run: () => render($, browser, fileUrl(`${base}.html`), `${base}.png`, canvas, RENDER_SCRIPT_BUDGET_MS) })
      const playing: PlaybackFrame = { path: `${base}.png`, narration: frame.narration, durationMs: 0 }
      if (frame.motion) {
        const { seconds, fps } = frame.motion
        await $.fs.write(`${base}.capture.html`, frame.html + CAPTURE_SCRIPT)
        const count = Math.max(1, Math.round(seconds * fps))
        const paths = Array.from({ length: count }, (_, k) => `${base}.clip-${String(k + 1).padStart(3, '0')}.png`)
        const perSheet = Math.max(1, Math.min(SHEET_PICTURES, Math.floor(SHEET_MAX_HEIGHT / canvas.height)))
        for (let first = 0; first < count; first += perSheet) {
          const sheetCount = Math.min(perSheet, count - first)
          const urls = Array.from({ length: sheetCount }, (_, k) => fileUrl(`${base}.capture.html`, `#t=${Math.round(((first + k) * 1000) / fps)}`))
          const sheet = {
            page: `${base}.sheet-${first + 1}.html`,
            png: `${base}.sheet-${first + 1}.png`,
            count: sheetCount,
            first: first + 1,
            pattern: `${base}.clip-%03d.png`,
          }
          await $.fs.write(sheet.page, sheetPage(urls, canvas))
          renders.push({ frame: i + 1, run: () => renderSheet($, browser, cutter!, sheet, canvas) })
        }
        playing.clip = { paths, fps, stats: { frame: i + 1, fps, pictures: count, captureMs: 0, sent: 0, taken: 0, denied: 0 } }
      }
      frames.push(playing)
    }

    const startedAt = await $.clock.now()
    const [failures, speech] = await Promise.all([
      pooled(renders.map(job => job.run), RENDER_CONCURRENCY),
      Promise.all(input.frames.map((frame, i) => speakToFile($, voice, frame.narration, `${dir}/frame-${i + 1}`))),
    ])
    const renderMs = (await $.clock.now()) - startedAt
    const failed = failures.findIndex(failure => failure !== undefined)
    if (failed !== -1) return { deny: `Chrome could not render frame ${renders[failed]!.frame}: ${failures[failed]}` }
    frames.forEach((frame, i) => {
      frame.speech = speech[i]
      const lineMs = frame.speech ? speechMs(frame.speech) : readingTimeMs(frame.narration)
      frame.durationMs = Math.max(lineMs, frame.clip ? (frame.clip.paths.length / frame.clip.fps) * 1000 : 0)
      if (frame.clip) frame.clip.stats.captureMs = renderMs
    })

    playback = {
      title: input.title,
      dir,
      canvas,
      frames,
      index: -1,
      shown: frames[0]!.path,
      isSpeaking: false,
      isMoving: false,
      waitTicks: 0,
      frameStartedAt: 0,
      progress: 0,
      isEnded: false,
      isAwaitingOpen: false,
      isPaused: false,
      stop: new AbortController(),
    }
    // A pane opened from a tool call is one nobody asked for, which a narrow terminal
    // leaves undrawn; the slides then wait for the person's /magic-lantern.
    await ensureClock($)
    const opened = await $.ui.open({ id: PANE, title: input.title })
    if (!opened.isPlaced) {
      playback.isAwaitingOpen = true
      return {
        result: `The slides are ready but the pane is not drawn: ${opened.reason}. Ask the person to run /magic-lantern, which opens it at any width and starts playback.`,
      }
    }
    const silent = speech.filter(line => line === undefined).length
    const silentNote = silent ? ` ${silent} line(s) could not be spoken and are shown only.` : ''
    const clips = frames.filter(frame => frame.clip).length
    const clipNote = clips ? ` ${clips} motion frame(s); each writes clip-<frame>-stats.json there once played.` : ''
    return {
      result: `Projecting ${frames.length} frames in the magic lantern pane, voice ${voice}; the pane stays open on the last frame until the person closes it. ${renders.length} Chrome renders (stills and sheets) in ${renderMs} ms. Frames: ${dir}.${silentNote}${clipNote}`,
    }
  }).catch(($, e, next) => ({
    deny: `magic-lantern could not project (${next.error.kind}${next.error.message ? `: ${next.error.message}` : ''}).`,
  }))

  on('command.run', { command: 'magic-lantern' }, async $ => {
    if (!playback) return { text: 'Nothing is waiting to be projected.' }
    const opened = await $.ui.open({ id: PANE, title: playback.title })
    if (!opened.isPlaced) return { text: `The magic lantern pane could not open: ${opened.reason}` }
    playback.isAwaitingOpen = false
    await ensureClock($)
    return { text: 'Projecting.' }
  })

  // The person closing the pane stops the playback and the line being spoken.
  on('ui.close', { id: PANE }, async (_$, e, next) => {
    playback?.stop.abort()
    playback = undefined
    return next(e)
  })

  // The call's row is left out of the transcript: the pane is what the person watches,
  // and the call's markup only crowds the conversation. ctrl+o shows it whole, and a
  // failed call keeps its row so the failure is seen.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.isErrored || e.props.isInterrupted) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Frames are pictures, which only the terminal draws; elsewhere the pane
  // carries the spoken line alone. In the terminal: the picture centred, the line as a
  // subtitle under it (with a speaker while the line is heard), a progress segment per
  // frame (the current one filling as it plays), Pause and a button per frame to jump
  // to, and once the last frame has played, Replay and Close.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = playback
    const index = current ? Math.min(Math.max(current.index, 0), current.frames.length - 1) : 0
    const frame = current?.frames[index]
    if (!current || !frame) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Nothing playing.</Text>
    }
    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{frame.narration}</Text>
          <Text dimColor>
            {index + 1} / {current.frames.length}
          </Text>
        </Box>
      )
    }
    const { Box, Text, Image, Button } = $.ui.resolve(e)
    const { width, height } = current.canvas
    let columns = Math.min(255, Math.max(1, e.props.bodyColumns - 2 * PICTURE_MARGIN_COLUMNS))
    let rows = Math.max(1, Math.round((columns * height) / width / CELL_ASPECT))
    const room = Math.max(4, e.props.scroll.bodyRows - ROWS_UNDER_PICTURE)
    if (rows > room) {
      rows = room
      columns = Math.max(1, Math.round((rows * CELL_ASPECT * width) / height))
    }

    const count = current.frames.length
    const cells =
      count === 1
        ? Math.min(columns, SINGLE_BAR_CELLS)
        : Math.max(2, Math.min(SEGMENT_MAX_CELLS, Math.floor((columns - (count - 1)) / count)))
    const bar = (length: number) => '━'.repeat(Math.max(0, length))
    const segments = current.frames.map((_, i) => {
      if (current.isEnded || i < index) return <Text>{bar(cells)}</Text>
      if (i > index || current.index < 0) return <Text dimColor>{bar(cells)}</Text>
      const lit = Math.round(cells * current.progress)
      return (
        <Box>
          <Text color={ACCENT}>{bar(lit)}</Text>
          <Text dimColor>{bar(cells - lit)}</Text>
        </Box>
      )
    })

    // Playing again replays the paused frame from its start, so its line is heard whole.
    const play = (target: number) => {
      if (playback !== current) return
      void jumpToFrame($, current, target).then(() => ensureClock($))
    }
    const togglePause = () => {
      if (playback !== current) return
      if (current.isPaused) return play(index)
      pause(current)
      $.ui.invalidate('ui.render')
    }

    // The speaker has a slot of its own, so the line does not move as it comes and goes.
    // The labels are plain words: the glyphs for play and pause are drawn one cell wide
    // by some terminals and two by others, which breaks the row they sit in.
    return (
      <Box flexDirection="column" alignItems="center" paddingTop={1}>
        <Image key="frame" source={{ file: current.shown, format: 'png' }} columns={columns} rows={rows} alt={frame.narration} />
        {!current.isEnded && (
          <Box marginTop={1} width={columns} justifyContent="center" gap={1}>
            <Box width={2} flexShrink={0}>
              <Text>{current.isSpeaking ? '🔊' : ''}</Text>
            </Box>
            <Text>{frame.narration}</Text>
          </Box>
        )}
        <Box marginTop={1} gap={1}>
          {segments}
        </Box>
        {!current.isEnded && (
          <Box marginTop={1} width={columns} justifyContent="center" flexWrap="wrap" gap={1}>
            <Button key="pause" hotkey="p" onPress={togglePause}>
              {current.isPaused ? 'Play' : 'Pause'}
            </Button>
            {current.frames.map((_, i) => (
              <Button
                key={`frame-${i + 1}`}
                hotkey={i < 9 ? String(i + 1) : undefined}
                variant={i === index ? 'primary' : undefined}
                onPress={() => play(i)}
              >
                {String(i + 1)}
              </Button>
            ))}
          </Box>
        )}
        {current.isEnded && (
          <Box marginTop={1} gap={2}>
            <Button
              hotkey="r"
              variant="primary"
              onPress={() => {
                if (playback !== current) return
                rewind(current)
                $.ui.invalidate('ui.render')
                void ensureClock($)
              }}
            >
              Replay
            </Button>
            <Button role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
              Close
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
