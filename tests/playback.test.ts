import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__magic-lantern__project'
const AVA = 'com.apple.voice.premium.en-US.Ava'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Every line plays this long under the mocked audio.
const LINE_MS = 2000

type Play = { frame: number; aborted: boolean; ended: boolean }

// The world beneath the mod: processes, files, audio and the pane, answered from memory.
const world = (on: any, startAt: number) => {
  const clock = mock.clock(on, { now: startAt })
  mock.env(on, { TMPDIR: '/tmp/ml-test/' })
  const says: string[][] = []
  const osascripts: string[][] = []
  const plays: Play[] = []
  const blits: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'magic-lantern' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.blit', (_: any, e: any) => {
    blits.push(e.source.file)
    return { value: {} }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === CHROME }))
  // A frame's line comes back as WAV bytes whose length names the frame: 4 KiB of header,
  // then LINE_MS of samples, then 3 bytes a frame number.
  on('fs.read', (_: any, e: any) => {
    const frame = Number(/frame-(\d+)\.wav$/.exec(e.path)![1])
    const bytes = 4096 + (LINE_MS / 1000) * 44_100 + frame * 3
    return { value: { base64: 'A'.repeat(Math.ceil(bytes / 3) * 4) } }
  })
  on('process.run', (_: any, e: any) => {
    const [command] = e.argv
    if (command === 'osascript') {
      osascripts.push(e.argv)
      return { value: { exitCode: 0, stdout: `${AVA}\n`, stderr: '' } }
    }
    if (command === 'say') says.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('audio.play', async (_: any, e: any, next: any) => {
    const bytes = (e.clip.base64.length / 4) * 3
    const play: Play = { frame: Math.floor((bytes - 4096 - (LINE_MS / 1000) * 44_100) / 3), aborted: false, ended: false }
    plays.push(play)
    await Promise.race([
      clock.sleep(LINE_MS).then(() => (play.ended = true)),
      new Promise(resolve => next.signal.addEventListener('abort', () => resolve((play.aborted = true)))),
    ])
    return { value: undefined }
  })
  return { clock, says, osascripts, plays, blits }
}

const pane = (bodyColumns: number, bodyRows: number, surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'magic-lantern',
    component: 'Pane',
    requestId: 'magic-lantern',
    surface,
    props: {
      title: 'Test',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const frames = [
  { html: '<p>1</p>', narration: 'First frame line.' },
  { html: '<p>2</p>', narration: 'Second frame moves.', motion: { seconds: 1, fps: 10 } },
  { html: '<p>3</p>', narration: 'Third frame line.' },
]

test('the best voice, pause and play on a moving frame, jumps and their hotkeys', async ($, on) => {
  const w = world(on, 10_000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const called: any = await $.tool.call({ tool: TOOL, title: 'Test', language: 'en-US', frames } as any)

  // The voice: the speech framework's answer goes to `say` as given.
  expect(w.osascripts[0]!.at(-1)).toBe('en-US')
  expect(w.says).toHaveLength(3)
  for (const argv of w.says) expect(argv.slice(0, 3)).toEqual(['say', '-v', AVA])
  expect(JSON.stringify(called)).toContain(`voice ${AVA}`)

  const ui = await $.ui.mount(pane(100, 40))
  const line = async () => {
    await ui.redraw()
    const texts = await ui.findAll({ type: 'Text' })
    return {
      narration: texts.find(t => /frame/.test(t.text))?.text,
      speaking: texts.some(t => t.text === '🔊'),
      progress: texts.filter(t => /━/.test(t.text)).map(t => `${t.props.color ?? (t.props.dimColor ? 'dim' : 'lit')}:${t.text.length}`).join(' '),
    }
  }
  const button = async (key: string) => {
    await ui.redraw()
    return ui.find({ type: 'Button', key })
  }

  // Frame 1 plays, then frame 2 with its clip.
  await w.clock.advance(100)
  expect(await line()).toMatchObject({ narration: 'First frame line.', speaking: true })
  await w.clock.advance(LINE_MS + 500)
  expect((await line()).narration).toBe('Second frame moves.')
  expect(w.plays.map(p => p.frame)).toEqual([1, 2])
  await w.clock.advance(300)
  const blitsBeforePause = w.blits.length
  expect(blitsBeforePause).toBeGreaterThan(0)

  // Pause: the line is cut, the clip and the progress hold, nothing moves on.
  expect((await button('pause'))?.text).toBe('Pause')
  await ui.press({ key: 'pause' })
  expect(w.plays[1]!.aborted).toBe(true)
  expect((await button('pause'))?.text).toBe('Play')
  const held = await line()
  expect(held.speaking).toBe(false)
  await w.clock.advance(3000)
  expect(w.blits.length).toBe(blitsBeforePause)
  expect(w.plays).toHaveLength(2)
  expect(await line()).toEqual(held)

  // Play during the clip: the frame replays from its start and playback carries on.
  await ui.press({ key: 'pause' })
  expect((await button('pause'))?.text).toBe('Pause')
  expect(w.plays.map(p => p.frame)).toEqual([1, 2, 2])
  expect(await line()).toMatchObject({ narration: 'Second frame moves.', speaking: true })
  await w.clock.advance(LINE_MS + 600)
  expect(w.blits.length).toBe(blitsBeforePause + 9)
  expect((await line()).narration).toBe('Third frame line.')
  expect(w.plays.map(p => p.frame)).toEqual([1, 2, 2, 3])

  // A jump shows its frame at once, before any tick, and its line plays whole.
  await ui.press({ key: 'frame-2' })
  expect((await line()).narration).toBe('Second frame moves.')
  expect((await button('frame-2'))?.props.variant).toBe('primary')
  expect((await button('frame-3'))?.props.variant).toBeUndefined()
  expect(w.plays[3]!.aborted).toBe(true)
  expect(w.plays.map(p => p.frame)).toEqual([1, 2, 2, 3, 2])
  await w.clock.advance(LINE_MS - 200)
  expect(await line()).toMatchObject({ narration: 'Second frame moves.', speaking: true })
  expect(w.plays).toHaveLength(5)

  // The hotkeys the buttons carry.
  expect((await button('pause'))?.props.hotkey).toBe('p')
  for (const n of [1, 2, 3]) expect((await button(`frame-${n}`))?.props.hotkey).toBe(String(n))

  // It plays to the end and offers Replay.
  await w.clock.advance(LINE_MS + 600 + LINE_MS + 600)
  expect(await button('Replay')).toBeDefined()
  expect(await button('pause')).toBeUndefined()
  await ui.unmount()
})

test('twelve frames in a narrow pane, and the line alone off the terminal', async ($, on) => {
  const w = world(on, 1_000_000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const twelve = Array.from({ length: 12 }, (_, i) => ({ html: `<p>${i}</p>`, narration: `Line of frame ${i + 1}.` }))
  await $.tool.call({ tool: TOOL, title: 'Test', language: 'en-US', frames: twelve } as any)
  await w.clock.advance(100)

  const ui = await $.ui.mount(pane(40, 20))
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => b.key)).toEqual(['pause', ...twelve.map((_, i) => `frame-${i + 1}`)])
  expect(buttons.slice(1, 10).map(b => b.props.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  expect(buttons.slice(10).map(b => b.props.hotkey)).toEqual([undefined, undefined, undefined])
  const image = await ui.find({ type: 'Image' })
  // 40 columns less the margins, 16:9 at two rows a cell: well within 20 rows less the 10 under it.
  expect(image?.props).toMatchObject({ columns: 36, rows: 10 })
  const wrapping = (await ui.findAll({ type: 'Box' })).find(b => b.props.flexWrap === 'wrap')
  expect(wrapping?.props).toMatchObject({ width: 36, justifyContent: 'center' })
  await ui.unmount()

  // A short pane: the picture gives way to the rows under it.
  const short = await $.ui.mount(pane(100, 18))
  expect((await short.find({ type: 'Image' }))?.props.rows).toBe(8)
  await short.unmount()

  const desktop = await $.ui.mount(pane(100, 40, 'desktop'))
  expect((await desktop.find({ type: 'Text', text: /Line of frame 1/ }))?.text).toBe('Line of frame 1.')
  expect(await desktop.find({ type: 'Button' })).toBeUndefined()
  await desktop.unmount()
})
