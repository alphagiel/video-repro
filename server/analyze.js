import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const client = new Anthropic();

export const ReproSchema = z.object({
  title: z.string().describe('Short bug title, Jira style'),
  summary: z.string().describe('One or two sentences: what the bug is'),
  preconditions: z.array(z.string()).describe('Account, page, data or state needed before step 1'),
  steps: z.array(
    z.object({
      action: z.string().describe('One user action, imperative, naming the exact UI element'),
      time_sec: z.number().describe('When in the video this action happens'),
      frame: z.number().describe('Frame number that best shows this step'),
      confidence: z.enum(['high', 'medium', 'low']),
      note: z.string().nullable().describe('Why confidence is not high, or a wait that matters'),
    }),
  ),
  expected: z.string(),
  actual: z.string(),
  bug_time_sec: z.number().nullable().describe('When the bug is visible in the video'),
  gaps: z.array(z.string()).describe('Things the video could not show that a dev would need to know'),
});

export const SYSTEM = `You turn screen recordings of software bugs into reproduction steps a developer can follow.

You get frames from the video in order, each with its timestamp. Frames were only kept when the screen changed, so a jump between frames means something happened. Idle spans (screen frozen 2s+) are listed separately. A narration transcript is included when the tester talked.

Rules:
- Infer each action from what changed between frames: a new page, an opened menu, a filled field, a toast, a modal.
- Name exact UI labels, page titles, URLs and values you can read on screen.
- Merge noise (mouse wandering, scrolling to find something) into the real action. Skip actions that don't matter for the bug.
- Never invent what you can't see. If something must have happened but isn't visible (typed value, hidden click, state from before recording), write the step anyway, mark it low confidence and say why in the note.
- An idle span matters only if the wait itself might be part of the bug (slow load, timeout); then mention it in the step note.
- If narration and the screen disagree, trust the screen and note the conflict.
- Put anything a dev would need but the video doesn't show (account, role, data, browser) in gaps.`;

export const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

export function buildContext({ idle, transcript, meta, duration }) {
  return [
    `Video length: ${fmt(duration)}`,
    `Tester's description: ${meta.description || '(none)'}`,
    `Environment: ${meta.env || '(not given)'}`,
    `Account / role: ${meta.role || '(not given)'}`,
    '',
    idle.length
      ? `Idle spans:\n${idle.map((s) => `- ${fmt(s.start)} to ${fmt(s.end)} (${(s.end - s.start).toFixed(1)}s)`).join('\n')}`
      : 'Idle spans: none',
    '',
    transcript
      ? `Narration:\n${transcript.map((s) => `[${fmt(s.start)}] ${s.text}`).join('\n')}`
      : 'Narration: none (silent recording)',
  ].join('\n');
}

export async function analyze({ jobDir, frames, idle, transcript, meta, duration }) {
  const content = [{ type: 'text', text: buildContext({ idle, transcript, meta, duration }) }];
  for (const [i, f] of frames.entries()) {
    const data = (await readFile(path.join(jobDir, 'frames', f.file))).toString('base64');
    content.push({ type: 'text', text: `Frame ${i} @ ${fmt(f.time)}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }
  content.push({ type: 'text', text: 'Write the repro steps for this bug.' });

  const response = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'high', format: zodOutputFormat(ReproSchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined: ${response.stop_details?.explanation || 'no reason given'}`);
  }
  if (!response.parsed_output) {
    throw new Error(`No usable output (stop_reason: ${response.stop_reason})`);
  }
  return { result: response.parsed_output, usage: response.usage };
}
