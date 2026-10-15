import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractAudio, run } from './preprocess.js';

// Local whisper.cpp. Set WHISPER_MODEL to a ggml model file to turn it on.
const WHISPER_CMD = process.env.WHISPER_CMD || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL;

export function whisperAvailable() {
  return Boolean(WHISPER_MODEL && existsSync(WHISPER_MODEL));
}

export async function transcribe(videoPath, jobDir) {
  const wav = path.join(jobDir, 'audio.wav');
  const outBase = path.join(jobDir, 'transcript');
  await extractAudio(videoPath, wav);
  await run(WHISPER_CMD, ['-m', WHISPER_MODEL, '-f', wav, '-oj', '-of', outBase, '-np']);
  const json = JSON.parse(await readFile(`${outBase}.json`, 'utf8'));
  return (json.transcription || [])
    .map((seg) => ({
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      text: seg.text.trim(),
    }))
    .filter((seg) => seg.text && !/^\[.*\]$/.test(seg.text)); // drop [BLANK_AUDIO] etc
}
