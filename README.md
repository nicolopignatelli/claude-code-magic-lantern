# magic-lantern

A mod for [Claude Code](https://claude.com/claude-code) that lets Claude **project short
narrated slideshows** in a pane beside the conversation. A few frames come up in order, a
voice speaks over each one, and some of them move. You watch and listen at the same time:
the voice carries the sentences, so the screen holds only what has to be seen.

Named after the magic lantern, the projector of painted slides shown in the dark while a
narrator told the story, some slides with moving parts.

## When Claude projects

The mod's skill tells Claude when a projection is worth it: when it has to

- show you what changed in something you look at, before you have seen it yourself;
- walk you through how something moves through a process, step by step;
- explain why something happened, when the reason is a chain of several steps;
- bring you back up to speed on work you have been away from;
- introduce you to an area of the work you have not been in before;
- recap what a long working session changed, and why;
- show something that only makes sense in motion;
- present the findings of an investigation you handed off;
- compare how something is done here with how others do it.

You can always ask for one ("walk me through how the import works", "catch me up on the
billing work"). Claude may also project without being asked when it recognises one of these
moments, and says so in one line when it does. A question a sentence answers gets a
sentence.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install magic-lantern --marketplace nicolopignatelli/claude-code-magic-lantern
```

Answer `y` to add the marketplace, then press Enter to install at the user scope. The mod
is active right away, and in every session you start after that.

From a shell instead:

```
claude plugin install magic-lantern --marketplace nicolopignatelli/claude-code-magic-lantern
```

**What it needs:**

- **macOS**, for the voice: narration is spoken with the system's own voices (`say`), in
  the default voice macOS keeps for the narration's language.
- **Google Chrome or Chromium**, to render the frames Claude composes.
- **ffmpeg**, for moving frames only (`brew install ffmpeg`). Still frames work without it.
- **A terminal that draws pictures** with the kitty graphics protocol: kitty or Ghostty.
  tmux blocks pictures. Elsewhere the pane shows the spoken lines alone.

## The pane

The pane opens beside the conversation. Each frame is shown centred, with its line as a
subtitle underneath and one progress segment per frame; the current segment fills as its
line is spoken. A single moving frame gets one longer bar instead, like a video's.

After the last frame the pane stays open on it, with **Replay** and **Close**. Closing the
pane, with the button, `esc` or its ×, stops the voice at once. The buttons' hotkeys (`r`
for Replay) work once the pane has the keyboard: click it, or press ctrl+x then tab.

Claude Code opens a pane nobody asked for only in a terminal at least 144 columns wide. In a
narrower one the slides wait, and Claude asks you to run **`/magic-lantern`**, which opens
the pane at any width and starts the projection.

The tool call itself does not appear in the conversation: the pane is what you watch.
Press ctrl+o to see the call in full.

## Moving frames

A frame can move for up to 4 seconds: Claude animates it with CSS, and the mod captures it
frame by frame and swaps the pictures in the pane while the line is spoken. 30 frames a
second holds up well; 60 is best effort. Moving frames are captured at most about 916×515
pixels, which keeps each picture under 2 MiB: terminals drawn with the Iced UI library show
nothing in place of a larger picture while it uploads, which flickers on every swap.

After a moving frame has played, the mod writes `clip-<frame>-stats.json` beside its
frames: pictures sent, taken and refused, and the frame rate reached.

## What it writes

Each projection writes its files to `magic-lantern/<call id>/` in your system's temp folder
(`$TMPDIR`): each frame's HTML and rendered PNG, the captured pictures of moving frames,
and each line spoken to a WAV file. The mod sends nothing anywhere: Chrome renders the
markup from that folder and loads only what the markup itself references.

## Limits

- **macOS only.** The voice for a narration's language comes from macOS; on other systems
  the mod finds none and refuses to project.
- **One projection at a time.** A new one replaces the one in the pane.
- **The mod API is early access.** This version was built with Claude Code 2.1.308, and
  the API may change between releases.

## Development

```
git clone https://github.com/nicolopignatelli/claude-code-magic-lantern
cd claude-code-magic-lantern
claude --plugin-dir .          # a session with the mod loaded from this folder; edits reload it
claude plugin validate .       # what Claude Code reads from the manifest, hooks and marketplace
```

Once a session has loaded the mod, Claude Code writes its type declarations to
`.claude-plugin/types/`, and `tsc -p .` type-checks the mod against them.

| File | What it does |
|---|---|
| `hooks/register.tsx` | Registers the `project` tool and `/magic-lantern`, renders frames with Chrome, speaks the lines, plays them in the pane |
| `skills/magic-lantern/SKILL.md` | When a projection is worth it, and when it is not |

## License

MIT, see [LICENSE](LICENSE).
