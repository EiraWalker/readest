#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$app = Join-Path $repo 'apps/readest-app'
$next = Join-Path $app 'next.config.mjs'
$original = [IO.File]::ReadAllBytes($next)
$diagnostics = Join-Path $repo 'ci-diagnostics'
New-Item -ItemType Directory -Force -Path $diagnostics | Out-Null
$os = Get-CimInstance Win32_OperatingSystem
$memoryGiB = $os.TotalVisibleMemorySize / 1MB
$cpus = [Environment]::ProcessorCount
# Reserve 4 GiB for Windows, then budget 2.5 GiB per concurrent Cargo task.
$jobs = [Math]::Min($cpus, [Math]::Max(1, [Math]::Floor(($memoryGiB - 4) / 2.5)))
$heapMiB = [Math]::Min(8192, [Math]::Max(2048, [Math]::Floor($memoryGiB * 384)))
$env:CARGO_BUILD_JOBS = "$jobs"
$env:GOMAXPROCS = "$jobs"
$env:RAYON_NUM_THREADS = "$jobs"
$env:NODE_OPTIONS = "--max-old-space-size=$heapMiB"
$resources = [ordered]@{
    logicalProcessors = $cpus
    physicalMemoryGiB = [Math]::Round($memoryGiB, 2)
    availableMemoryGiB = [Math]::Round($os.FreePhysicalMemory / 1MB, 2)
    cargoJobs = $jobs
    nodeHeapMiB = $heapMiB
    readestCodegenUnits = 16
}
$resources | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $diagnostics 'resources.json')
Write-Output "Runner resources: $($resources | ConvertTo-Json -Compress)"
$overlay = Join-Path $env:RUNNER_TEMP 'readest-fork-build.json'
@{ bundle = @{ createUpdaterArtifacts = $false } } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $overlay
$cargoConfig = Join-Path $env:RUNNER_TEMP 'readest-fork-cargo.toml'
"[profile.release.package.Readest]`ncodegen-units = 16`n" | Set-Content -LiteralPath $cargoConfig

# Limit frontend workers on the runner without changing the checked-in config.
$text = [Text.Encoding]::UTF8.GetString($original)
if ([regex]::Matches($text, '(?m)^  experimental: \{').Count -ne 1) {
    throw 'Next config layout changed; review the CI worker override.'
}
$text = $text.Replace('  experimental: {', "  experimental: {`n    cpus: $jobs,")
$samples = Join-Path $diagnostics 'memory-samples.jsonl'
$monitor = Start-Job -ArgumentList $samples -ScriptBlock {
    param($path)
    while ($true) {
        $processes = @(Get-Process rustc, link, node -ErrorAction SilentlyContinue)
        $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        @{
            time = [DateTime]::UtcNow.ToString('o')
            commitBytes = $memory.CommittedBytes
            commitLimitBytes = $memory.CommitLimit
            availableMiB = $memory.AvailableMBytes
            buildProcessPrivateBytes = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
        } | ConvertTo-Json -Compress | Add-Content -LiteralPath $path
        Start-Sleep -Seconds 15
    }
}
$timer = [Diagnostics.Stopwatch]::StartNew()
Push-Location $app
try {
    [IO.File]::WriteAllText($next, $text, [Text.UTF8Encoding]::new($false))
    # Calling the wrapper directly preserves the Cargo argument separator.
    & node scripts/tauri.mjs build --target x86_64-pc-windows-msvc --bundles nsis --ci --no-sign --config $overlay -- --locked --timings --config $cargoConfig
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)" }
} finally {
    [IO.File]::WriteAllBytes($next, $original)
    Pop-Location
    $timer.Stop()
    Stop-Job -Job $monitor
    Remove-Job -Job $monitor -Force
    @{ buildSeconds = [Math]::Round($timer.Elapsed.TotalSeconds, 2) } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $diagnostics 'duration.json')
    $timings = Join-Path $repo 'target/cargo-timings/cargo-timing.html'
    if (Test-Path -LiteralPath $timings) {
        Copy-Item -LiteralPath $timings -Destination $diagnostics
    }
}

$release = Join-Path $repo 'target/x86_64-pc-windows-msvc/release'
$out = Join-Path $repo 'ci-dist'
$package = Join-Path $out 'Readest'
New-Item -ItemType Directory -Force -Path $package | Out-Null
Copy-Item -LiteralPath (Join-Path $release 'readest.exe') -Destination $package
Copy-Item -LiteralPath (Join-Path $app 'extensions/windows-thumbnail/target/windows_thumbnail.dll') -Destination (Join-Path $package 'readest_thumbnail.dll')
$installers = @(Get-ChildItem -LiteralPath (Join-Path $release 'bundle/nsis') -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
Copy-Item -LiteralPath $installers[0].FullName -Destination $out
$info = [ordered]@{
    repository = $env:GITHUB_REPOSITORY
    commit = (git -C $repo rev-parse HEAD).Trim()
    ref = $env:GITHUB_REF
    version = (Get-Content -Raw (Join-Path $app 'package.json') | ConvertFrom-Json).version
    run = "https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
    target = 'x86_64-pc-windows-msvc'
    configuration = 'Release, unsigned'
    node = (& node --version)
    rust = (& rustc --version)
    resources = $resources
}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'build-info.json')
$files = Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName
$hashes = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($out, $file.FullName).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
}
$hashes | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt')
Write-Output "Windows release staged at $out"
