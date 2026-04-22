# teamctx

`teamctx` is a Git-backed, GitHub-first context layer for AI coding tools.

It is not a new coding agent. It is a local CLI and MCP companion designed to let tools such as Claude Code, Codex, and Cursor read and write the same repo-scoped team context.

## Goal

When multiple people use AI coding tools on the same repository, quality often drifts because each user has different local memory, prompts, settings, and session history.

`teamctx` aims to reduce that drift by binding a local repository to a shared context store and returning a normalized, evidence-aware context payload to the AI tool.

## Current Status

This repository is an early scaffold.

Implemented:

- `teamctx bind`
- `teamctx init-store` for same-repository and GitHub context stores
- `teamctx status`
- `teamctx doctor`
- local binding storage
- minimal MCP server with `teamctx.get_context` and `teamctx.status`
- GitHub contents-store adapter for shared remote context stores
- raw observation recording for same-repository and GitHub context stores
- secret / PII scan before raw observation writes
- deterministic normalization of local and GitHub raw events into normalized JSONL
- deterministic near-dedupe for wording variants and ordering conflict detection
- path / symbol index generation during normalization
- index-backed context selection by paths, domains, symbols, and tags
- canonical docs references from scoped docs evidence
- ranked context payloads with selection reasons and category budgets
- selector-driven remote context retrieval that skips unrelated normalized shards
- raw-event-derived episode index and `relevant_episodes` payload entries
- status summaries for recent promoted, dropped, contested, and stale records
- `teamctx explain` / `teamctx invalidate` for local and GitHub normalized records
- `teamctx compact` for local and GitHub retention and archive compaction
- Node built-in test runner setup
- initial MCP tool shape definitions

Planned:

- real GitHub integration smoke tests
- richer stale scoring and contested audit views
- deeper normalization quality beyond deterministic heuristics

## Design Principles

- Do not build another AI engine.
- Use existing tools such as Claude Code and Codex as the AI runtime.
- Keep user-owned context in user-owned stores.
- Treat raw observations, normalized records, and context payloads as separate layers.
- Do not inject raw logs into AI context.
- Do not require PR, merge, pull, or manual review on every context update.
- Prefer explicit project binding over implicit discovery.

## Install

```bash
npm install -g teamctx
```

During local development:

```bash
npm install
npm run build
node dist/cli/index.js doctor
```

## Usage

Bind the current repository to a context store:

```bash
teamctx bind github.com/my-org/ai-context --path contexts/my-service
```

Use the current repository as the store:

```bash
teamctx bind . --path .teamctx
teamctx init-store
```

Check the current binding:

```bash
teamctx status
```

Compact expired local context-store data into the configured archive path:

```bash
teamctx compact
```

Run diagnostics:

```bash
teamctx doctor
```

Run the MCP server during local development:

```bash
node dist/mcp/server.js
```

## Non Goals

- Hosted SaaS for all user context.
- A replacement for Claude Code, Codex, or Cursor.
- Automatic truth guarantees for AI-generated observations.
- Mandatory human review for every context update.

## License

MIT
