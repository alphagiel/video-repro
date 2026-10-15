import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContext, fmt, ReproSchema, SYSTEM } from './analyze.js';

const TIMEOUT_MS = 15 * 60 * 1000;

const OUTPUT_SHAPE = `{
  "title": "Short Jira-style bug title",
  "summary": "One or two sentences: what the bug is",
  "preconditions": ["Account, page, data or state needed before step 1"],
  "steps": [
    { "action": "One user action, imperative, naming the exact UI element", "time_sec": 12.5, "frame": 7, "confidence": "high", "note": null }
  ],
  "expected": "...",
  "actual": "...",
  "bug_time_sec": 41.0,
  "gaps": ["..."]
}`;

// Runs the analysis through the local Claude Code login (the work Team seat), not an API key.
export async function analyzeWithClaudeCode({ jobDir, frames, idle, transcript, meta, duration }) {
  const prompt = [
    SYSTEM,
    '',
    buildContext({ idle, transcript, meta, duration }),
    '',
    `Frames (${frames.length}), in order:`,
    ...frames.map((f, i) => `Frame ${i} @ ${fmt(f.time)}: frames/${f.file}`),
    '',
    'Read every frame image in order (batch the Read calls in parallel), then write the repro steps.',
    `Write them to result.json in the current directory with exactly this shape:\n${OUTPUT_SHAPE}`,
    `"frame" is the frame number (0-${frames.length - 1}) that best shows the step. "confidence" is high, medium or low. "note" and "bug_time_sec" can be null.`,
    'Do not write any other file. Reply "done" when result.json is written.',
  ].join('\n');

  // Without these, Claude Code would bill the personal API key instead of the Team login.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const out = await new Promise((resolve, reject) => {
    const p = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--restricted',
      '--strict-mcp-config',
      '--allowedTools', 'Read', 'Write',
      '--permission-mode', 'acceptEdits',
      '--no-session-persistence',
    ], { cwd: jobDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${(stderr || stdout).slice(-600)}`));
      else resolve(stdout);
    });
  });

  let summary = {};
  try { summary = JSON.parse(out); } catch {}
  if (summary.is_error) throw new Error(`Claude Code failed: ${summary.result || 'unknown error'}`);

  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(jobDir, 'result.json'), 'utf8'));
  } catch {
    throw new Error(`Claude Code didn't write a valid result.json (it said: ${String(summary.result || '').slice(0, 200)})`);
  }
  const parsed = ReproSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`result.json has the wrong shape: ${parsed.error.issues[0]?.message}`);
  const bad = parsed.data.steps.find((s) => !Number.isInteger(s.frame) || s.frame < 0 || s.frame >= frames.length);
  if (bad) throw new Error(`result.json points at frame ${bad.frame}, but there are only ${frames.length}`);

  const u = summary.usage || {};
  return {
    result: parsed.data,
    usage: {
      input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      output_tokens: u.output_tokens || 0,
      // What it would cost at API prices. The Team seat isn't billed per token; this just shows how big the run was.
      cost_usd: summary.total_cost_usd ?? null,
      duration_ms: summary.duration_ms ?? null,
      turns: summary.num_turns ?? null,
    },
  };
}
