# Contributing

Thanks for helping. Bug reports with `voice-mcp doctor` output (remove anything private) are the
most useful thing you can send.

## Setup

```bash
npm ci
npm run check
```

`npm run check` typechecks, builds the bundle, runs every test, and verifies that the committed
bundle, the three plugin manifests, and `CHANGELOG.md` agree.

## Layout

```
plugin/                 Exactly what hosts install
  .claude-plugin/       Claude Code manifest (MCP server inline, hooks file)
  .codex-plugin/        Codex manifest
  plugin.json           Antigravity manifest; hooks.json is its hook map
  mcp_config.json       MCP server for Codex and Antigravity (cwd "." is the plugin root)
  hooks/                Claude Code and Codex hook files
  dist/voice-mcp.mjs    Bundled runtime (generated; committed)
  assets/               Chime and logo
src/
  main.ts               Entry: mcp | hook | broker | CLI commands
  mcp/                  stdio MCP server with the speak tool
  hooks/                Completion and question hooks, summary cleaning, transcript reading
  broker/               Per-user broker: protocol, client, server, speech pipeline
  speech/               Engine, queue, guardrails, providers, voice lists
  audio/                Process runner and platform players
  config/               Paths, settings spec, files, live config store
  cli/                  Commands, doctor, status report, model downloads
integrations/swiftbar/  Optional macOS menu bar
scripts/                Build, dist check, chime generator, host install verification
test/                   Unit, integration (in-process broker), and end-to-end (built bundle) tests
```

## Conventions

- **Never block the agent.** The `speak` tool and hooks always succeed and return quickly. Failures
  are logged, shown by `status` and `doctor`, and never surfaced as tool errors.
- **stdout belongs to the protocol** for `mcp` and `hook`. Log to stderr or the log file.
- **Cross-platform by construction.** Spawn programs without a shell and pass untrusted text
  through files or environment variables, never through a shell string. Use `path` helpers, never
  hard-coded separators. Anything platform-specific goes behind `osFamily()`.
- **Settings are lenient.** Add new settings to `src/config/settings.ts` (defaults, ranges, and
  description in one place) and document them in `src/config/template.ts`. A test keeps the two
  in sync.
- **Rebuild the bundle** (`npm run build`) and commit `plugin/dist/voice-mcp.mjs` with any change
  to `src/` or dependencies.
- **Releases** bump `package.json` and the three manifests together and add a `CHANGELOG.md`
  section; `scripts/check-dist.mjs` enforces this.

## Verifying hosts

`node scripts/verify-hosts.mjs` installs the plugin into throwaway Claude Code, Codex, and
Antigravity homes and launches the MCP server and hooks with each host's own path rules for the
current OS. It speaks through a fake TTS engine, so it is silent. Hosts that are not installed are
skipped. Run it after changing anything under `plugin/` other than `dist/`.

## Verifying on Windows

CI runs the unit, integration, and end-to-end tests on Windows, including real SAPI synthesis.
Things only a Windows machine with the hosts installed can show:

1. `npm ci && npm run check`, then `node scripts/verify-hosts.mjs` with Claude Code, Codex, and
   `agy` installed. Claude Code hooks should run in Git Bash; the script also falls back to
   PowerShell when Git Bash is absent.
2. Audible playback: `node plugin/dist/voice-mcp.mjs test-voice` should play the chime, then speak.
   `voice-mcp voices --provider system` lists SAPI voices; try `set-voice "<name>" --provider
   system --test`.
3. The broker must outlive the hook that started it. Trigger a real `Stop` hook in each host,
   note the broker PID from `voice-mcp status`, and confirm it is still running a few seconds
   later and the line was spoken. Some hosts run hooks inside a Windows Job Object that kills
   child processes when the hook exits; if a host does, speech started by its hooks is cut off.
4. Stop during speech (`voice-mcp stop`) silences it immediately, including with a `command`
   provider that wraps the real engine in `cmd.exe /c`.
5. While a broker is running, the folder of the project that started it can still be renamed or
   deleted (the broker must not hold it as its working directory).
