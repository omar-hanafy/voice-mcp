import { describe, expect, it } from 'vitest';

import {
  cleanForSpeech,
  SPOKEN_SUMMARY_MAX_CHARS,
  summarizeForSpeech,
} from '../src/hooks/summary.js';

describe('hook spoken summaries', () => {
  it('keeps the first useful outcome sentences and removes Markdown structure', () => {
    const result = summarizeForSpeech(
      '## Result\n\n- Implemented completion hooks for all three platforms.\n- Verified the live Stop payloads.',
      'Fallback.'
    );

    expect(result).toBe(
      'Implemented completion hooks for all three platforms. Verified the live Stop payloads.'
    );
  });

  it('combines a generic completion word with the useful sentence after it', () => {
    expect(summarizeForSpeech('Done. Added the automatic voice summary hook.', 'Fallback.')).toBe(
      'Done. Added the automatic voice summary hook.'
    );
  });

  it('removes code, directives, citations, URLs, and memory metadata', () => {
    const result = summarizeForSpeech(
      [
        'Updated [the hook runtime](https://example.com/private).',
        '```sh',
        'echo secret',
        '```',
        '::created-thread{threadId="abc"}',
        '<oai-mem-citation>hidden metadata</oai-mem-citation>',
      ].join('\n'),
      'Fallback.'
    );

    expect(result).toBe('Updated the hook runtime.');
  });

  it('shortens absolute paths and redacts likely credentials', () => {
    const result = cleanForSpeech(
      'Updated /Users/example/project/lib/main.dart with token sk-abcdefghijklmnop.'
    );

    expect(result).toBe('Updated main.dart with token a redacted credential.');
  });

  it('falls back when the response contains only non-spoken code', () => {
    expect(summarizeForSpeech('```dart\nvoid main() {}\n```', 'The agent finished.')).toBe(
      'The agent finished.'
    );
  });

  it('caps speech below the Voice MCP message guardrail', () => {
    const result = summarizeForSpeech('Changed '.repeat(100), 'Fallback.');

    expect(result.length).toBeLessThanOrEqual(SPOKEN_SUMMARY_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('path shortening', () => {
  it('keeps sentence punctuation that follows a path', () => {
    expect(cleanForSpeech('Fixed the crash in /Users/me/project/src/parser.ts. All tests pass.')).toBe(
      'Fixed the crash in parser.ts. All tests pass.'
    );
  });

  it('shortens Windows drive, forward-slash drive, and UNC paths', () => {
    expect(cleanForSpeech('Edited C:\\Users\\me\\project\\src\\main.ts, then ran tests.')).toBe('Edited main.ts, then ran tests.');
    expect(cleanForSpeech('Saved C:/Users/me/project/out.json.')).toBe('Saved out.json.');
    expect(cleanForSpeech('Copied to \\\\server\\share\\builds\\app.zip')).toBe('Copied to app.zip');
  });
});
