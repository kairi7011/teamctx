# Changelog

All notable user-facing changes to `teamctx` are recorded here.

This project uses small release notes grouped by version. Dates use ISO format.

## Unreleased

- Tighten scoped context retrieval so broad `domains` and `tags` narrow or boost
  results only when stronger selectors are absent; when target files, changed
  files, symbols, or text query are present, those stronger selectors constrain
  the candidate set. Rich file-scoped requests also prune low-signal target-only
  matches and require tag, symbol, or query intent matches to reduce first-call
  context noise.
- Fix CLI selector parsing so repeated CSV-style flags such as `--target-files`,
  `--domains`, `--symbols`, and `--tags` accumulate instead of silently keeping
  only the last value.
- Add `get_context` call policy metadata so clients call at session start,
  refresh only on explicit or material changes, and suppress unchanged payload
  reinjection with `previous_context_payload_hash`.
- Add troubleshooting guidance for common setup, auth, stale index, and MCP
  disabled-response issues.
- Add MCP client setup guidance for Codex and Claude Code.
- Add `teamctx tools --json` for machine-readable MCP tool definitions.
