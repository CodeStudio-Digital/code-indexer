param(
  [Parameter(Mandatory=$true)][string]$Spec,
  [Parameter(Mandatory=$true)][string]$RunDirectory
)
$ErrorActionPreference = 'Stop'
$specification = Get-Content -LiteralPath $Spec -Raw | ConvertFrom-Json
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$directory = [IO.Path]::GetFullPath((Join-Path $workspace $RunDirectory))
if (-not $directory.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test logs must stay inside this workspace' }
if (Test-Path -LiteralPath $directory) { throw 'Use a fresh directory for each test process ledger' }
[IO.Directory]::CreateDirectory($directory) | Out-Null
$executable = (Get-Command $specification.executable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$timeoutSeconds = if ($specification.timeoutSeconds) { [int]$specification.timeoutSeconds } else { 1200 }
if ($timeoutSeconds -lt 1 -or $timeoutSeconds -gt 7200) { throw 'Test timeout must be between 1 and 7200 seconds' }
@{ supervisorPid=$PID; supervisorStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); executable=$executable; spec=(Resolve-Path -LiteralPath $Spec).Path; startedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'run.json')
Write-Output "Tracked test supervisor PID=$PID; ledger=$directory"
Add-Type -Path (Join-Path $PSScriptRoot 'test-process-job.cs')
if ($specification.environment) {
  foreach ($property in $specification.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }
}
$status = [TestProcessJob]::Run($executable, [string[]]$specification.arguments, $workspace, $directory, $timeoutSeconds)
Get-Content -LiteralPath (Join-Path $directory 'cleanup.json')
exit $status
