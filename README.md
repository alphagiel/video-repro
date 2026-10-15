# video-repro

Drop in a QA bug recording, get back step-by-step repro steps with timestamps and screenshots.

<!-- DEMO: drop a GIF or video link here, e.g.
![demo](docs/demo.gif)
-->
> 🎬 **Demo video coming soon.**

## What you get

- **Numbered repro steps**, each with the moment in the video, a screenshot, and a high / medium / low confidence tag
- **Expected vs actual**, plus a list of things the video couldn't show (account, data, browser...)
- **Click a step to jump the video** to that moment
- **Copy as Jira markdown** in one click
- **Past runs** saved locally, with a delete button and the token usage for each run

Works on silent recordings. If the tester talks, that can be used too (see [Narration](#narration-optional)).

## Setup

You need:

- **Node 20+**
- **ffmpeg**: `brew install ffmpeg`
- One of these to do the analysis:
  - **Claude Code** installed and logged in (`claude` in your terminal). This is the default.
  - **or** an `ANTHROPIC_API_KEY` in your environment

Then:

```bash
git clone git@github.com:alphagiel/video-repro.git
cd video-repro
npm install
npm start
```

Open **http://localhost:4320**.

## How to use it

1. Drop a screen recording on the page
2. Optional but helps a lot: describe the bug in one line, or paste the whole Jira ticket
3. Fill in environment and account/role if you know them
4. Pick what runs the analysis (see below) and hit **Generate repro steps**

A 20 to 60 second video usually takes under a minute.

### Work seat vs API key

| | Work seat (default) | Personal API key |
|---|---|---|
| Runs on | Your Claude Code login | `ANTHROPIC_API_KEY` |
| Cost | Counts toward your seat's usage limits | Billed per run (~$0.40 for a 60-frame video) |
| Use it for | Work videos, to keep them in the work account | Personal stuff, or no Claude Code |

The work seat runs Claude Code in a locked-down mode: no shell, no web, no MCP servers, and it can only touch that run's folder. The app hides `ANTHROPIC_API_KEY` from it so it always uses your login.

## How it works

```
video ─┬─ ffprobe: length, audio track?
       ├─ freezedetect: spans where nothing happens (2s+)
       ├─ mpdecimate: keep a frame only when the screen changes (max 2/sec, capped at 60)
       └─ silencedetect → Whisper (only if someone talks and Whisper is set up)
                    │
       frames + timestamps + idle spans + transcript + your description
                    │
              Claude → repro steps as JSON → results page
```

Everything for a run lives in `data/jobs/<id>/`: the video, the frames that were used, and `job.json` with the result. That folder is git-ignored. Delete a run from the page, or just delete its folder.

## Narration (optional)

Off by default. To turn it on, install whisper.cpp and point it at a model:

```bash
brew install whisper-cpp
mkdir -p ~/models
curl -L -o ~/models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
WHISPER_MODEL=~/models/ggml-base.en.bin npm start
```

## Config

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `4320` | Port for the web page |
| `ANTHROPIC_API_KEY` | none | Needed only for the API key option |
| `WHISPER_MODEL` | none | Path to a whisper.cpp model; turns narration on |
| `WHISPER_CMD` | `whisper-cli` | whisper.cpp binary name |

## Tips for QA

- **Start recording before reproducing**, not after. Steps that happened before recording can only be guessed.
- **Keep DevTools Network open** if it's an API bug. The status codes and URLs end up in the steps.
- Turn on **click highlighting** in your recorder if it has one.

## Roadmap

- [ ] **Auto-verify**: replay the steps on staging with Playwright and confirm the bug shows up
- [ ] **Push to Jira**: create the ticket straight from the results page
- [ ] **Model picker** for the API option (Sonnet / Haiku to cut cost)
- [ ] **Better idle detection**: typing currently counts as "nothing happening"
- [ ] **Clear the form** when a new video is picked, so an old ticket doesn't get reused
- [ ] **Auto-delete** runs older than N days
- [ ] **Loom links** as input, not just file uploads
- [ ] Tests for the frame pipeline and result validation
