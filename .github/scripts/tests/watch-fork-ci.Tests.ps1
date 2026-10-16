$ErrorActionPreference='Stop'
$watch=(Join-Path $PSScriptRoot '../watch-fork-ci.ps1')
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('readest-watch-tests-'+[guid]::NewGuid().ToString('N'))
$global:ciWatchTest=@{status='completed';conclusion='success';path='.github/workflows/fork-windows.yml';attempt=1;queued=0;queueExit=0;apiExit=0}
function global:gh {
    if($args[0] -eq 'run'){$global:LASTEXITCODE=0;return}
    $global:LASTEXITCODE=$global:ciWatchTest.apiExit
    if($args[1] -like '*/artifacts'){'{"artifacts":[{"name":"release","id":123,"expired":false}]}';return}
    @{status=$global:ciWatchTest.status;conclusion=$global:ciWatchTest.conclusion;path=$global:ciWatchTest.path;repository=@{full_name='EiraWalker/readest'};head_sha=('a'*40);head_branch='test';html_url='https://github.com/EiraWalker/readest/actions/runs/1';run_attempt=$global:ciWatchTest.attempt}|ConvertTo-Json -Depth 3
}
function global:codex { $global:ciWatchTest.queued++;$global:LASTEXITCODE=$global:ciWatchTest.queueExit }
function Assert($condition,$message){if(!$condition){throw $message}}
function Invoke-Watch($name){& $watch -RunId 1 -NotifyThread '00000000-0000-0000-0000-000000000001' -OutputDirectory (Join-Path $testRoot $name)|Out-Null}
Invoke-Watch success
$result=Get-Content -Raw (Join-Path $testRoot 'success/completion.json')|ConvertFrom-Json
Assert ($result.conclusion -eq 'success' -and $result.artifacts.Count -eq 1) 'Missing success result or artifact'
Assert ($global:ciWatchTest.queued -eq 1) 'Expected one queue message'
Invoke-Watch success
Assert ($global:ciWatchTest.queued -eq 1) 'Duplicate completion was queued'
$global:ciWatchTest.attempt=2
Invoke-Watch success
Assert ($global:ciWatchTest.queued -eq 2) 'Rerun did not notify'
$global:ciWatchTest.conclusion='failure'
Invoke-Watch failure
Assert ($LASTEXITCODE -eq 1) 'Failure reported success'
$result=Get-Content -Raw (Join-Path $testRoot 'failure/completion.json')|ConvertFrom-Json
Assert ($result.conclusion -eq 'failure') 'Failure result missing'
$global:ciWatchTest.conclusion='cancelled'
Invoke-Watch cancelled
Assert ($LASTEXITCODE -eq 1) 'Cancellation reported success'
$global:ciWatchTest.status='in_progress'
$before=$global:ciWatchTest.queued
try{Invoke-Watch running;throw 'ACCEPTED_INVALID'}catch{if($_ -match 'ACCEPTED_INVALID'){throw}}
Assert ($before -eq $global:ciWatchTest.queued) 'Running workflow queued completion'
$global:ciWatchTest.status='completed'
$global:ciWatchTest.path='other.yml'
try{Invoke-Watch wrong;throw 'ACCEPTED_INVALID'}catch{if($_ -match 'ACCEPTED_INVALID'){throw}}
Assert ($before -eq $global:ciWatchTest.queued) 'Wrong workflow queued completion'
$global:ciWatchTest.path='.github/workflows/fork-windows.yml'
$global:ciWatchTest.apiExit=1
try{Invoke-Watch api;throw 'ACCEPTED_INVALID'}catch{if($_ -match 'ACCEPTED_INVALID'){throw}}
Assert ($before -eq $global:ciWatchTest.queued) 'Failed API queued completion'
$global:ciWatchTest.apiExit=0
$global:ciWatchTest.queueExit=1
try{Invoke-Watch queuefail;throw 'ACCEPTED_INVALID'}catch{if($_ -match 'ACCEPTED_INVALID'){throw}}
Assert (Test-Path (Join-Path $testRoot 'queuefail/completion.json')) 'Lost result on queue failure'
Assert (!(Test-Path (Join-Path $testRoot 'queuefail/notification-sent.json'))) 'Queue failure recorded as delivered'
Write-Output 'PASS: success/artifact, deduplication, rerun, failure, cancellation, incomplete run, wrong workflow, API failure, queue rejection (9 cases)'
Write-Output "Evidence: $testRoot"
$global:LASTEXITCODE=0
