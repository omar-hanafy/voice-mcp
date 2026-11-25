# Voice MCP

[![CI](https://github.com/omar-hanafy/voice-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/omar-hanafy/voice-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/omar-hanafy/voice-mcp)](https://github.com/omar-hanafy/voice-mcp/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

Hear when your coding agent finishes a turn or needs you, without watching the terminal.

Voice MCP is a plugin for **Claude Code**, **Codex**, and **Google Antigravity**, and an MCP server
for any other MCP client. It runs on **macOS and Windows** (Linux works on a best-effort basis).

- **End-of-turn summaries.** When the agent stops, a hook speaks a short summary of its final
  message: Markdown, code, URLs, long paths, and common credential formats are removed first.
- **Question alerts.** Just before the agent opens its question prompt, the question is read aloud.
- **A `speak` tool** for anything else important (a blocker, an approval request). The tool returns
  immediately and never fails, so speech can never stall the agent.
- **One shared queue.** Every agent, hook, and script on your machine speaks through one
  background broker, so voices never talk over each other.
- **Controls.** Mute, mute for N minutes, stop, pick a voice or provider, from the CLI or the
  optional macOS menu-bar item.
- **Guardrails** against spam: length cap, cooldown, duplicate suppression, rate limit, and an
  automatic panic-mute if an agent floods it.
- **Works with no setup** using the built-in OS voice. Kokoro, Piper, or any TTS command you like
  are optional upgrades.
- **Optional phone mirror** of each spoken line through [ntfy](https://ntfy.sh).

No extra model calls, no network traffic (unless you enable ntfy), and nothing leaves your machine.

## Requirements

- Node.js 22 or newer on `PATH`
- macOS: nothing else (`say` and `afplay` are built in)
- Windows: nothing else (uses the built-in Windows PowerShell and System.Speech)
- Linux: `espeak-ng` for the built-in voice and one of `paplay`, `pw-play`, `aplay`, or `ffplay`

## Install

### Claude Code

```bash
claude plugin marketplace add omar-hanafy/voice-mcp
claude plugin install voice-mcp@voice-mcp
```

Start a new session or run `/reload-plugins`.

### Codex

```bash
codex plugin marketplace add omar-hanafy/voice-mcp
codex plugin add voice-mcp@voice-mcp
```

Start a new session. Codex asks you to review new hooks: open `/hooks` and trust the Voice MCP hook.

### Google Antigravity (CLI, IDE, and App)

```bash
agy plugin install https://github.com/omar-hanafy/voice-mcp.git
```

Start a new session. In the IDE or App, the plugin shows under **Settings > Customizations**.

### Any other MCP client

Clone the repository (or install it with npm from GitHub) and point your client at the bundled
server. It needs no build step:

```json
{
  "mcpServers": {
    "voice-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/voice-mcp/plugin/dist/voice-mcp.mjs", "mcp"]
    }
  }
}
```

Lifecycle hooks are host features, so other clients get the `speak` tool only.

### Check it

```bash
node /path/to/voice-mcp/plugin/dist/voice-mcp.mjs doctor
```

Then ask your agent: *"Use voice-mcp to say a short test sentence."* The plugin installs no
`voice-mcp` command on your `PATH`; examples below write `voice-mcp` for
`node <plugin>/dist/voice-mcp.mjs`. To get a real command, run `npm install -g` from a clone, or
add an alias.

## How it works

```
Claude Code / Codex / Antigravity                Scripts, cron, CI
  ├─ Stop / StopFailure hook ──┐                        │
  ├─ question (PreToolUse) hook┤                        │
  └─ MCP server: speak(text) ──┼──► broker (one per user) ◄──── voice-mcp speak "..."
                               │      guardrails → ntfy mirror → mute gate
                               │      → queue → provider → chime + playback
```

The broker starts on demand, keeps a single queue, and exits after five idle minutes. It talks to
clients over a Unix socket (macOS and Linux) or a named pipe (Windows). Settings changes apply to
the next spoken line without a restart.

Lifecycle events mean "the agent finished responding for this turn", not "the whole task is done".
Claude Code, for example, also fires `Stop` after a reply that asks you a question; that reply is
read aloud too, which is usually what you want.

| Host | Completion | Question alert | Notes |
| --- | --- | --- | --- |
| Claude Code | `Stop`, `StopFailure` | `AskUserQuestion` | `StopFailure` speaks a safe status for API, auth, billing, and usage-limit errors. |
| Codex | `Stop` | `request_user_input` | Review and trust the hook in `/hooks` once. |
| Antigravity | `Stop` (after the agent is fully idle) | `ask_question` | The summary comes from the transcript. |

## Speech providers

Providers are tried in order (`providers.order`); the first that succeeds speaks. The default order
is `["kokoro", "piper", "system"]`, so the built-in voice is always the fallback.

| Provider | What it is | Setup |
| --- | --- | --- |
| `system` | The OS voice: `say` on macOS, SAPI (System.Speech) on Windows, espeak-ng on Linux | None |
| `kokoro` | [Kokoro](https://github.com/nazdridoy/kokoro-tts), natural neural voices | `pip install kokoro-tts`, then `voice-mcp models install kokoro` |
| `piper` | [Piper](https://github.com/OHF-Voice/piper1-gpl), fast neural voices | `pip install piper-tts`, then `voice-mcp models install piper en_US-joe-medium` |
| `command` | Any TTS program you choose | Set `providers.command` (see below) |

Kokoro and Piper need a Python that their packages support (3.10 to 3.12 is the safe range).
Models download into `<data dir>/models` unless you set `modelsDir` or `VOICE_MCP_MODELS_DIR`.

**Bring your own TTS.** Placeholders `{text}`, `{textFile}`, `{outFile}`, and `{voice}` are
replaced in `args`. If `{outFile}` appears, Voice MCP plays that file afterwards; otherwise the
command must speak by itself.

```jsonc
"providers": {
  "order": ["command", "system"],
  "command": {
    "command": "edge-tts",
    "args": ["--file", "{textFile}", "--write-media", "{outFile}"]
  }
}
```

On Windows the default player handles WAV only, so a `command` that writes MP3 needs
`audio.player` set to a player that can play it. Windows also cannot start `.cmd` or `.bat` files
without a shell: point `command` at an `.exe`, or at `cmd.exe` with `["/c", "your-script.cmd", ...]`.

## Command line

```text
voice-mcp speak <text...> [--no-ntfy]   Speak through the shared queue (exit 1 if undeliverable)
voice-mcp test-voice [text...]          Speak a sample line
voice-mcp stop                          Stop speaking and clear the queue
voice-mcp mute | unmute | toggle-mute
voice-mcp mute-for <minutes>
voice-mcp set-provider <auto|system|kokoro|piper|command>
voice-mcp set-voice <voice> [--provider <id>] [--test]
voice-mcp set-profile <name> | clear-profile | clear-voice | clear-provider
voice-mcp voices [--provider <id>] [--json]
voice-mcp status [--json]
voice-mcp doctor [--json]
voice-mcp models install kokoro | models install piper <voice>
voice-mcp paths [--json]
```

`speak` is the supported way for scripts and scheduled jobs to talk. It obeys mute, guardrails, the
queue, and your voice settings, and it starts the broker if needed. Pass `--no-ntfy` when the
caller already sends its own phone notification.

The voice override applies to the first provider tried. Pass `--provider` with `set-voice` to make
that provider first too, so a Kokoro voice name is never handed to Piper.

## Configuration

Everything lives in one per-user data directory:

| OS | Default location |
| --- | --- |
| macOS | `~/Library/Application Support/voice-mcp` |
| Windows | `%APPDATA%\voice-mcp` |
| Linux | `$XDG_CONFIG_HOME/voice-mcp` (usually `~/.config/voice-mcp`) |

Set `VOICE_MCP_HOME` to use another folder, and `VOICE_MCP_MODELS_DIR` to keep large models
elsewhere. Paths in settings may start with `~`.

| File | Written by | Purpose |
| --- | --- | --- |
| `settings.jsonc` | You | Settings, with comments. Created on first run with every option documented. |
| `settings.schema.json` | Voice MCP | Completion and validation in editors such as VS Code. |
| `state.json` | The CLI and menu bar | Mute, timer, provider, voice, and profile choices. |
| `status.json` | The broker | What is speaking now, counters, last error. |
| `logs/voice-mcp.log` | The broker | Diagnostics (`logging.level`, `logging.file`). |

If `settings.jsonc` has a syntax error, Voice MCP keeps using the last valid settings and reports
the problem in `voice-mcp status` and `voice-mcp doctor`.

**Profiles** are named overrides you can switch quickly:

```jsonc
"profiles": {
  "meeting": { "notification": { "enabled": false }, "audio": { "playerArgs": ["-v", "0.4"] } },
  "focus": { "guardrails": { "maxMessagesPerMinute": 2 } }
}
```

```bash
voice-mcp set-profile meeting
```

**Chime.** A short chime plays before each message. Turn it off with `notification.enabled`, or
point `notification.path` at your own WAV file.

### Mirror to your phone with ntfy

```jsonc
"ntfy": { "enabled": true, "server": "https://ntfy.sh", "topic": "<long random name>" }
```

Every accepted line is published, even while muted (tagged with a mute icon), so you still get the
update when your speakers are off. On the public ntfy.sh server **the topic name is the password**:
anyone who knows it can read your messages and post fake ones. Use a long random name, or a
server with access tokens (`ntfy.token`). Voice MCP never prints the topic in logs or diagnostics.

## macOS menu bar (optional)

[SwiftBar](https://github.com/swiftbar/SwiftBar) can show a menu-bar icon with mute, stop, timers,
provider and voice pickers, and diagnostics:

```bash
brew install --cask swiftbar
ln -s "$PWD/integrations/swiftbar/voice-mcp.5s.js" \
  "$HOME/Library/Application Support/SwiftBar/Plugins/voice-mcp.5s.js"
```

Run the `ln` from a clone you keep, not from an installed-plugin cache folder (updates replace
those). Set `VOICE_MCP_CLI` if your layout differs. `node` must be on SwiftBar's `PATH`.

## Troubleshooting

- **Nothing is spoken.** Run `voice-mcp doctor`. Look for `muted`, a missing player, or no ready
  provider. `voice-mcp status` shows the last error.
- **An agent's speech is dropped.** The guardrails may be doing their job: repeats within 15
  seconds, messages closer than 1.2 seconds, or more than 10 a minute are dropped by default. Tune
  them under `guardrails`.
- **Codex hooks do not run.** Trust the hook in `/hooks`.
- **Windows: speech is slow to start.** Each built-in voice message starts Windows PowerShell,
  which takes a moment. Kokoro or Piper avoid that.
- **"node: command not found" in a GUI app.** Hosts start Voice MCP with `node` from their `PATH`.
  Apps launched from the Dock may not see a `node` installed by a version manager; install Node.js
  system-wide or start the app from a terminal.

## Development

```bash
npm ci
npm run check        # typecheck, build, test, and verify the committed bundle
node scripts/verify-hosts.mjs   # install into isolated Claude/Codex/agy homes and exercise them
```

`plugin/` is exactly what the hosts install: manifests, hooks, the bundled runtime
`plugin/dist/voice-mcp.mjs`, and assets. The bundle is committed so installs need no build. Rebuild
it with `npm run build` whenever `src/` changes; CI fails if it is stale. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the layout and conventions.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
