#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$app = Join-Path $repo 'apps/readest-app'
$next = Join-Path $app 'next.config.mjs'
$original = [IO.File]::ReadAllBytes($next)
$overlay = Join-Path $env:RUNNER_TEMP 'readest-fork-build.json'
@{ bundle = @{ createUpdaterArtifacts = $false } } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $overlay

# Limit frontend workers on the runner without changing the checked-in config.
$text = [Text.Encoding]::UTF8.GetString($original)
if ([regex]::Matches($text, '(?m)^  experimental: \{').Count -ne 1) {
    throw 'Next config layout changed; review the CI worker override.'
}
$text = $text.Replace('  experimental: {', "  experimental: {`n    cpus: 2,")
Push-Location $app
try {
    [IO.File]::WriteAllText($next, $text, [Text.UTF8Encoding]::new($false))
    # Calling the wrapper directly preserves the Cargo argument separator.
    & node scripts/tauri.mjs build --target x86_64-pc-windows-msvc --bundles nsis --ci --no-sign --config $overlay -- --locked
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed ($LASTEXITCODE)" }
} finally {
    [IO.File]::WriteAllBytes($next, $original)
    Pop-Location
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
}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'build-info.json')
$files = Get-ChildItem -LiteralPath $out -Recurse -File | Sort-Object FullName
$hashes = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($out, $file.FullName).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
}
$hashes | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt')
Write-Output "Windows release staged at $out"
