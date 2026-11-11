---
name: video-repro
description: Turn a screen recording of a bug (e.g. a QA video attached to a ticket) into repro steps, analyzed by Claude Code itself (no API key), and shown in the local video-repro web page with the video player, clickable timestamps and frame thumbnails. Use when the user says /video-repro, "get repro steps from this video", "what are the steps in this bug video", or hands over a bug recording.
---

# Video Repro

The agent does the analysis itself, no API key needed. The local video-repro app only chops the video (ffmpeg) and displays the result. Never call the Anthropic API or start the app's upload flow for this.

## Setup (once)

- Node 20+
- ffmpeg on PATH (macOS: `brew install ffmpeg`)
- The app: `npm i -g video-repro`
- Optional: whisper.cpp (`whisper-cli` on PATH, `WHISPER_MODEL` set to a ggml model file) to transcribe narrated videos
- Optional env vars: `VIDEO_REPRO_HOME` (use a local checkout instead of the global install), `VIDEO_REPRO_DATA` (job folder, default `~/.video-repro`), `PORT` (default `4320`)

If a script says the app or ffmpeg is missing, tell the user the exact install command and stop.

Args: `<video path> ["one-line bug description"] [env] [role]`. Missing description/env/role is fine; don't ask for them unless the video is unreadable without context.

## 1. Prepare

```
node <skill dir>/scripts/prepare.mjs "<video>" "<description>" "<env>" "<role>"
```

- `<skill dir>` is the folder this SKILL.md lives in.
- `Operation not permitted` means macOS is blocking that folder (usually Downloads). Ask the user to move the video to the Desktop, then retry.
- The output is JSON: job `id`, `jobDir`, `duration`, `idle` spans, `transcript` (null when silent) and `frames` (each with `index`, `time`, `path`).

## 2. Look at every frame

Read each frame image in index order. Batch the Read calls in parallel. Frames were only kept when the screen changed, so a jump between frames means something happened.

## 3. Write the steps

Rules:
- Infer each action from what changed between frames: a new page, an opened menu, a filled field, a toast, a modal.
- Name exact UI labels, page titles, URLs and values you can read on screen.
- Merge noise (mouse wandering, scrolling to find something) into the real action. Skip actions that don't matter for the bug.
- Never invent what you can't see. If something must have happened but isn't visible (typed value, hidden click, state from before recording), write the step anyway, mark it `low` and say why in `note`.
- An idle span matters only if the wait itself might be part of the bug (slow load, timeout); then mention it in the step's `note`.
- If narration and the screen disagree, trust the screen and note the conflict.
- Anything a dev would need but the video doesn't show (account, role, data, browser) goes in `gaps`.

Write `<jobDir>/result.json` with exactly this shape:

```json
{
  "title": "Short bug-ticket-style title",
  "summary": "One or two sentences: what the bug is",
  "preconditions": ["Account, page, data or state needed before step 1"],
  "steps": [
    { "action": "One user action, imperative, naming the exact UI element", "time_sec": 12.5, "frame": 7, "confidence": "high", "note": null }
  ],
  "expected": "...",
  "actual": "...",
  "bug_time_sec": 41.0,
  "gaps": ["..."]
}
```

`frame` is the frame `index` that best shows the step. `confidence` is `high`, `medium` or `low`. `note` and `bug_time_sec` can be `null`.

## 4. Finish

```
node <skill dir>/scripts/finish.mjs <id> <jobDir>/result.json
```

- If it prints problems, fix `result.json` and rerun.
- If it says `server: not running`, start it in the background with `video-repro`, then share the link.

## 5. Reply

Keep it short: the link, the title, the step count, and how many steps are medium or low confidence. Don't paste all the steps in chat; they're on the page.
