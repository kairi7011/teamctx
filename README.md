# teamctx

`teamctx` is a local CLI and MCP context layer for AI coding tools.

## Goal

When multiple people use AI coding tools on the same repository, useful project knowledge often stays trapped in individual sessions.

`teamctx` binds a repository to a shared context store, records observations with evidence, normalizes them, and returns bounded context to compatible AI tools.

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

## Quickstart

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

Record project knowledge:

```bash
teamctx record-verified observations.json
teamctx normalize
```

Preview context for a task:

```bash
teamctx context --target-files src/index.ts --domains cli --query "record verified"
teamctx context context-input.json
```

## Common Commands

Check the current binding:

```bash
teamctx status
teamctx status --json
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

## License

MIT
