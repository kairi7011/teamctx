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

Set up the current repository with a local context store:

```bash
teamctx setup . --path .teamctx
```

Or bind to a separate GitHub context store:

```bash
teamctx setup github.com/my-org/ai-context --path contexts/my-service
```

You can also run setup one step at a time:

```bash
teamctx bind . --path .teamctx
teamctx init-store
```

## Context Store

For a single repository or a small team, keep the context store in the same repo:

```bash
teamctx setup . --path .teamctx
```

For shared context across multiple repos or a cleaner code/history boundary, use
a separate private GitHub repository:

```bash
teamctx setup github.com/my-org/ai-context --path contexts/my-service
```

Keep context stores private unless the stored knowledge is safe to publish. A
separate private repo lets you manage access to team context independently from
the application code.

See [Storage and Concurrency](docs/storage-concurrency.md) for GitHub store
revision and retry behavior.

## GitHub Auth

Remote GitHub stores use the first token available in this order:

1. `TEAMCTX_GITHUB_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token`

Prefer `TEAMCTX_GITHUB_TOKEN` when you want credentials scoped specifically to `teamctx`.
The token must be able to read and write the repository that holds the context
store. Local stores such as `.teamctx` do not need a GitHub token.

Use `teamctx doctor` to check which auth source is active.
Use `teamctx auth doctor` to diagnose GitHub auth without printing token values.

Record project knowledge:

```bash
teamctx first-record > observations.json
teamctx record-verified observations.json
teamctx normalize
```

Preview context for a task:

```bash
teamctx context --target-files src/index.ts --domains cli --query "record verified"
teamctx context context-input.json
```

## Common Commands

Set up a repository:

```bash
teamctx setup . --path .teamctx
teamctx setup . --path .teamctx --json
```

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
teamctx first-record > observations.json
teamctx record-verified observations.json
teamctx record-verified observations.json --json
teamctx normalize --dry-run
teamctx normalize --json
teamctx normalize
```

`teamctx first-record` prints an editable starter observation. Replace the text,
scope, and evidence with one repo-specific fact before recording it. The file can
contain one observation object or an array of observation objects. Verified
observations must include non-manual evidence. The `verified` label describes
provenance, not truth: records can still transition to `contested`, `stale`,
`superseded`, or `archived` over time.

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
teamctx auth doctor
teamctx tools --json
```

Run the MCP server during local development:

```bash
node dist/mcp/server.js
```

## MCP Client Setup

`teamctx-mcp` starts the stdio MCP server from an installed package. During
local development, run `npm run build` first and point the client at
`node dist/mcp/server.js` instead.

Register with Codex:

```bash
codex mcp add teamctx -- teamctx-mcp
codex mcp list
```

Local development registration:

```bash
codex mcp add teamctx-dev -- node C:\path\to\teamctx\dist\mcp\server.js
```

You can also add the server directly to `~/.codex/config.toml`:

```toml
[mcp_servers.teamctx]
command = "teamctx-mcp"
```

Register with Claude Code:

```bash
claude mcp add --transport stdio teamctx -- teamctx-mcp
claude mcp list
```

On native Windows, if the client cannot launch the npm command shim directly,
wrap it with `cmd /c`:

```bash
claude mcp add --transport stdio teamctx -- cmd /c teamctx-mcp
```

Verify the connection from the client by calling `teamctx.status` or
`teamctx.get_context` from a repository that has already run `teamctx setup`.
Use `teamctx tools --json` to inspect the MCP tool names, descriptions, and
input schemas without starting an MCP client.

## Troubleshooting

Start with:

```bash
teamctx doctor
teamctx status
```

If `teamctx.status` or `teamctx.get_context` says no binding exists, run setup
from the repository root:

```bash
teamctx setup . --path .teamctx
```

For a separate GitHub context store, use the same store and path that the team
expects:

```bash
teamctx setup github.com/my-org/ai-context --path contexts/my-service
```

If GitHub auth fails, check the active auth source:

```bash
teamctx auth doctor
```

Set `TEAMCTX_GITHUB_TOKEN` or `GITHUB_TOKEN`, or sign in with `gh auth login`.
The token must be able to read and write the repository that stores context.

If context looks stale or index warnings appear, refresh normalized records and
indexes:

```bash
teamctx normalize --dry-run
teamctx normalize
teamctx status
```

If an MCP client reports that `teamctx` is disabled or returns no context, first
run `teamctx status` in the same repository. A disabled response usually means
the client started the server outside a Git repository or in a repo that has not
been set up yet. Pass `cwd` in the MCP tool input when the client supports it,
or start the client from the repository root.

## License

MIT
