# Promo video

A 44-second promo video for Checklist Bridge, made entirely with code: the picture, the music and the sound effects. There are two versions:

| File | Size | For |
|---|---|---|
| `output/checklist-bridge-promo-vertical.mp4` | 1080×1920 | LinkedIn on mobile, Instagram Reels, YouTube Shorts, TikTok |
| `output/checklist-bridge-promo-square.mp4` | 1080×1080 | LinkedIn and X feeds |
| `output/cover-vertical.jpg`, `output/cover-square.jpg` | | Thumbnails (the end card) |

Nothing in `promo/` goes into the extension: the `.vsix` only packs `dist/`, `media/` and a few top-level files.

## Make it again

```
bash promo/video/make.sh
```

This takes about 6 minutes. It builds the extension, renders both videos, makes the soundtrack, and writes the results to `output/`.

You need:
- Node.js and the repo's dev dependencies (`npm ci`), plus Playwright's Chromium (`npx playwright install chromium`). To use a Chromium you already have, set `CHROMIUM_PATH` to its path.
- Python 3 with `numpy` and `scipy` (`pip install numpy scipy`). `make-shot.py` also needs Pillow.
- `ffmpeg`.
- The **Inter** and **JetBrains Mono** fonts. Without them, the video falls back to other fonts and looks different.

### Steps one at a time

```
npm run build                                    # the video uses the compiled dist/model.js
node promo/video/render.js vertical              # -> build/video-vertical.mp4 (no sound) and build/events.json
node promo/video/render.js square                # -> build/video-square.mp4
python3 promo/video/audio.py                     # -> build/audio.wav, from build/events.json
```

Then put each video and the sound together with `ffmpeg` (see `make.sh`).

To check a change quickly, render a few still frames instead of the whole video:

```
node promo/video/render.js vertical --preview 5,13,22.5,30
```

This writes `build/prev-vertical-<time>.jpg` in a few seconds.

## Files

| File | What it does |
|---|---|
| `render.js` | The script: captions, camera moves, chat messages and every click and keystroke, with times. Runs the real panel in Chromium and records it frame by frame. |
| `stage.js` | Runs inside the page. Draws everything that isn't the panel: the background, the VS Code window, the Claude chat, captions, the cursor and the end card. |
| `audio.py` | Makes the music and the sound effects from scratch and mixes them. |
| `make-shot.py` | Draws `shot.png`, the dashboard screenshot that gets pasted into a task's note. It's a plain made-up dashboard, not a real brand. |
| `make.sh` | Runs everything in order. |
| `prompt.md` | The written brief for the video. Paste it into an AI video tool if you want a different take. |

## How it works

**The checklist is real.** `render.js` loads `media/panel.js` and `media/panel.css` into a frame, exactly as VS Code does, and drives it with the real `ChecklistStore` from `dist/model.js`. Claude's tool calls (`checklist_add_tasks`, `checklist_read`, `checklist_ask`) are run against the store. Clicks, typing and pasting happen on the real panel. The panel's messages are handled the same way `src/panels.ts` handles them. So the video shows what the extension actually does.

**Every frame is the same every time.** The page's clock is faked with Playwright's `page.clock`. Each frame, the clock moves forward 1/30 of a second, and every CSS animation is paused and set to the right time. So the panel's own animations (tasks sliding in, the tick mark, the progress bar) play smoothly, and a re-render gives the same video.

**The sound follows the picture.** `render.js` writes the time of every click, tick, keystroke, new task, paste and Share to `build/events.json`. `audio.py` puts a sound on each one. The music is a lo-fi loop at 90 BPM in F major (Fmaj9, Em7, Dm9, Cmaj9) with electric piano, a pad, bass and soft drums. Scene changes fall on bar lines, so the drums come in exactly when the checklist appears (8 s). The first 8 seconds are muffled, as if lost in the scroll. The mix ends at about -14 dB, a normal level for social video.

## The script

Captions are burned in, because most people watch muted. There is no voiceover.

| Time | On screen | Caption |
|---|---|---|
| 0–4 s | Someone scrolls fast up a long Claude chat | Wait… what did Claude ask me to do? |
| 4–8 s | The steps buried in one message light up, lift off as cards and blur away | Manual steps get lost in the chat. |
| 8–10 s | A new chat: "Add Stripe billing with a Pro plan" | There's a better way. |
| 10–13 s | Claude replies, and the checklist slides in next to the chat, one task at a time | Checklist Bridge gives every Claude chat its own checklist. |
| 13–19 s | Claude adds an urgent task. It jumps to the top and turns red. The cursor clicks Copy on its command. | The next task is always on top. / Urgent ones jump the queue and turn red. |
| 19–24 s | Tick the task, type a note, paste a screenshot, press Share as done | Tick it. Add a note. Press Share. / Paste a screenshot if it helps. |
| 24–27 s | In the chat, Claude reads the shared task and its screenshot | Claude only sees what you share. / It never assumes you did something you didn't. |
| 27–35 s | Claude asks "Should the free trial ask for a card?" in Decide and carries on writing the webhook. The cursor picks Claude's suggestion and presses Share answer. | Decide later. Claude keeps working. / Questions wait in Decide with Claude's pick. |
| 35–44 s | End card: icon, name, tagline, "Free", "Open source", "macOS · Windows · Linux", and someone typing "Checklist Bridge" into the VS Code extensions search | |

To change something:
- **Captions:** `CAPTIONS` in `render.js` (`a` and `b` are the start and end times in seconds).
- **Chat messages:** `CHAT` in `render.js`.
- **Tasks and the question:** `TASKS`, and the `checklist_add_tasks` and `checklist_ask` calls in `render.js`.
- **Camera:** `CAMERA` in `render.js` (time, what to frame, how long the move takes). The square version adds a few extra moves so the work stays in view.
- **End card text:** the `#end` block in `render.js`.
- **Music:** `CHORDS`, `ORDER` and the drum pattern in `audio.py`. The mix levels are on the `music = …` line.

If you change times, render the audio again (`audio.py`) so the sounds still line up.

## Posting it

A caption you can use:

> AI coding agents are great until they say "now go create an API key" and that step gets lost 300 messages up.
>
> I built Checklist Bridge, a free VS Code extension that gives every Claude Code chat its own checklist. Claude adds the manual tasks. You tick them off, add a note or screenshot, and share. Claude only sees what you've shared.
>
> Free and open source. Search "Checklist Bridge" in VS Code.
> github.com/Akshat270/checklist-bridge
>
> #ClaudeCode #VSCode #AI #DeveloperTools #OpenSource #BuildInPublic

Tips:
- Upload the vertical file for LinkedIn on mobile and Reels or Shorts, and the square file for feeds that crop vertical video.
- Use a cover image as the thumbnail.
- Listen once before posting. The audio was checked with a spectrogram and level readings, not by ear.
- The video says "Not affiliated with Anthropic" and doesn't use Anthropic's logo. Keep it that way if you edit it.
