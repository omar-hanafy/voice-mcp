import { summarizeForSpeech, truncateForSpeech } from './summary.js';
import { readLatestModelResponse } from './transcript.js';

export type CompletionHookPlatform = 'antigravity' | 'claude-or-codex' | 'unknown';

export interface CompletionHookResult {
  platform: CompletionHookPlatform;
  stdout: string;
  spokenText: string | null;
  deliveryAttempted: boolean;
  delivered: boolean;
}

export interface CompletionHookDependencies {
  readTranscript?: (path: string) => Promise<string | null>;
  deliverSpeech: (text: string) => Promise<boolean>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function detectCompletionHookPlatform(payload: unknown): CompletionHookPlatform {
  if (!isPlainObject(payload)) {
    return 'unknown';
  }
  if (
    'conversationId' in payload ||
    'transcriptPath' in payload ||
    'fullyIdle' in payload ||
    'terminationReason' in payload ||
    'hookEventName' in payload ||
    'continuationActive' in payload
  ) {
    return 'antigravity';
  }
  if (
    payload['hook_event_name'] === 'Stop' ||
    payload['hook_event_name'] === 'StopFailure' ||
    payload['hook_event_name'] === 'PreToolUse' ||
    'tool_name' in payload ||
    'last_assistant_message' in payload
  ) {
    return 'claude-or-codex';
  }
  return 'unknown';
}

export function protocolSuccessOutput(platform: CompletionHookPlatform): string {
  return platform === 'antigravity' ? '{"decision":"allow"}\n' : '{}\n';
}

function antigravityFallback(payload: Record<string, unknown>): string {
  const reason = String(payload['terminationReason'] ?? '').trim().toUpperCase();
  const hasError = nonemptyString(payload['error']) !== null;
  if (hasError || reason.includes('ERROR') || reason.includes('FAIL')) {
    return 'The agent stopped with an error. Open the session for details.';
  }
  if (
    reason.includes('MAX_STEP') ||
    reason.includes('STEP_LIMIT') ||
    reason.includes('MAX_INVOCATIONS') ||
    reason.includes('MAX_FORCED_INVOCATIONS') ||
    reason.includes('TOKEN_LIMIT') ||
    reason.includes('TOKEN_BUDGET') ||
    reason.includes('TIMEOUT')
  ) {
    return 'The agent reached its execution limit. Open the session for details.';
  }
  if (
    reason.includes('CANCEL') ||
    reason.includes('INTERRUPT') ||
    reason.includes('TERMINAL_CUSTOM_HOOK')
  ) {
    return 'The agent stopped before finishing. Open the session for details.';
  }
  return 'The agent finished responding. Open the session for details.';
}

function claudeFailureFallback(payload: Record<string, unknown>): string {
  const error = String(payload['error'] ?? '').trim().toLowerCase();
  if (error.includes('rate_limit') || error.includes('quota')) {
    return 'Claude stopped because its usage limit was reached. Open the session for details.';
  }
  if (error.includes('auth')) {
    return 'Claude stopped because authentication failed. Open the session for details.';
  }
  if (error.includes('billing')) {
    return 'Claude stopped because of a billing error. Open the session for details.';
  }
  return 'Claude stopped with an API error. Open the session for details.';
}

function mergeStatusWithSummary(status: string, summary: string): string {
  if (summary.toLowerCase().startsWith(status.toLowerCase())) {
    return summary;
  }
  return truncateForSpeech(`${status} ${summary}`);
}

export async function runCompletionHook(
  payload: unknown,
  dependencies: CompletionHookDependencies
): Promise<CompletionHookResult> {
  const platform = detectCompletionHookPlatform(payload);
  const stdout = protocolSuccessOutput(platform);
  const base: CompletionHookResult = {
    platform,
    stdout,
    spokenText: null,
    deliveryAttempted: false,
    delivered: false,
  };

  if (!isPlainObject(payload)) {
    return base;
  }

  if (platform === 'antigravity' && payload['fullyIdle'] === false) {
    return base;
  }

  let spokenText: string;
  if (payload['hook_event_name'] === 'StopFailure') {
    spokenText = claudeFailureFallback(payload);
  } else {
    let finalMessage = nonemptyString(payload['last_assistant_message']);
    if (!finalMessage && platform === 'antigravity') {
      const transcriptPath = nonemptyString(payload['transcriptPath']);
      if (transcriptPath) {
        finalMessage = await (dependencies.readTranscript ?? readLatestModelResponse)(transcriptPath);
      }
    }

    const fallback =
      platform === 'antigravity'
        ? antigravityFallback(payload)
        : 'The agent finished responding. Open the session for details.';
    spokenText = summarizeForSpeech(finalMessage, fallback);

    if (platform === 'antigravity') {
      const statusFallback = antigravityFallback(payload);
      if (!statusFallback.startsWith('The agent finished responding.')) {
        spokenText = mergeStatusWithSummary(statusFallback, spokenText);
      }
    }
  }

  let delivered = false;
  try {
    delivered = await dependencies.deliverSpeech(spokenText);
  } catch {
    delivered = false;
  }

  return {
    ...base,
    spokenText,
    deliveryAttempted: true,
    delivered,
  };
}
