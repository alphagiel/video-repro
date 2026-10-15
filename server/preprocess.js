import { spawn } from 'node:child_process';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

// Upper bound on frames sent to Claude (API caps images per request).
const MAX_FRAMES = 60;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function probe(videoPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    videoPath,
  ]);
  const info = JSON.parse(stdout);
  return {
    duration: Number(info.format?.duration) || 0,
    hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

// Spans where the screen doesn't change for 2s+.
export async function detectIdle(videoPath, duration) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', videoPath,
    '-map', '0:v:0', '-vf', 'freezedetect=n=0.003:d=2',
    '-f', 'null', '-',
  ]);
  const spans = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/freeze_start: ([\d.]+)/);
    const e = line.match(/freeze_end: ([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) {
      spans.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) spans.push({ start, end: duration });
  return spans;
}

// Rough speech check: how much of the audio isn't silence.
export async function detectSpeech(videoPath, duration) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', videoPath,
    '-map', '0:a:0', '-af', 'silencedetect=noise=-35dB:d=0.75',
    '-f', 'null', '-',
  ]);
  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Number(s[1]);
    if (e && start !== null) {
      silences.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) silences.push({ start, end: duration });
  const silent = silences.reduce((sum, x) => sum + (x.end - x.start), 0);
  const speechSec = Math.max(0, duration - silent);
  return { speechSec, hasSpeech: speechSec > 2 && speechSec / (duration || 1) > 0.05 };
}

// Keep a frame only when the screen actually changed (max 2/sec), then cap the count.
export async function extractFrames(videoPath, outDir) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-i', videoPath,
    '-vf', "fps=2,mpdecimate=hi=768:lo=320:frac=0.33,scale='min(1280,iw)':-2,showinfo",
    '-fps_mode', 'vfr', '-q:v', '4',
    path.join(outDir, 'f_%04d.jpg'),
  ]);
  const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const files = (await readdir(outDir)).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
  const frames = files.map((file, i) => ({ file, time: times[i] ?? 0 }));
  const kept = capFrames(frames);
  const keep = new Set(kept.map((f) => f.file));
  await Promise.all(files.filter((f) => !keep.has(f)).map((f) => unlink(path.join(outDir, f))));
  return kept;
}

function capFrames(frames) {
  if (frames.length <= MAX_FRAMES) return frames;
  const step = (frames.length - 1) / (MAX_FRAMES - 1);
  return Array.from({ length: MAX_FRAMES }, (_, i) => frames[Math.round(i * step)]);
}

export async function extractAudio(videoPath, wavPath) {
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', videoPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
  ]);
}

export { run };
