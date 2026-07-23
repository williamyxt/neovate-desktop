# GitHub CI-Based Release Process

**Date**: 2026-03-15
**Source**: Adapted from `neovate-code-desktop` CI/release workflows

## Context

neovate-code-desktop has a working CI/release pipeline:

- CI builds dev artifacts on every push/PR, posts download links to PRs
- Tag push (`v*`) triggers a publish workflow that builds, signs, notarizes, and publishes to GitHub Releases
- `npx bumpp` handles version bumping + tag creation

neovate-desktop currently only has a CI workflow with `check` (format+lint+types+tests) and `e2e` jobs. No build artifacts, no release pipeline.

## Key Differences Between Repos

| Aspect            | neovate-code-desktop           | neovate-desktop                                 |
| ----------------- | ------------------------------ | ----------------------------------------------- |
| Package manager   | npm                            | bun                                             |
| Structure         | single package                 | monorepo (`packages/desktop/`)                  |
| Linter/Formatter  | biome                          | oxlint + oxfmt                                  |
| Build script      | `npm run package`              | `bun run build:mac`                             |
| Build config path | `configs/electron-builder.mjs` | `packages/desktop/configs/electron-builder.mjs` |
| Node setup        | `actions/setup-node@v4`        | `oven-sh/setup-bun@v2`                          |

## Changes

### 1. Release workflows

`publish.yml` is the main tag-release workflow. It builds production macOS packages for arm64 + x64 first, then runs a native Windows packaging job on `windows-latest` and uploads the Windows installer into the same draft GitHub Release.

`publish-windows.yml` remains as a manual fallback workflow (`workflow_dispatch`) for Windows-only rebuilds and recovery runs.

Draft behavior is handled by `releaseType: "draft"` in the electron-builder config, so the release is created as a draft from the very first upload — no race condition where users see a half-uploaded public release. `electron-updater` correctly ignores drafts, so auto-update only triggers after you manually publish.

All build commands run from `packages/desktop/` directly to avoid `bun run --filter` arg-forwarding issues.

```yaml
name: Release macOS

on:
  push:
    tags:
      - "v*"

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: write

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Verify tag is on master
        run: |
          if ! git merge-base --is-ancestor ${{ github.sha }} origin/master; then
            echo "Tag must be on master branch"
            exit 1
          fi
      - name: Verify tag matches package.json version
        run: |
          TAG_VERSION="${{ github.ref_name }}"
          TAG_VERSION="${TAG_VERSION#v}"
          PKG_VERSION=$(node -p "require('./packages/desktop/package.json').version")
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "Tag version ($TAG_VERSION) does not match package.json version ($PKG_VERSION)"
            exit 1
          fi

  build-mac:
    needs: preflight
    strategy:
      matrix:
        include:
          - os: macos-latest
            arch: arm64
          - os: macos-15-intel
            arch: x64
    runs-on: ${{ matrix.os }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
      - name: Setup bun
        uses: oven-sh/setup-bun@v2
      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: |
            ${{ runner.os }}-bun-
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Build and publish
        working-directory: packages/desktop
        run: bun run build && electron-builder --mac --${{ matrix.arch }} --config configs/electron-builder.mjs --publish=always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

### 2. Enhanced CI: `.github/workflows/ci.yml`

Add two new jobs after existing `check`:

- **build-mac-dev**: matrix build (arm64 + x64) producing dev artifacts, upload as GitHub Actions artifacts with size info and `retention-days: 7` to limit storage usage
- **comment**: post PR comment with download links and artifact sizes (only on PRs from same repo)

Keep existing `check` and `e2e` jobs unchanged. `build-mac-dev` depends on `check`. Only runs on `pull_request` events (not on push to master, since macOS runners are 10x the cost of Linux runners and dev artifacts are only useful for PR review).

All build commands run from `packages/desktop/` directly.

### 3. Release script in root `package.json`

```json
{
  "scripts": {
    "release": "bunx bumpp packages/desktop/package.json"
  }
}
```

Points bumpp at the correct `package.json` in the monorepo (root is private with version `0.0.0`). No need to add `bumpp` as a devDependency since `bunx` handles it.

## Release Flow

1. Developer runs `bun run release`
2. `bumpp` prompts for version bump (patch/minor/major)
3. `bumpp` updates `packages/desktop/package.json` version, commits, creates `v*` tag, pushes
4. Tag push triggers `publish.yml`
5. Preflight job verifies the tag is on master
6. GitHub Actions builds macOS arm64 + x64, signs, notarizes, and creates/updates a draft release
7. GitHub Actions builds the Windows installer natively on `windows-latest` and uploads the `.exe` into the same draft release
8. Developer reviews and publishes the draft release manually
9. `electron-updater` in the app picks up the published release automatically

## Required GitHub Secrets

- `CSC_LINK` - Base64-encoded .p12 certificate for code signing
- `CSC_KEY_PASSWORD` - Certificate password
- `APPLE_ID` - Apple ID for notarization
- `APPLE_APP_SPECIFIC_PASSWORD` - App-specific password for notarization
- `APPLE_TEAM_ID` - Apple Developer Team ID
- `ORCHIDEA_PROTOCOL_REPO` - Repository variable pointing to the sibling protocol repo used by `file:../../../orchidea-protocol`

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Notes

### 4. Update electron-builder config: `packages/desktop/configs/electron-builder.mjs`

Add `releaseType: "draft"` to the `publish` config so releases are created as drafts from the start:

```js
publish: [
  {
    provider: "github",
    owner: "neovateai",
    repo: "neovate-desktop",
    releaseType: "draft",
  },
],
```

## Notes

- The electron-builder config already has the correct `publish` config pointing to `github/neovateai/neovate-desktop`
- The `beforePack` hook in the config downloads bun for the target arch, which needs network access during CI builds
- Dev builds use `BUILD_ENV=dev` which changes app ID, name, icon, and compression level
- All CI build steps use `working-directory: packages/desktop` and invoke standardized package scripts or `electron-builder` directly, avoiding arg-forwarding issues with `bun run --filter`
- Native Windows packaging is intentionally performed on `windows-latest`; the local macOS cross-build path is not a supported release path because NSIS installer generation is not reliable there for the current offline runtime payload
- `bun run build:win` is the default Windows installer entrypoint. It now hard-fails on non-Windows hosts and cleans any stale partial `.exe` outputs so the default path always means "generate a real installer on native Windows"
