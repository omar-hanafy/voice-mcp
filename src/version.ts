/** Replaced at build time from package.json; the fallback keeps tests and `tsx` runs working. */
declare const __VOICE_MCP_VERSION__: string | undefined;

/** Oldest supported Node.js major version; a test keeps it equal to package.json `engines`. */
export const MIN_NODE_MAJOR = 22;

export const VERSION: string = typeof __VOICE_MCP_VERSION__ === 'string' ? __VOICE_MCP_VERSION__ : '0.0.0-dev';
