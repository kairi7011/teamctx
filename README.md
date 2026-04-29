# teamctx

`teamctx` is a Git-backed, GitHub-first context layer for AI coding tools.

It is not a new coding agent. It is a local CLI and MCP companion designed to let tools such as Claude Code, Codex, and Cursor read and write the same repo-scoped team context.

## Goal

When multiple people use AI coding tools on the same repository, quality often drifts because each user has different local memory, prompts, settings, and session history.

`teamctx` aims to reduce that drift by binding a local repository to a shared context store and returning a normalized, evidence-aware context payload to the AI tool.

## Design Principles

- Do not build another AI engine.
- Use existing tools such as Claude Code and Codex as the AI runtime.
- Keep user-owned context in user-owned stores.
- Treat raw observations, normalized records, and context payloads as separate layers.
- Do not inject raw logs into AI context.
- Do not require PR, merge, pull, or manual review on every context update.
- Prefer explicit project binding over implicit discovery.

## Memory Model Boundary

`teamctx` keeps the memory model deliberately narrow:

- Working context is the bounded `teamctx.get_context` payload for the current task. It is composed from active normalized records and can be scoped by paths, domains, symbols, tags, deterministic text query, and time filters.
- Episodic memory is represented by raw observations and generated episode references. `get_context` returns episode references only; raw event bodies are not injected by default.
- Semantic memory is the normalized JSONL layer: facts, rules, decisions, workflows, pitfalls, and glossary terms with evidence and state. Retrieval is deterministic and index-backed, not embedding-based.
- Procedural memory is represented as rule, workflow, and pitfall records. Procedures are guidance text, not executable checklists or enforced automation.

Trust labels describe how an observation entered the store, not whether the underlying claim is factually true. A `verified` observation only means a trusted source (typically an AI agent reading code, tests, or docs) recorded it with non-manual evidence; it can still become contested, stale, superseded, or invalidated as the codebase evolves. `candidate` observations stay out of `get_context` payloads until they are explicitly promoted with verifying evidence.

Automatic truth resolution and automatic conflict resolution are intentionally out of scope.

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
