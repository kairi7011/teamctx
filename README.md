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
- overlap-aware conflict detection across matching paths, domains, symbols, and tags
- basic temporal metadata on normalized records (`valid_from`, `valid_until`, `invalidated_by`)
- path / symbol / text index generation during normalization
- index-backed context selection by paths, domains, symbols, tags, and deterministic text queries
- canonical docs references from scoped docs evidence
- ranked context payloads with selection reasons and category budgets
- structured scoped ranking scores and match reasons in context payloads
- approximate token budgeting for context text, configurable with `context_budgets.content_tokens`
- selector-driven remote context retrieval that skips unrelated normalized shards
- context diagnostics for missing, stale, or invalid generated indexes
- `teamctx.get_context` time filters with `since` / `until`
- raw-event-derived episode index and `relevant_episodes` payload entries with source, evidence file, and time filters
- `teamctx explain-episode` / `teamctx.explain_episode` for episode reference inspection
- status summaries for recent promoted, dropped, contested, and stale records
- CLI batch recording for candidate and verified raw observations from JSON files
- `teamctx explain` / `teamctx invalidate` for local and GitHub normalized records
- `teamctx context` for previewing the current `teamctx.get_context` payload
- `teamctx rank` for inspecting ranking, placement, and exclusion reasons
- `teamctx list` for listing normalized records by kind, state, scope, query, and limit
- `teamctx audit` for listing audit changes by action, item, source event, query, and limit
- `teamctx show` for inspecting one normalized record in human-readable form
- `--json` support for automation-friendly `teamctx init-store`, `teamctx status`, `teamctx normalize`, `teamctx compact`, `teamctx invalidate`, and observation recording output
- `teamctx compact` for local and GitHub retention and archive compaction
- `--dry-run` support for `teamctx normalize` and `teamctx compact`
- opt-in real GitHub smoke test for the MVP remote context flow
- Node built-in test runner setup
- initial MCP tool shape definitions

Planned:

- deeper normalization quality beyond deterministic heuristics
- richer temporal, procedural, and semantic memory after deterministic retrieval remains stable

## Design Principles

- Do not build another AI engine.
- Use existing tools such as Claude Code and Codex as the AI runtime.
- Keep user-owned context in user-owned stores.
- Treat raw observations, normalized records, and context payloads as separate layers.
- Do not inject raw logs into AI context.
- Do not require PR, merge, pull, or manual review on every context update.
- Prefer explicit project binding over implicit discovery.

## Memory Model Boundary

`teamctx` keeps the MVP memory model deliberately narrow:

- Working context is the bounded `teamctx.get_context` payload for the current task. It is composed from active normalized records and can be scoped by paths, domains, symbols, tags, deterministic text query, and time filters.
- Episodic memory is represented by raw observations and generated episode references. `get_context` returns episode references only; raw event bodies are not injected by default.
- Semantic memory is the normalized JSONL layer: facts, rules, decisions, workflows, pitfalls, and glossary terms with evidence and state. MVP retrieval is deterministic and index-backed, not embedding-based.
- Procedural memory is represented as rule, workflow, and pitfall records. MVP procedures are guidance text, not executable checklists or enforced automation.

Trust labels describe how an observation entered the store, not whether the underlying claim is factually true. A `verified` observation only means a trusted source (typically an AI agent reading code, tests, or docs) recorded it with non-manual evidence; it can still become contested, stale, superseded, or invalidated as the codebase evolves. `candidate` observations stay out of `get_context` payloads until they are explicitly promoted with verifying evidence.

Post-MVP work may add embeddings, richer temporal models, executable procedures, background consolidation, and UI surfaces. Automatic truth resolution and automatic conflict resolution are intentionally out of scope for the MVP.

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
teamctx init-store --json
```

Check the current binding:

```bash
teamctx status
teamctx status --json
```

Preview the current task context:

```bash
teamctx context --target-files src/index.ts --domains cli --query "record verified"
teamctx context context-input.json
```

List normalized records:

```bash
teamctx list --state active --domains cli --limit 20
teamctx list --kind workflow --tags preview-cli --query "context preview"
```

Inspect one normalized record:

```bash
teamctx show workflow-example
teamctx explain workflow-example
teamctx invalidate workflow-example --reason "obsolete" --json
```

Trace ranking and context placement:

```bash
teamctx rank --target-files src/index.ts --domains cli --query "record verified"
```

List audit changes:

```bash
teamctx audit --action created --limit 20
teamctx audit --item workflow-example --query "evidence minimum"
```

Record one or more verified observations from a JSON file:

```bash
teamctx record-verified observations.json
teamctx record-verified observations.json --json
teamctx normalize --dry-run
teamctx normalize --json
teamctx normalize
```

The file can contain one observation object or an array of observation objects. Verified observations must include non-manual evidence. The `verified` label describes provenance, not truth: records can still transition to `contested`, `stale`, `superseded`, or `archived` over time.

Compact expired local context-store data into the configured archive path:

```bash
teamctx compact
teamctx compact --dry-run
teamctx compact --json
```

Context text budgets are approximate token budgets. Configure them in `project.yaml`:

```yaml
context_budgets:
  scoped_items: 20
  content_tokens: 300
```

Older `content_chars` settings are still accepted and converted to approximate tokens.

Run diagnostics:

```bash
teamctx doctor
```

Run the opt-in GitHub smoke test against a real context-store repository:

```bash
$env:TEAMCTX_GITHUB_SMOKE = "1"
$env:TEAMCTX_GITHUB_SMOKE_STORE = "github.com/my-org/ai-context"
$env:TEAMCTX_GITHUB_TOKEN = "<token with repo contents access>"
npm test -- --test-name-pattern "GitHub contents store supports"
```

The smoke test writes to a generated `contexts/teamctx-smoke/...` path and deletes it afterward unless `TEAMCTX_GITHUB_SMOKE_KEEP=1` is set.

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
