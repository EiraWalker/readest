# Fork Windows builds

The `Fork Windows Release` workflow builds Windows x64 Release executables and an NSIS installer in `EiraWalker/readest`. It uses hosted runners and needs no repository secrets. Artifacts are unsigned and expire after 7 days. It does not publish a GitHub Release, upload to R2/Sentry, or deploy to a local installation.

## Run a build

Open [Actions → Fork Windows Release](https://github.com/EiraWalker/readest/actions/workflows/fork-windows.yml), select **Run workflow**, select the source branch, and run it. For the prompt settings feature, select `feat/issue-2-copy-explanation-prompt`.

```powershell
gh workflow run fork-windows.yml --repo EiraWalker/readest --ref feat/issue-2-copy-explanation-prompt
gh run list --repo EiraWalker/readest --workflow fork-windows.yml
gh run download RUN_ID --repo EiraWalker/readest --dir ./readest-ci
```

## Receive completion in the current Codex chat

After obtaining the run ID, start the watcher from an asynchronous terminal command:

```powershell
pwsh -NoProfile -File .github/scripts/watch-fork-ci.ps1 -RunId RUN_ID
```

The process waits for GitHub's final run status and returns one `READEST_CI_COMPLETED` JSON signal with the commit, conclusion and artifact links. It saves `completion.json` and `watch.log` under the local temporary `ReadestCI/RUN_ID` directory. Success, failure and cancellation are distinct results. An API error or an unfinished run is never reported as completion.

When `CODEX_THREAD_ID` is set, the watcher also uses the installed `codex queue` command to queue a completion message in that existing chat. An explicit `-NotifyThread THREAD_ID` overrides it; `-NotifyThread ''` disables chat delivery. The thread ID stays local. Repeated watcher invocations do not resend a successful notification for the same run attempt and chat. A failed queue operation preserves the result and reports an error so delivery can be retried.

Keep the watcher process and the local Codex service available. This is a local receiver, not a public webhook; CI needs no Codex credentials. The agent must start the watcher for each build it launches. Arbitrary builds started elsewhere do not automatically wake a chat. The workflow also publishes a `Readest-ci-result-RUN_ID-ATTEMPT` JSON artifact after both jobs finish; even if cancellation prevents that job from starting, the watcher reads GitHub's authoritative cancelled state.

Source pushes also trigger builds when app, dependency, submodule or CI files change. A newer run cancels an older run for the same branch. Keep the workflow and its PowerShell script on any branch you want to build; the default branch also needs the workflow for manual dispatch.

## Results

The `checks` job runs format, TypeScript/Biome, watcher contract checks and the full unit suite on Ubuntu with two workers. The `windows` job builds on a separate Windows runner with Node 24.13.0, pnpm from `packageManager`, Rust 1.99.0 and cached dependencies. These jobs do not compete for one machine's memory. A failed check remains a failed workflow even if the Windows artifact was produced.

Windows measures the runner's logical CPUs and physical memory before building. Cargo/frontend parallelism uses the available CPUs with a 4 GiB OS reserve and a 2.5 GiB budget per task (normally four tasks on the standard 4 CPU / 16 GiB runner). Node's heap is sized separately; frontend and Rust phases run sequentially. Only the Windows Readest package gets `codegen-units=16`; Release optimization remains enabled and Android's checked-in profile is unchanged.

The native cache includes Cargo registry/git files, the root target directory including workspace outputs, and the thumbnail DLL's separate target directory. It uses a toolchain/configuration/commit key with compatible-prefix restore, preserving newer outputs in a new immutable cache for each commit. The first optimized run can seed dependencies from the original CI cache. Cargo still validates freshness: a restored archive does not imply every crate is reusable. Incremental compilation remains disabled to limit memory and cache size. The frontend's `.next/cache` is also restored/saved per commit; pnpm retains its lockfile cache. GitHub can evict caches when the repository quota is reached.

Each Windows run uploads `Readest-build-diagnostics-RUN_ID-ATTEMPT` with detected resources, 15-second memory samples, elapsed build time and Cargo's HTML timing report. Samples are observations, not an exact measurement of instantaneous peak memory. Use these and the cache restore logs to compare cold and warm runs.

Download the artifact from the run summary. It contains:

- `Readest/readest.exe` and `Readest/readest_thumbnail.dll` for manual extraction or deployment.
- An NSIS `*-setup.exe` installer.
- `build-info.json` with the exact commit, branch, toolchain and run URL.
- `SHA256SUMS.txt` for verifying extracted files.

The package does not include `settings.json`, a library, or local credentials. Preserve existing settings and books when deploying. Building in CI does not replace Windows interaction acceptance; check the exact downloaded executable before updating a daily installation. Existing Issue #3 results remain separate from this workflow's results.

This workflow has read-only repository permissions. It does not need upstream signing, publishing or cloud-service secrets. Existing upstream publishing workflows are not used by this build.
