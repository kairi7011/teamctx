# Operations Guide

Use this guide when a team shares one `teamctx` context store.

## Store Ownership

Choose one store per repository or service boundary. For a small team, a local
`.teamctx` directory in the application repository is enough. For shared context
across machines or repositories, prefer a separate private GitHub repository and
bind each application repo to its own path inside that store:

```bash
teamctx setup github.com/my-org/ai-context --path contexts/my-service
```

Keep the context store private unless every recorded observation, evidence path,
and audit entry is safe to publish.

See [Security Guide](security.md) for token permissions, store visibility, and
sensitive-content handling.

## Initial Bootstrap

After binding a store, bootstrap the first context batch:

```bash
teamctx bootstrap
```

Or use bootstrap as the first command for a new remote store:

```bash
teamctx bootstrap github.com/my-org/ai-context --path contexts/my-service
```

Bootstrap initializes the store if needed, detects likely source files for the
first context pass, and prints an agent prompt for creating
`teamctx-bootstrap-observations.json`. It does not auto-save broad summaries as
verified knowledge. Review the generated observations, then record and normalize
them:

```bash
teamctx record-verified teamctx-bootstrap-observations.json
teamctx normalize --dry-run
teamctx normalize
```

## Recording Cadence

Record knowledge when it changes how future work should be done:

- rules that should be followed repeatedly
- pitfalls that caused real failures
- decisions that explain current behavior
- workflows that make a repeated task safer or faster
- glossary terms that prevent project-specific ambiguity

Prefer verified observations when a file, commit, issue, pull request, or doc can
be cited as evidence:

```bash
teamctx first-record > observations.json
teamctx record-verified observations.json
teamctx normalize --dry-run
teamctx normalize
```

Candidate observations are useful for notes that still need review. They stay out
of default context until normalization can promote them.

## Maintenance Cadence

Run this after a meaningful batch of records, after merging context-affecting
changes, or before starting important AI-assisted work:

```bash
teamctx normalize --dry-run
teamctx normalize
teamctx status
```

For remote GitHub stores where multiple writers may normalize at the same time,
use the advisory lease:

```bash
teamctx normalize --lease
```

If status reports stale or missing indexes, rerun `teamctx normalize`. Normalize
is idempotent for the same raw events and skips unchanged remote writes.

## Inspection and Correction

Use human-readable commands first:

```bash
teamctx list --state active --limit 20
teamctx show <item-id>
teamctx audit --item <item-id>
```

Use `explain` when you need the full JSON detail, including evidence,
provenance, state, and audit history:

```bash
teamctx explain <item-id>
```

If a record is obsolete or unsafe to keep in default context, archive it with an
explicit reason:

```bash
teamctx invalidate <item-id> --reason "obsolete"
teamctx normalize
```

Invalidation is audited. It should be preferred over manual deletion for normal
correction workflows.

## Compaction

Compaction moves expired retention targets into the configured archive path. It
does not remove active normalized records from default context.

Preview before applying:

```bash
teamctx compact --dry-run
teamctx compact
teamctx status
```

Run compaction during low-traffic maintenance windows for shared remote stores.
If a previous normalize or compact operation may have been interrupted, inspect
`teamctx status`, `teamctx query-explain`, and `teamctx audit` before compacting.

## MCP Usage

Register `teamctx-mcp` once per machine, then start clients from a repository
that has already run `teamctx setup`. When a client supports tool input `cwd`,
pass the target repository path explicitly so context lookup uses the intended
binding.

Check the tool surface without starting an MCP client:

```bash
teamctx tools --json
```

## Team Hygiene

Review context regularly:

- weekly: inspect `status`, active rules, stale items, and recent audit entries
- after releases: invalidate outdated workflows or decisions
- after incidents: record the pitfall and the corrected workflow
- after large refactors: normalize and check for stale evidence paths

Do not use `teamctx` as a transcript dump. Store short, durable knowledge with
evidence. Keep private planning and temporary agent notes outside public
repositories unless they are intentionally part of the shared context store.
