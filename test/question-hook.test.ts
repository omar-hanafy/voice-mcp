import { describe, expect, it, vi } from 'vitest';

import {
  isQuestionToolPayload,
  runQuestionHook,
  summarizeQuestionForSpeech,
} from '../src/hooks/question-hook.js';

describe('question hook runtime', () => {
  it('speaks the Antigravity ask_question prompt and allows the tool to continue', async () => {
    const deliverSpeech = vi.fn(async () => true);
    const payload = {
      conversationId: 'agy',
      toolCall: {
        name: 'ask_question',
        args: {
          questions: [
            {
              question: 'Which deployment environment should I use?',
              options: ['Staging', 'Production'],
              is_multi_select: false,
            },
          ],
        },
      },
    };

    const result = await runQuestionHook(payload, { deliverSpeech });

    expect(deliverSpeech).toHaveBeenCalledWith(
      'The agent needs your input. Which deployment environment should I use?'
    );
    expect(result.stdout).toBe('{"decision":"allow"}\n');
    expect(result.delivered).toBe(true);
  });

  it('supports the Claude AskUserQuestion payload without changing its interaction', async () => {
    const deliverSpeech = vi.fn(async () => true);
    const result = await runQuestionHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{ question: 'Should I keep the existing API?', header: 'API', options: [] }],
        },
      },
      { deliverSpeech }
    );

    expect(result.spokenText).toBe('The agent needs your input. Should I keep the existing API?');
    expect(result.stdout).toBe('{}\n');
  });

  it('supports Codex request_user_input and announces multiple questions concisely', () => {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: {
        questions: [
          { question: 'Which scope should I use?' },
          { question: 'Should I add migration support?' },
        ],
      },
    };

    expect(isQuestionToolPayload(payload)).toBe(true);
    expect(summarizeQuestionForSpeech(payload)).toBe(
      'The agent needs your input on 2 questions. First: Which scope should I use?'
    );
  });

  it('uses a safe fallback when a recognized question tool omits question text', async () => {
    const deliverSpeech = vi.fn(async () => false);
    const result = await runQuestionHook(
      { hook_event_name: 'PreToolUse', tool_name: 'RequestUserInput', tool_input: {} },
      { deliverSpeech }
    );

    expect(deliverSpeech).toHaveBeenCalledWith(
      'The agent needs your input. Open the session to respond.'
    );
    expect(result.deliveryAttempted).toBe(true);
    expect(result.delivered).toBe(false);
  });

  it('ignores unrelated tools even if they contain a questions field', async () => {
    const deliverSpeech = vi.fn(async () => true);
    const result = await runQuestionHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'update_plan',
        tool_input: { questions: [{ question: 'This should not be spoken.' }] },
      },
      { deliverSpeech }
    );

    expect(deliverSpeech).not.toHaveBeenCalled();
    expect(result.deliveryAttempted).toBe(false);
  });
});
