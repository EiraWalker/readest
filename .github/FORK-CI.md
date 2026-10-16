# Fork Windows builds

The `Fork Windows Release` workflow builds Windows x64 Release executables and an NSIS installer in `EiraWalker/readest`. It uses hosted runners and needs no repository secrets. Artifacts are unsigned and expire after 7 days. It does not publish a GitHub Release, upload to R2/Sentry, or deploy to a local installation.

## Run a build

Open [Actions → Fork Windows Release](https://github.com/EiraWalker/readest/actions/workflows/fork-windows.yml), select **Run workflow**, select the source branch, and run it. For the prompt settings feature, select `feat/issue-2-copy-explanation-prompt`.

```powershell
gh workflow run fork-windows.yml --repo EiraWalker/readest --ref feat/issue-2-copy-explanation-prompt
gh run list --repo EiraWalker/readest --workflow fork-windows.yml
gh run download RUN_ID --repo EiraWalker/readest --dir ./readest-ci
```

Source pushes also trigger builds when app, dependency, submodule or CI files change. A newer run cancels an older run for the same branch. Keep the workflow and its PowerShell script on any branch you want to build; the default branch also needs the workflow for manual dispatch.

## Results

The `checks` job runs format, TypeScript/Biome and the full unit suite on Ubuntu with two workers. The `windows` job builds on a separate Windows runner with Node 24.13.0, pnpm from `packageManager`, Rust 1.99.0 and cached dependencies. These jobs do not compete for one machine's memory. A failed check remains a failed workflow even if the Windows artifact was produced.

Download the artifact from the run summary. It contains:

- `Readest/readest.exe` and `Readest/readest_thumbnail.dll` for manual extraction or deployment.
- An NSIS `*-setup.exe` installer.
- `build-info.json` with the exact commit, branch, toolchain and run URL.
- `SHA256SUMS.txt` for verifying extracted files.

The package does not include `settings.json`, a library, or local credentials. Preserve existing settings and books when deploying. Building in CI does not replace Windows interaction acceptance; check the exact downloaded executable before updating a daily installation. Existing Issue #3 results remain separate from this workflow's results.

This workflow has read-only repository permissions. It does not need upstream signing, publishing or cloud-service secrets. Existing upstream publishing workflows are not used by this build.
