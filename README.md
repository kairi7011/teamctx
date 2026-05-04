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
teamctx bootstrap
```

Or bind to a separate GitHub context store:

```bash
teamctx bootstrap github.com/my-org/ai-context --path contexts/my-service
```

You can also run setup one step at a time:

```bash
teamctx bind . --path .teamctx
teamctx init-store
teamctx bootstrap
```

`bootstrap` initializes the store if needed, detects likely project source files
such as README, agent instructions, docs, package metadata, and CI config, then
prints an agent prompt for creating the first reviewed observation batch. It does
not automatically save broad summaries as verified knowledge.

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

See [Operations Guide](docs/operations-guide.md) for team cadence, inspection,
correction, and compaction workflows.

See [Security Guide](docs/security.md) for store visibility, GitHub token
permissions, write policy, and sensitive-content handling.

## GitHub Auth

Remote GitHub stores use the first token available in this order:

1. `TEAMCTX_GITHUB_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token`

Prefer `TEAMCTX_GITHUB_TOKEN` when you want credentials scoped specifically to `teamctx`.
The token must be able to read and write the repository that holds the context
store. Local stores such as `.teamctx` do not need a GitHub token.

For a fine-grained GitHub token, restrict repository access to the context-store
repository and grant `Contents` read/write plus `Metadata` read. For a classic
token, use `repo` for private stores or `public_repo` only for intentionally
public stores.

Use `teamctx doctor` to check which auth source is active.
Use `teamctx auth doctor` to diagnose GitHub auth without printing token values.

Record project knowledge:

```bash
teamctx first-record > observations.json
teamctx record-verified observations.json
teamctx normalize
```

Capture durable knowledge after a meaningful work batch:

```bash
teamctx capture
teamctx capture --since-ref origin/main
```

Preview context for a task:

```bash
teamctx context --target-files src/index.ts --domains cli --query "record verified"
teamctx context context-input.json
```

## Context Call Policy

Keep `teamctx` registered with your MCP client, but do not treat registration as
permission to inject context on every turn.

The intended policy is:

- call `teamctx.get_context` once at the start of a new AI session;
- after that, refresh only when the user explicitly asks for team context or the
  working set materially changes;
- pass `previous_context_payload_hash` on later calls so unchanged context can
  return a lightweight response instead of reinjecting the same payload;
- use `force_refresh: true` only for an explicit user request or a deliberate
  diagnostic check.

For MCP clients, set `call_reason` to `session_start`, `task_start`,
`context_changed`, or `explicit_user_request`. A matching
`previous_context_payload_hash` suppresses repeated injection for non-explicit
refreshes. Session-start and explicit-user-request calls always return full
context.

CLI preview supports the same policy fields:

```bash
teamctx context --call-reason session_start --target-files src/index.ts
teamctx context --call-reason task_start --previous-context-payload-hash sha256:...
teamctx context --call-reason explicit_user_request --force-refresh
```

## Common Commands

Set up a repository:

```bash
teamctx setup . --path .teamctx
teamctx setup . --path .teamctx --json
teamctx bootstrap . --path .teamctx
teamctx bootstrap --json
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

Check long-term context hygiene:

```bash
teamctx hygiene --older-than-days 90
teamctx hygiene --older-than-days 90 --large-record-tokens 250 --plan
teamctx hygiene --older-than-days 90 --large-record-tokens 250 --plan --json
teamctx supersede-draft rule-a rule-b --json
```

`hygiene` reports active records that are expired, not yet valid, old,
unverified, duplicated, crowded under the same scope, or too large before
context truncation. Add `--plan` to group those risks into a read-only
maintenance plan with review commands, candidate write commands, and incomplete
observation drafts in `--json` output. Drafts intentionally have empty evidence
so `record-verified` rejects them until evidence review is complete. The plan
does not auto-delete or auto-merge records. Use `supersede-draft` to generate a
review-only replacement draft for one or more existing records, then fill
evidence and run `record-verified` only after the replacement fully covers every
listed `supersedes` id.

Inspect one normalized record:

```bash
teamctx show workflow-example
teamctx explain workflow-example
teamctx invalidate workflow-example --reason "obsolete" --json
```

Use `show` when you want a human-readable view of one record. Use `explain`
when you need the full JSON evidence, provenance, state, and audit trail. Use
`invalidate` when a record is obsolete or unsafe to keep in default context; the
record is archived with an audit entry instead of being deleted silently.

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
teamctx bootstrap
teamctx capture
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

Use `compact --dry-run` before maintenance to inspect which raw candidate
events, audit entries, and archived records would move. Compaction keeps active
normalized records in place and moves expired retention targets under the
configured archive path.

Context text budgets are approximate token budgets. Configure them in `project.yaml`:

```yaml
context_budgets:
  scoped_items: 20
  content_tokens: 300
```

Older `content_chars` settings are still accepted and converted to approximate tokens.

Project query aliases can be kept in `aliases/query-aliases.json` inside the
context store. They expand known team wording into deterministic text-index
tokens without adding embeddings or a database:

```json
{
  "schema_version": 1,
  "aliases": [
    {
      "id": "release-handoff",
      "match": { "patterns": ["ship it"] },
      "expand": { "token_groups": [["release", "handoff"]] }
    }
  ]
}
```

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
