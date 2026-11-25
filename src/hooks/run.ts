import { sendSpeak } from '../broker/client.js';
import { ensureDataDir } from '../config/files.js';
import { resolvePaths } from '../config/paths.js';
import { silentLogger } from '../util/logger.js';
import { detectCompletionHookPlatform, protocolSuccessOutput, runCompletionHook } from './completion-hook.js';
import { isQuestionToolPayload, runQuestionHook } from './question-hook.js';

const ANTIGRAVITY_MARKERS = ['"conversationId"', '"fullyIdle"', '"hookEventName"', '"continuationActive"'];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Lifecycle hook entry point shared by Claude Code, Codex, and Antigravity. It always answers
 * with the host's "allow / no-op" response and exit code 0: speech is a side effect and must
 * never block, approve, or alter the agent's turn.
 */
export async function runHook(): Promise<void> {
  let output = protocolSuccessOutput('unknown');
  try {
    const raw = await readStdin();
    if (ANTIGRAVITY_MARKERS.some((marker) => raw.includes(marker))) output = protocolSuccessOutput('antigravity');

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    output = protocolSuccessOutput(detectCompletionHookPlatform(payload));

    const paths = resolvePaths();
    const deliverSpeech = async (text: string) => {
      await ensureDataDir(paths).catch(() => undefined);
      return sendSpeak({ paths, logger: silentLogger, text });
    };
    const result = isQuestionToolPayload(payload)
      ? await runQuestionHook(payload, { deliverSpeech })
      : await runCompletionHook(payload, { deliverSpeech });
    output = result.stdout;
  } catch {
    // Fall through to the safe default response.
  } finally {
    process.stdout.write(output);
    process.exitCode = 0;
  }
}
