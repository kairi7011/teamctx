# Storage and Concurrency

`teamctx` can store context in a local path or in a GitHub repository through
the GitHub Contents API.

## Revisions

Context store adapters expose two revision concepts:

- `revision`: the version of one file in the context store.
- `storeRevision`: the repository commit after a write, when the adapter can
  report one.

Local stores do not have file revisions, so local adapter revisions are `null`.
GitHub stores use the content SHA returned by the Contents API as the file
revision and the write commit SHA as the store revision.

## Expected Revisions

Writes that replace an existing file pass `expectedRevision` when the caller has
read the previous file. For GitHub stores this becomes the `sha` field on the
Contents API request.

This protects replacement writes from silently overwriting a newer version of
the same file. If GitHub reports a conflict, the operation fails unless the
caller has an explicit retry path.

New-file writes use `expectedRevision: null`. That means the write is expected
to create the file. If another writer creates the same path first, GitHub can
reject the request as a conflict.

## JSONL Appends

GitHub cannot append to a file directly through the Contents API. The GitHub
adapter implements `appendJsonl` as:

1. Read the current file content and content SHA.
2. Add the serialized JSONL rows to the end.
3. Write the whole file back with `expectedRevision` set to the SHA that was
   just read.
4. If GitHub reports a conflict, reread and retry.

The default retry limit is 3 attempts. If the limit is reached, the conflict is
returned to the caller.

## Advisory Lease Design

Optimistic file revisions protect individual writes, but they do not coordinate
multi-file operations such as `teamctx normalize`. A later implementation can
add an optional advisory lease for remote stores before starting those
operations.

The lease should be stored inside the configured context store path:

```text
locks/normalize.json
```

The file should be ordinary JSON so users can inspect and recover it without a
special binary format:

```json
{
  "format_version": 1,
  "operation": "normalize",
  "lease_id": "lease-...",
  "owner": {
    "tool": "teamctx",
    "hostname": "devbox",
    "pid": 12345
  },
  "created_at": "2026-05-02T00:00:00.000Z",
  "expires_at": "2026-05-02T00:05:00.000Z",
  "store_revision": "abc123"
}
```

### Acquire

To acquire the lease, the caller reads `locks/normalize.json`.

- If the file is missing, create it with `expectedRevision: null`.
- If the file exists and `expires_at` is in the future, stop before writing and
  report the current owner and expiry time.
- If the file exists but is expired, replace it with `expectedRevision` set to
  the file revision that was just read.

If GitHub rejects the create or replace request because another writer won the
race, the caller rereads the lease and reports the current owner. The acquire
path should not spin indefinitely.

### Renew and Release

Long-running operations may renew the lease by replacing the same file with the
same `lease_id` and a later `expires_at`, again using the last read file
revision as `expectedRevision`.

On success or failure, the owner should release the lease by deleting or
replacing `locks/normalize.json` only when the file still contains its
`lease_id`. If release fails, the lease expires naturally and `status` can show
it as stale.

### Recovery

An expired lease is advisory, not proof that the previous writer failed. The
next writer may take over only after reporting the expired owner and replacing
the lease through an expected-revision write. A future `teamctx status` check
should surface:

- no active normalize lease
- active lease with owner and expiry
- expired lease with recovery guidance

Manual recovery should remain possible by deleting the lock file through normal
Git/GitHub tools, but that should not be the first-line workflow.

### Guarantees and Limits

The lease is a coordination hint, not a transaction boundary:

- It reduces concurrent normalize runs when all writers honor it.
- It does not prevent a legacy client or manual edit from writing without the
  lease.
- It does not make the multi-file normalize sequence atomic.
- It does not replace per-file `expectedRevision` checks or append retries.

The lease design should be reused for later background jobs, with operation
names such as `compact`, `index-refresh`, or job-specific ids when concurrent
different operations become safe.

Current implementation status:

- `teamctx normalize --lease` enables the remote normalize lease for one run.
- MCP callers can pass `use_lease: true` to `teamctx.normalize`.
- Local same-repository stores do not use the lease path.
- The default remains lease-free so no-op remote normalize runs can still avoid
  extra lock acquire / release commits.

## Failure Cases

Concurrent writers can still observe failures:

- Two replacement writes to the same normalized shard can conflict.
- A new-file write can fail if another writer creates the same path first.
- Append retry can fail if the file keeps changing faster than the retry loop.
- A multi-file operation can partially complete because GitHub Contents writes
  one file per commit.

Use `teamctx normalize --dry-run` before large normalize operations when you
want to inspect planned writes. Use `teamctx status`, `teamctx query-explain`,
and `teamctx audit` to inspect the store after a failed or interrupted operation.

## Normalize Transaction

`teamctx normalize` is not atomic across files. The store can write each step
independently, and a crash, network error, or permissions failure between
steps leaves earlier writes in place.

The normalize run writes files in this fixed order:

1. `normalized/<kind>.jsonl` for each knowledge kind.
2. `indexes/path-index.json`, `indexes/symbol-index.json`, `indexes/text-index.json`.
3. `indexes/episode-index.json`.
4. Append to `audit/changes.jsonl` for created, transitioned, and dropped entries.
5. `indexes/last-normalize.json` with the run id, run timestamp, and counts.

`indexes/last-normalize.json` is written last on purpose. It records the
"successfully completed" marker for the run. A reader that finds index files
older than `last-normalize.json` knows the indexes are stale, and a reader
that finds normalized records newer than `last-normalize.json` knows the
indexes were not refreshed yet.

### Partial States

If the run is interrupted between two of those steps, the store can be left
in any of the following states:

- Some normalized shards have been replaced and others still contain the
  previous run's content.
- Normalized shards reflect the new run, but `indexes/path-index.json`,
  `indexes/symbol-index.json`, `indexes/text-index.json`, or
  `indexes/episode-index.json` were not updated.
- All normalized shards and indexes were written, but `audit/changes.jsonl`
  did not receive the new entries.
- Audit entries were appended, but `indexes/last-normalize.json` was not
  updated. In this case, `last-normalize.json` still points at an earlier run.

The current implementation does not write a separate "transaction in
progress" marker. Detection of a partial run is observational, not
transactional.

### Detection

`teamctx status` flags index freshness against `indexes/last-normalize.json`
and reports stale, missing, or invalid generated indexes with a recovery
suggestion to rerun `teamctx normalize`. `teamctx query-explain` reports
the same index warnings on a per-query basis. `teamctx audit` shows recently
written audit entries grouped by `run_id`, so a partially recorded run is
visible when its audit entries do not match the latest `run_id` in
`indexes/last-normalize.json`.

### Recovery

The recovery for a partial run is to rerun `teamctx normalize`. Normalize is
idempotent against the same input raw events:

- Record ids are derived from `(kind, text, scope)` and stay stable across
  runs.
- Existing records found on disk are reused; "created" audit entries are not
  emitted for records that already exist.
- `writeIfChanged` skips a remote write when the new content equals the
  current file content, so a successful previous step does not produce a
  redundant commit on rerun.
- A new `run_id` is assigned for each rerun, so audit entries from the
  recovery run are distinguishable from the interrupted run.

If a previous run wrote audit entries but did not update
`indexes/last-normalize.json`, those audit entries remain in the log; the
recovery run appends new entries with a new `run_id` rather than rewriting
old entries. If a previous run wrote some normalized shards but not others,
the recovery run rereads the partial state, recomputes records from raw
events, and writes any shards whose content changed.

`teamctx normalize --dry-run` can be used after a failure to preview the
planned writes before applying them.

### Limitations

- A single normalize run can produce multiple GitHub commits, one per
  changed file. There is no atomic "publish" point on GitHub.
- Two concurrent normalize runs are not coordinated. Both will read the
  same starting state and may race each other on shared files. Optimistic
  retry resolves single-file conflicts, but two runs that both succeed can
  still leave the audit log with interleaved entries from different
  `run_id` values. Use `teamctx normalize --lease` for opt-in remote normalize
  coordination.
- A partially appended `audit/changes.jsonl` line cannot currently be
  detected and removed automatically. JSONL readers skip blank lines, so a
  truncated final line will fail validation on the next read; manual
  removal is required in that case.

