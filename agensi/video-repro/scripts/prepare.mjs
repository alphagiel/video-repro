// Usage: node prepare.mjs <video> [description] [env] [role]
// Chops the video with the video-repro app's ffmpeg code and creates a job the web page can show.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP, JOBS_DIR } from './app.mjs';

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch {
  console.error('ffmpeg not found. Install it (macOS: `brew install ffmpeg`) and retry.');
  process.exit(1);
}

const load = (f) => import(pathToFileURL(path.join(APP, 'server', f)).href);
const { probe, detectIdle, detectSpeech, extractFrames } = await load('preprocess.js');
const { transcribe, whisperAvailable } = await load('transcribe.js');

const [arg, description = '', env = '', role = ''] = process.argv.slice(2);
if (!arg) {
  console.error('Usage: node prepare.mjs <video> [description] [env] [role]');
  process.exit(1);
}

// macOS screen recordings use a narrow no-break space before AM/PM; typed paths have a normal space.
const candidates = [arg, arg.replace(/ (AM|PM|am|pm)\b/g, ' $1')];
const src = candidates.find((p) => existsSync(p));
if (!src) {
  console.error(`Video not found: ${arg}`);
  process.exit(1);
}

const id = randomUUID();
const jobDir = path.join(JOBS_DIR, id);
await mkdir(path.join(jobDir, 'frames'), { recursive: true });
const ext = path.extname(src).toLowerCase() || '.mp4';
const videoPath = path.join(jobDir, `video${ext}`);
await copyFile(src, videoPath);

const { duration, hasAudio } = await probe(videoPath);
const idle = await detectIdle(videoPath, duration);
const frames = await extractFrames(videoPath, path.join(jobDir, 'frames'));

let transcript = null;
let audio = 'none';
if (hasAudio) {
  const { hasSpeech } = await detectSpeech(videoPath, duration);
  if (hasSpeech && whisperAvailable()) {
    transcript = await transcribe(videoPath, jobDir);
    audio = 'transcribed';
  } else {
    audio = hasSpeech ? 'speech-skipped' : 'silent';
  }
}

const job = {
  id,
  status: 'running',
  stage: 'Claude Code is analyzing',
  source: 'claude-code',
  createdAt: new Date().toISOString(),
  video: `/files/${id}/video${ext}`,
  fileName: path.basename(src),
  meta: { description, env, role },
  duration,
  audio,
  frames,
  idle,
  transcript,
};
await writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));

console.log(JSON.stringify({
  id,
  jobDir,
  duration,
  audio,
  meta: job.meta,
  idle,
  transcript,
  frames: frames.map((f, i) => ({ index: i, time: f.time, path: path.join(jobDir, 'frames', f.file) })),
}, null, 2));
