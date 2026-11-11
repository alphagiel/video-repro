// Usage: node finish.mjs <job id> <result.json>
// Checks the result has the shape the web page expects, saves it on the job, prints the link.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JOBS_DIR, PORT } from './app.mjs';

const [id, resultPath] = process.argv.slice(2);
const jobFile = path.join(JOBS_DIR, path.basename(id || ''), 'job.json');

const job = JSON.parse(await readFile(jobFile, 'utf8'));
const result = JSON.parse(await readFile(resultPath, 'utf8'));

const problems = [];
const str = (v) => typeof v === 'string';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const strList = (v) => Array.isArray(v) && v.every(str);
if (!str(result.title)) problems.push('title must be a string');
if (!str(result.summary)) problems.push('summary must be a string');
if (!strList(result.preconditions)) problems.push('preconditions must be a string array');
if (!str(result.expected)) problems.push('expected must be a string');
if (!str(result.actual)) problems.push('actual must be a string');
if (!(result.bug_time_sec === null || num(result.bug_time_sec))) problems.push('bug_time_sec must be a number or null');
if (!strList(result.gaps)) problems.push('gaps must be a string array');
if (!Array.isArray(result.steps) || !result.steps.length) problems.push('steps must be a non-empty array');
else result.steps.forEach((s, i) => {
  if (!str(s.action)) problems.push(`steps[${i}].action must be a string`);
  if (!num(s.time_sec)) problems.push(`steps[${i}].time_sec must be a number`);
  if (!Number.isInteger(s.frame) || s.frame < 0 || s.frame >= job.frames.length) problems.push(`steps[${i}].frame must be 0-${job.frames.length - 1}`);
  if (!['high', 'medium', 'low'].includes(s.confidence)) problems.push(`steps[${i}].confidence must be high|medium|low`);
  if (!(s.note === null || str(s.note))) problems.push(`steps[${i}].note must be a string or null`);
});

if (problems.length) {
  console.error(`Result is invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

Object.assign(job, { status: 'done', stage: 'Done', result });
await writeFile(jobFile, JSON.stringify(job, null, 2));

let up = false;
try { up = (await fetch(`http://localhost:${PORT}/`)).ok; } catch {}
console.log(`http://localhost:${PORT}/#${job.id}`);
console.log(up ? 'server: running' : 'server: not running');
