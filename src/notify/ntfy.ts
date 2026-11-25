import type { Settings } from '../config/settings.js';
import { previewText } from '../speech/text.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

const NTFY_TIMEOUT_MS = 4_000;

export type NtfySettings = Settings['ntfy'];

/**
 * Publish a spoken line to an ntfy topic. Best effort: never throws, so a slow or failed
 * notification cannot delay speech. The speaker/mute emoji travels in the `Tags` header as an
 * ASCII shortcode because HTTP header values must be Latin-1.
 */
export async function publishToNtfy(params: {
  settings: NtfySettings;
  text: string;
  muted: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { settings, text, muted, logger } = params;
  if (!settings.enabled) return;
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const server = settings.server.replace(/\/+$/, '');
  if (!server || !settings.topic) {
    logger.warn('ntfy is enabled but server or topic is empty; skipping');
    return;
  }

  const body = settings.maxBodyChars > 0 ? previewText(text, settings.maxBodyChars) : text;
  if (!body.trim()) return;

  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: settings.title,
    Tags: muted ? 'mute' : 'speaker',
    Priority: String(settings.priority),
  };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;

  try {
    const response = await fetchFn(`${server}/${encodeURIComponent(settings.topic)}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    });
    if (!response.ok) logger.warn('ntfy publish was rejected', { status: response.status });
  } catch (error) {
    // Never log the topic: on an open server the topic name is the only secret.
    logger.warn('ntfy publish failed', { error: errorMessage(error) });
  }
}
