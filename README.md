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
- `teamctx init-store` for same-repository context stores
- `teamctx status`
- `teamctx doctor`
- local binding storage
- Node built-in test runner setup
- initial MCP tool shape definitions

Planned:

- GitHub-backed context store adapter
- `get_context`
- `record_observation_candidate`
- `record_observation_verified`
- deterministic normalization
- audit and invalidation tools

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

Run diagnostics:

```bash
teamctx doctor
```

## Non Goals

- Hosted SaaS for all user context.
- A replacement for Claude Code, Codex, or Cursor.
- Automatic truth guarantees for AI-generated observations.
- Mandatory human review for every context update.

## License

MIT
