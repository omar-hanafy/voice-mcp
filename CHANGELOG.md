# Changelog

## 0.5.0

First standalone open-source release. Earlier versions shipped inside a private plugin collection
and supported macOS only.

### Added

- Windows support: the built-in voice uses SAPI (System.Speech), playback uses the built-in
  PowerShell SoundPlayer, and the broker listens on a per-user named pipe.
- Best-effort Linux support with espeak-ng and paplay, pw-play, aplay, or ffplay.
- `command` provider for any TTS program, with `{text}`, `{textFile}`, `{outFile}`, and `{voice}`
  placeholders.
- `voice-mcp doctor`, `voices`, `models install kokoro|piper <voice>`, `test-voice`, and
  `status --json` commands, replacing the macOS-only shell scripts.
- `set-voice --provider <id> --test` to select and preview a voice in one step.
- `modelsDir` setting; paths in settings may start with `~`.
- Editor JSON Schema generated from the same definition as the defaults.

### Changed

- The macOS-only `say` provider is now `system`, the built-in voice on every OS. `say` is still
  accepted in `providers.order`, `providers.say`, and `set-provider`.
- `audio.player` defaults to the platform player (`null`) instead of `afplay`.
- `piper.python` defaults to `python` on Windows and `python3` elsewhere.
- Models default to `<data dir>/models` instead of `~/.mcps/voice-mcp-models`; set `modelsDir` to
  keep an existing folder.
- Default data directory on Windows is `%APPDATA%\voice-mcp` and on Linux `~/.config/voice-mcp`.
- One bundled runtime, `plugin/dist/voice-mcp.mjs`, serves the MCP server, hooks, broker, and CLI.
  Hosts start it with `node` directly, without a `bash` launcher.
- An invalid `settings.jsonc` keeps the last valid settings instead of reverting to defaults, and
  the error shows in `status` and `doctor`.
- A broker from an older version is replaced automatically after an upgrade.
- The bundled chime is a newly synthesized sound.
- `stop` stops only Voice MCP's own audio, including helper processes a TTS command started. It
  no longer kills every `afplay` and `say` process on the machine.
- The `speak` tool returns before the broker is contacted, so it never delays the agent.

### Fixed

- `set-provider say` was rejected even though the provider existed.
- The settings schema was rewritten on every hook and CLI call, which left orphaned temp files in
  the data directory.
- A path at the end of a sentence swallowed the sentence's period in spoken summaries, merging
  sentences.
- Windows paths (`C:\...`, `C:/...`, and UNC) are now shortened in spoken summaries.
- Unix socket paths longer than the OS limit fall back to a short temp path instead of failing.
- On Linux, temp audio and the fallback socket use the private `XDG_RUNTIME_DIR` when available,
  and a temp folder that another user could reach is refused.

### Removed

- Migration from the pre-0.4 `~/.mcps/voice-mcp/runtime` directory.
- `audio.allowKill`: stopping always escalates to a forced kill after `audio.killGraceMs`.
- The `scripts/*.sh` launchers and SwiftBar helper scripts.
