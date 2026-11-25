## What and why

<!-- What this changes for users, and why. Link the issue if there is one. -->

## Checklist

- [ ] `npm run check` passes (typecheck, build, tests, committed bundle, versions)
- [ ] Behavior changes have a test; bug fixes have a regression test that fails without the fix
- [ ] `plugin/dist/voice-mcp.mjs` is rebuilt if `src/` changed
- [ ] `CHANGELOG.md` is updated for user-visible changes
- [ ] Platform-specific code is behind `osFamily()`, and I noted which OSes I tested on
