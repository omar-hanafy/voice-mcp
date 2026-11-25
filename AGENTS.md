# Agent notes

- Read `CONTRIBUTING.md` for the layout and conventions before editing.
- After changing `src/`, run `npm run check`. It rebuilds `plugin/dist/voice-mcp.mjs`, which must be
  committed with the source change.
- After changing anything in `plugin/` besides `dist/`, also run `node scripts/verify-hosts.mjs`
  and `agy plugin validate --strict plugin` when those CLIs are installed.
- After changing `.github/`, run `actionlint` and `zizmor --offline --strict-collection .github`, and
  pin actions to full commit SHAs.
- Tests must stay silent: use the fake TTS and player helpers in `test/helpers.ts`, and a temporary
  `VOICE_MCP_HOME`, never the real data directory.
- Releases bump `package.json`, the three plugin manifests, and `CHANGELOG.md` together.
