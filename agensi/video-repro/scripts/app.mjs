// Finds the installed video-repro app and its data folder.
// App: $VIDEO_REPRO_HOME, else the global npm install (`npm i -g video-repro`).
// Data: $VIDEO_REPRO_DATA, else ~/.video-repro (same rule the server uses).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findApp() {
  if (process.env.VIDEO_REPRO_HOME) return path.resolve(process.env.VIDEO_REPRO_HOME);
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.join(root, 'video-repro');
  } catch {
    return null;
  }
}

export const APP = findApp();
if (!APP || !existsSync(path.join(APP, 'server', 'preprocess.js'))) {
  console.error('video-repro app not found. Install it with `npm i -g video-repro`, or set VIDEO_REPRO_HOME to a local checkout.');
  process.exit(1);
}

export const DATA_DIR = process.env.VIDEO_REPRO_DATA || path.join(os.homedir(), '.video-repro');
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');
export const PORT = Number(process.env.PORT) || 4320;
