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

