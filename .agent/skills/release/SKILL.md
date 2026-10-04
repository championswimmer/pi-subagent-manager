---
name: release
description: Make a major, minor, or patch release of pi-subagent-manager. Use when asked to cut, bump, or publish a release.
---

# Release

Pushing a version tag triggers GitHub Actions, which publishes to npm. Never run `npm publish` locally.

1. Ask for the bump (`major`, `minor`, `patch`) if not given. Be on a clean, up-to-date `main`.

2. Bump, then push the commit and tag:
   ```sh
   npm version <bump>
   git push origin main --follow-tags
   TAG="v$(node -p "require('./package.json').version")"
   ```

3. Monitor the workflow until it finishes:
   ```sh
   gh run list --workflow release.yml --branch "$TAG" --limit 1
   gh run watch <run-id> --exit-status
   ```
   If it fails, check `gh run view <run-id> --log-failed` and report. Don't re-tag.

4. Confirm npm shows the version (retry for a few minutes):
   ```sh
   npm view pi-subagent-manager@"${TAG#v}" version
   ```

Report the version, run URL, and whether npm shows it.
