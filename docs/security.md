# Security Guide

Use this guide when choosing where to store `teamctx` data and how to grant
write access.

## What the Store Contains

A context store can contain repository-specific rules, decisions, pitfalls,
workflows, glossary terms, evidence paths, commit identifiers, issue or pull
request references, generated indexes, and audit entries. Treat it as project
knowledge, not as a transcript archive.

Do not record secrets, credentials, customer data, private planning notes, or
raw session transcripts. Keep observations short, durable, and backed by
evidence that is safe for everyone with store access to read.

## Store Visibility

Prefer a private context store. A separate private GitHub repository gives the
team an access boundary that is independent from the application code:

```bash
teamctx setup github.com/my-org/ai-context --path contexts/my-service
```

Same-repository stores such as `.teamctx` are fine for local use or small teams
when the application repository already has the right visibility. If the context
store is public, `teamctx doctor` warns unless `TEAMCTX_ALLOW_PUBLIC_STORE=1` is
set.

## GitHub Token Permissions

Remote GitHub stores use the first token available in this order:

1. `TEAMCTX_GITHUB_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token`

For a fine-grained personal access token, restrict repository access to the
context-store repository and grant:

- `Contents`: read and write
- `Metadata`: read

`teamctx` uses the GitHub Contents API to read, write, and delete files in the
store path. It uses repository metadata to check store visibility in diagnostics.

For a classic personal access token, prefer the narrowest repository scope that
works for your store: `repo` for private repositories or `public_repo` only for
intentionally public stores.

Tokens are read from the environment or `gh`; `teamctx doctor` and
`teamctx auth doctor` report the active auth source without printing token
values.

## Write Policy

The context payload exposes the active write policy:

- `record_observation_candidate`: allowed
- `record_observation_verified`: allowed with evidence
- `invalidate`: human only
- `docs_evidence`: allowed with `doc_role`

Verified observations require at least one non-manual evidence item. Docs
evidence must include `doc_role`. MCP `teamctx.invalidate` requires
`human_confirmed: true`; this keeps agent-triggered invalidation explicit and
auditable. CLI invalidation is treated as a direct human action and writes an
audit entry instead of deleting data.

## Sensitive Content Scanning

Raw observation recording scans text and evidence metadata before writing. It
blocks common secret-shaped content such as API keys, bearer tokens, private key
blocks, high-entropy tokens, and `.env` evidence paths. It warns on common PII
or internal references such as email addresses and internal URLs.

The scanner is a guardrail, not a data-loss-prevention system. Review
observations before recording them, especially when evidence points at private
systems or customer-facing repositories.

## Correction and Response

If a record is obsolete or unsafe to keep in default context, archive it through
the tool surface:

```bash
teamctx invalidate <item-id> --reason "unsafe or obsolete"
teamctx normalize
```

If sensitive data was committed to a context store, rotate any affected token or
credential first. Then remove the data from the repository according to your
normal Git history cleanup process; `teamctx invalidate` archives records for
context behavior but does not erase Git history.
