import { cleanForSpeech, truncateForSpeech } from './summary.js';
import {
  detectCompletionHookPlatform,
  protocolSuccessOutput,
  type CompletionHookPlatform,
} from './completion-hook.js';

const QUESTION_TOOL_NAMES = new Set([
  'ask_question',
  'AskUserQuestion',
  'request_user_input',
  'RequestUserInput',
]);

export interface QuestionHookResult {
  platform: CompletionHookPlatform;
  stdout: string;
  spokenText: string | null;
  deliveryAttempted: boolean;
  delivered: boolean;
}

export interface QuestionHookDependencies {
  deliverSpeech: (text: string) => Promise<boolean>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolCall(payload: Record<string, unknown>): {
  name: string | null;
  input: Record<string, unknown> | null;
} {
  const antigravityCall = payload['toolCall'];
  if (isPlainObject(antigravityCall)) {
    return {
      name: typeof antigravityCall['name'] === 'string' ? antigravityCall['name'] : null,
      input: isPlainObject(antigravityCall['args']) ? antigravityCall['args'] : null,
    };
  }

  return {
    name: typeof payload['tool_name'] === 'string' ? payload['tool_name'] : null,
    input: isPlainObject(payload['tool_input']) ? payload['tool_input'] : null,
  };
}

export function isQuestionToolPayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) {
    return false;
  }
  const { name } = toolCall(payload);
  return name !== null && QUESTION_TOOL_NAMES.has(name);
}

function questionTexts(input: Record<string, unknown> | null): string[] {
  if (!input || !Array.isArray(input['questions'])) {
    return [];
  }

  return input['questions']
    .map((entry) => {
      if (!isPlainObject(entry) || typeof entry['question'] !== 'string') {
        return '';
      }
      return cleanForSpeech(entry['question']);
    })
    .filter((question) => question.length > 0);
}

export function summarizeQuestionForSpeech(payload: unknown): string {
  if (!isPlainObject(payload)) {
    return 'The agent needs your input. Open the session to respond.';
  }

  const { input } = toolCall(payload);
  const questions = questionTexts(input);
  if (questions.length === 0) {
    return 'The agent needs your input. Open the session to respond.';
  }

  const prefix =
    questions.length === 1
      ? 'The agent needs your input.'
      : `The agent needs your input on ${questions.length} questions. First:`;
  return truncateForSpeech(`${prefix} ${questions[0]}`);
}

export async function runQuestionHook(
  payload: unknown,
  dependencies: QuestionHookDependencies
): Promise<QuestionHookResult> {
  const platform = detectCompletionHookPlatform(payload);
  const stdout = protocolSuccessOutput(platform);
  const base: QuestionHookResult = {
    platform,
    stdout,
    spokenText: null,
    deliveryAttempted: false,
    delivered: false,
  };

  if (!isQuestionToolPayload(payload)) {
    return base;
  }

  const spokenText = summarizeQuestionForSpeech(payload);
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
