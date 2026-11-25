import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { extractModelResponse, readLatestModelResponse } from '../src/hooks/transcript.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fsp.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('Antigravity transcript extraction', () => {
  it('recognizes the live PLANNER_RESPONSE record shape', () => {
    expect(
      extractModelResponse({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Silver compass hook probe finished.',
      })
    ).toBe('Silver compass hook probe finished.');
  });

  it('ignores user and unfinished model records', () => {
    expect(
      extractModelResponse({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Ignore me.' })
    ).toBeNull();
    expect(
      extractModelResponse({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'RUNNING', content: 'Partial.' })
    ).toBeNull();
  });

  it('reads backward and returns the newest completed model response', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'voice-hook-transcript-'));
    temporaryDirectories.push(directory);
    const transcript = path.join(directory, 'transcript_full.jsonl');
    const records = [
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Question' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'First response.' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Final response.' },
    ];
    await fsp.writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    await expect(readLatestModelResponse(transcript)).resolves.toBe('Final response.');
  });

  it('returns null for a missing or malformed transcript', async () => {
    await expect(readLatestModelResponse('/missing/transcript.jsonl')).resolves.toBeNull();
  });
});
