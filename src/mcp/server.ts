import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import { sendSpeak } from '../broker/client.js';
import { ensureDataDir } from '../config/files.js';
import { resolvePaths } from '../config/paths.js';
import { isPlainObject } from '../util/errors.js';
import { AppLogger } from '../util/logger.js';
import { VERSION } from '../version.js';

export const SPEAK_TOOL: Tool = {
  name: 'speak',
  description:
    'Speak a short line aloud to the user. Use it when the user asks you to, or for an important mid-task moment that needs their attention (a blocker, an approval request). Do not use it for routine progress. When the voice-mcp lifecycle hooks are installed, end-of-turn summaries and question prompts are already spoken automatically, so do not repeat them here. Returns immediately; the result is always empty.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say. Plain sentences; under 400 characters.' },
    },
    required: ['text'],
  },
  annotations: {
    title: 'Speak aloud',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export function speakText(args: unknown): string {
  if (typeof args === 'string') return args.trim();
  if (isPlainObject(args) && typeof args.text === 'string') return args.text.trim();
  return '';
}

const EMPTY_RESULT = { content: [] };

/**
 * stdio MCP server exposing a single fire-and-forget `speak` tool. The call returns before any
 * audio plays and never reports an error, so speech can never fail or stall an agent's turn.
 */
export async function runMcpServer(): Promise<void> {
  const paths = resolvePaths();
  const logger = new AppLogger({ component: 'mcp', level: 'warn' });
  await ensureDataDir(paths).catch(() => undefined);

  const server = new Server({ name: 'voice-mcp', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [SPEAK_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== SPEAK_TOOL.name) return EMPTY_RESULT;
    const text = speakText(request.params.arguments);
    if (text) {
      void sendSpeak({ paths, logger, text }).then((delivered) => {
        if (!delivered) logger.warn('Speech broker unavailable; line dropped');
      });
    }
    return EMPTY_RESULT;
  });

  await server.connect(new StdioServerTransport());
}
