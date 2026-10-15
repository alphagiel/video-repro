import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.js';
import { analyzeWithClaudeCode } from './claudeCode.js';
import { detectIdle, detectSpeech, extractFrames, probe } from './preprocess.js';
import { transcribe, whisperAvailable } from './transcribe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS_DIR = path.join(ROOT, 'data', 'jobs');
const PORT = Number(process.env.PORT) || 4320;

await mkdir(JOBS_DIR, { recursive: true });

const upload = multer({
  dest: path.join(ROOT, 'data', 'uploads'),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

// In-memory job state; finished results are also written to disk.
const jobs = new Map();

async function runJob(job, videoPath) {
  const jobDir = path.join(JOBS_DIR, job.id);
  const set = (stage) => {
    job.stage = stage;
    console.log(`[${job.id.slice(0, 8)}] ${stage}`);
  };
  try {
    set('Reading video');
    const { duration, hasAudio } = await probe(videoPath);
    job.duration = duration;

    set('Finding idle stretches');
    const idle = await detectIdle(videoPath, duration);

    set('Pulling frames where the screen changes');
    await mkdir(path.join(jobDir, 'frames'));
    const frames = await extractFrames(videoPath, path.join(jobDir, 'frames'));

    let transcript = null;
    job.audio = 'none';
    if (hasAudio) {
      set('Checking for narration');
      const { hasSpeech } = await detectSpeech(videoPath, duration);
      if (hasSpeech && whisperAvailable()) {
        set('Transcribing narration');
        transcript = await transcribe(videoPath, jobDir);
        job.audio = 'transcribed';
      } else {
        job.audio = hasSpeech ? 'speech-skipped' : 'silent';
      }
    }

    const input = { jobDir, frames, idle, transcript, meta: job.meta, duration };
    let result, usage;
    if (job.source === 'claude-code') {
      set(`Claude Code (work seat) is reading ${frames.length} frames`);
      ({ result, usage } = await analyzeWithClaudeCode(input));
    } else {
      set(`Asking Claude via API key (${frames.length} frames)`);
      ({ result, usage } = await analyze(input));
    }

    Object.assign(job, { status: 'done', stage: 'Done', frames, idle, transcript, result, usage });
    await writeFile(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
    console.log(`[${job.id.slice(0, 8)}] done via ${job.source}`, usage);
  } catch (err) {
    console.error(`[${job.id.slice(0, 8)}] failed:`, err);
    Object.assign(job, { status: 'error', error: err.message });
  }
}

// Opus 5.5 API prices, per token.
const PRICE_IN = 4 / 1e6;
const PRICE_OUT = 20 / 1e6;

// One shape for both engines (and for older runs saved before cost tracking).
function usageSummary(job) {
  const u = job.usage;
  if (!u || u.input_tokens == null) return null;
  const inTok = u.input_tokens + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const cost = u.cost_usd ?? (job.source === 'claude-code' ? null : inTok * PRICE_IN + outTok * PRICE_OUT);
  return { input_tokens: inTok, output_tokens: outTok, cost_usd: cost, billed: job.source !== 'claude-code' };
}

const app = express();
app.use(express.static(path.join(ROOT, 'web')));
app.use('/files', express.static(JOBS_DIR));

app.post('/api/jobs', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });
  const id = randomUUID();
  const jobDir = path.join(JOBS_DIR, id);
  await mkdir(jobDir);
  // multer decodes filenames as latin1; macOS names have UTF-8 chars (e.g. the narrow space before "am")
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(fileName).toLowerCase() || '.mp4';
  const videoPath = path.join(jobDir, `video${ext}`);
  await rename(req.file.path, videoPath);

  const job = {
    id,
    status: 'running',
    stage: 'Queued',
    source: req.body.engine === 'api' ? 'api' : 'claude-code',
    createdAt: new Date().toISOString(),
    video: `/files/${id}/video${ext}`,
    fileName,
    meta: {
      description: req.body.description?.trim() || '',
      env: req.body.env?.trim() || '',
      role: req.body.role?.trim() || '',
    },
  };
  jobs.set(id, job);
  runJob(job, videoPath);
  res.json({ id });
});

// Newest first. Running jobs come from memory, finished ones from disk.
app.get('/api/jobs', async (req, res) => {
  const list = new Map();
  for (const id of await readdir(JOBS_DIR)) {
    try {
      list.set(id, JSON.parse(await readFile(path.join(JOBS_DIR, id, 'job.json'), 'utf8')));
    } catch {
      // folder without job.json yet (still processing, or broken)
    }
  }
  for (const [id, job] of jobs) list.set(id, job);
  const runs = [...list.values()]
    .map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      fileName: j.fileName,
      duration: j.duration ?? null,
      title: j.result?.title ?? null,
      steps: j.result?.steps.length ?? null,
      source: j.source ?? 'api',
      usage: usageSummary(j),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(runs);
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) return res.json({ ...job, usageSummary: usageSummary(job) });
  try {
    const saved = JSON.parse(await readFile(path.join(JOBS_DIR, path.basename(req.params.id), 'job.json'), 'utf8'));
    res.json({ ...saved, usageSummary: usageSummary(saved) });
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.delete('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Bad job id' });
  if (jobs.get(id)?.status === 'running') return res.status(409).json({ error: 'Still running' });
  jobs.delete(id);
  await rm(path.join(JOBS_DIR, id), { recursive: true, force: true });
  console.log(`[${id.slice(0, 8)}] deleted`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`video-repro on http://localhost:${PORT}`);
  console.log(`whisper: ${whisperAvailable() ? 'on' : 'off (set WHISPER_MODEL to enable)'}`);
});
