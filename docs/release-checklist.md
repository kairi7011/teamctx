# Release Checklist

Use this checklist before publishing a `teamctx` release.

1. Confirm the working tree is clean.

   ```bash
   git status --short
   ```

2. Run the full local gate.

   ```bash
   npm.cmd run ci
   ```

3. Confirm package metadata and published files.

   ```bash
   npm pack --dry-run
   ```

4. Check the installed CLI path with the smoke test included in CI.

   ```bash
   npm.cmd run smoke:install
   ```

5. Update `CHANGELOG.md` with the release version and date.

6. Confirm README examples still match the current CLI help.

   ```bash
   node dist/cli/index.js --help
   ```

7. Create and push the release commit and tag.

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

8. Publish from a clean checkout after CI passes.

   ```bash
   npm publish
   ```

