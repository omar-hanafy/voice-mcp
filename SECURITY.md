# Security

Please report vulnerabilities privately through GitHub's
[security advisories](https://github.com/omar-hanafy/voice-mcp/security/advisories/new) rather than
in a public issue.

## What Voice MCP does and does not do

- It runs only local programs that you configure (the OS voice, Kokoro, Piper, a player, or your
  `command` provider), without a shell. Spoken text is passed through files or arguments, never
  interpreted by a shell.
- The broker listens on a Unix socket with owner-only permissions inside your data directory (or
  your temp folder when that path is too long), or on a per-user named pipe on Windows. Any program
  running as your user can ask it to speak.
- It makes no network requests unless you enable the ntfy mirror. On an open ntfy server the topic
  name is the only access control, so treat it like a password. Voice MCP never writes it to logs
  or diagnostics.
- Spoken summaries remove common credential formats (bearer tokens, `sk-`/`gh*_` keys, JWTs), but
  this is best effort. Anything the agent writes in its final message may be spoken aloud.
