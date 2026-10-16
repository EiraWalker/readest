#requires -Version 7.0
param(
    [Parameter(Mandatory)][long]$RunId,
    [string]$Repository = 'EiraWalker/readest',
    [string]$NotifyThread = $env:CODEX_THREAD_ID,
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) "ReadestCI/$RunId")
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resultPath = Join-Path $OutputDirectory 'completion.json'
$receiptPath = Join-Path $OutputDirectory 'notification-sent.json'

# The process waits; the agent receives one completion message instead of polling.
& gh run watch $RunId --repo $Repository --interval 30 --exit-status *> (Join-Path $OutputDirectory 'watch.log')
$watchExit = $LASTEXITCODE
$run = (& gh api "repos/$Repository/actions/runs/$RunId" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify final GitHub run status; no completion notification sent.' }
if ($run.status -ne 'completed') { throw "Watcher stopped before completion (exit $watchExit); no completion notification sent." }
if ($run.repository.full_name -ne $Repository -or $run.path -ne '.github/workflows/fork-windows.yml') {
    throw 'Unexpected repository or workflow; no completion notification sent.'
}
$artifacts = (& gh api "repos/$Repository/actions/runs/$RunId/artifacts" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Cannot read completed-run artifacts.' }
$result = [ordered]@{
    repository = $Repository
    runId = $RunId
    attempt = $run.run_attempt
    status = $run.status
    conclusion = $run.conclusion
    commit = $run.head_sha
    branch = $run.head_branch
    url = $run.html_url
    artifacts = @($artifacts.artifacts | Where-Object { !$_.expired } | ForEach-Object {
        @{ name = $_.name; url = "$($run.html_url)/artifacts/$($_.id)" }
    })
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath
Write-Output "READEST_CI_COMPLETED $($result | ConvertTo-Json -Depth 5 -Compress)"

if ($NotifyThread) {
    $alreadySent = $false
    if (Test-Path -LiteralPath $receiptPath) {
        $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
        $alreadySent = $receipt.thread -eq $NotifyThread -and $receipt.attempt -eq $run.run_attempt
    }
    if (!$alreadySent) {
        $message = "Readest CI 完成回传：$($run.html_url)。请核对该运行的 GitHub 最终状态与本地结果文件 $resultPath，继续当前任务并报告结果；保留未完成的验证边界，不部署到日常安装。"
        & codex queue --thread $NotifyThread --message $message
        if ($LASTEXITCODE -ne 0) { throw 'CI completed, but Codex queue rejected the notification; completion.json is preserved.' }
        @{ thread = $NotifyThread; attempt = $run.run_attempt; sentAt = [DateTime]::UtcNow.ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $receiptPath
    }
}
if ($run.conclusion -ne 'success') { exit 1 }
