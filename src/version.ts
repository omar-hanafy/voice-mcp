/** Replaced at build time from package.json; the fallback keeps tests and `tsx` runs working. */
declare const __VOICE_MCP_VERSION__: string | undefined;

export const VERSION: string = typeof __VOICE_MCP_VERSION__ === 'string' ? __VOICE_MCP_VERSION__ : '0.0.0-dev';
