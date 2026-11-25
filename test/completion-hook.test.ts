import { describe, expect, it, vi } from 'vitest';

import {
  detectCompletionHookPlatform,
  protocolSuccessOutput,
  runCompletionHook,
} from '../src/hooks/completion-hook.js';

describe('completion hook runtime', () => {
  it('detects each platform contract and emits protocol-safe success output', () => {
    expect(detectCompletionHookPlatform({ conversationId: 'agy' })).toBe('antigravity');
    expect(detectCompletionHookPlatform({ hookEventName: 'Stop' })).toBe('antigravity');
    expect(detectCompletionHookPlatform({ continuationActive: true })).toBe('antigravity');
    expect(detectCompletionHookPlatform({ hook_event_name: 'Stop' })).toBe('claude-or-codex');
    expect(protocolSuccessOutput('antigravity')).toBe('{"decision":"allow"}\n');
    expect(protocolSuccessOutput('claude-or-codex')).toBe('{}\n');
  });

  it('maps current Antigravity terminationReason values to accurate fallbacks', async () => {
    for (const terminationReason of [
      'MAX_INVOCATIONS',
      'MAX_FORCED_INVOCATIONS',
      'MAX_TOKEN_BUDGET_EXCEEDED',
    ]) {
      const deliverSpeech = vi.fn(async () => true);
      await runCompletionHook(
        { conversationId: 'agy', fullyIdle: true, terminationReason },
        { deliverSpeech }
      );
      expect(deliverSpeech).toHaveBeenCalledWith(
        'The agent reached its execution limit. Open the session for details.'
      );
    }

    const deliverSpeech = vi.fn(async () => true);
    await runCompletionHook(
      { conversationId: 'agy', fullyIdle: true, terminationReason: 'TERMINAL_CUSTOM_HOOK' },
      { deliverSpeech }
    );
    expect(deliverSpeech).toHaveBeenCalledWith(
      'The agent stopped before finishing. Open the session for details.'
    );
  });

  it('reads and speaks the Antigravity final transcript response when fully idle', async () => {
    const readTranscript = vi.fn(async () => 'Violet beacon plugin hook verified.');
    const deliverSpeech = vi.fn(async () => true);

    const result = await runCompletionHook(
      {
        conversationId: 'agy',
        fullyIdle: true,
        terminationReason: 'NO_TOOL_CALL',
        transcriptPath: '/tmp/transcript_full.jsonl',
      },
      { readTranscript, deliverSpeech }
    );

    expect(readTranscript).toHaveBeenCalledWith('/tmp/transcript_full.jsonl');
    expect(deliverSpeech).toHaveBeenCalledWith('Violet beacon plugin hook verified.');
    expect(result.stdout).toBe('{"decision":"allow"}\n');
    expect(result.delivered).toBe(true);
  });

  it('does not speak while Antigravity still has background work', async () => {
    const deliverSpeech = vi.fn(async () => true);
    const result = await runCompletionHook(
      { conversationId: 'agy', fullyIdle: false, terminationReason: 'NO_TOOL_CALL' },
      { deliverSpeech }
    );

    expect(deliverSpeech).not.toHaveBeenCalled();
    expect(result.deliveryAttempted).toBe(false);
    expect(result.stdout).toBe('{"decision":"allow"}\n');
  });

  it('supports older Antigravity payloads that omit fullyIdle', async () => {
    const deliverSpeech = vi.fn(async () => true);
    await runCompletionHook(
      {
        conversationId: 'agy',
        terminationReason: 'NO_TOOL_CALL',
      },
      { deliverSpeech }
    );

    expect(deliverSpeech).toHaveBeenCalledWith(
      'The agent finished responding. Open the session for details.'
    );
  });

  it('uses last_assistant_message directly for Claude and Codex', async () => {
    const deliverSpeech = vi.fn(async () => true);
    const result = await runCompletionHook(
      {
        hook_event_name: 'Stop',
        last_assistant_message: 'Implemented automatic completion speech.',
        background_tasks: [],
        session_crons: [],
      },
      { deliverSpeech }
    );

    expect(deliverSpeech).toHaveBeenCalledWith('Implemented automatic completion speech.');
    expect(result.stdout).toBe('{}\n');
  });

  it('still announces Claude end-of-turn text when later work is pending', async () => {
    const deliverSpeech = vi.fn(async () => true);

    await runCompletionHook(
      {
        hook_event_name: 'Stop',
        last_assistant_message: 'I am waiting for one background check.',
        background_tasks: [{ status: 'running' }],
        session_crons: [{ id: 'wake-1' }],
      },
      { deliverSpeech }
    );

    expect(deliverSpeech).toHaveBeenCalledWith('I am waiting for one background check.');
  });

  it('announces Claude API failures without exposing raw error details', async () => {
    const deliverSpeech = vi.fn(async () => true);
    await runCompletionHook(
      { hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'sensitive detail' },
      { deliverSpeech }
    );

    expect(deliverSpeech).toHaveBeenCalledWith(
      'Claude stopped because its usage limit was reached. Open the session for details.'
    );
  });

  it('keeps hook success independent from broker delivery', async () => {
    const result = await runCompletionHook(
      { hook_event_name: 'Stop', last_assistant_message: 'Finished safely.' },
      { deliverSpeech: async () => false }
    );

    expect(result.deliveryAttempted).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.stdout).toBe('{}\n');
  });
});
