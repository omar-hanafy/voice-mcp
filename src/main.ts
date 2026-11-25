import { startBroker } from './broker/server.js';
import { runCli } from './cli/main.js';
import { resolvePaths } from './config/paths.js';
import { runHook } from './hooks/run.js';
import { runMcpServer } from './mcp/server.js';
import { errorMessage } from './util/errors.js';

/**
 * Single entry point for the bundled runtime (dist/voice-mcp.mjs). The MCP server, lifecycle
 * hooks, broker, and CLI share one file so hosts, launchers, and the broker spawn all point at
 * the same artifact.
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'mcp':
      await runMcpServer();
      return;
    case 'hook':
      await runHook();
      return;
    case 'broker': {
      const broker = await startBroker({ paths: resolvePaths(), exit: (code) => process.exit(code) });
      if (!broker) {
        process.exit(0);
        return;
      }
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => void broker.shutdown(signal));
      }
      return;
    }
    default:
      process.exitCode = await runCli(command === undefined ? [] : [command, ...rest]);
  }
}

main().catch((error) => {
  process.stderr.write(`voice-mcp: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
