#Requires -Version 5.1
<#
.SYNOPSIS
  LoanDesk - one-command production setup for a Windows Server without Git or winget.

.DESCRIPTION
  Downloads the latest LoanDesk code from GitHub as a zip (no Git needed) into C:\src\loandesk and runs
  scripts\install-production.ps1 with the same parameters. That installer installs Node.js and the IIS
  modules itself when they are missing.

  Run in PowerShell as Administrator:
    [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
    Invoke-WebRequest https://raw.githubusercontent.com/systemkunal-pixel/sampleone/claude/eager-ride-t1oaiq/scripts/bootstrap-production.ps1 -OutFile $env:TEMP\loandesk-setup.ps1 -UseBasicParsing
    powershell -ExecutionPolicy Bypass -File $env:TEMP\loandesk-setup.ps1 -DbHost 26.182.8.0 -DbPort 3321 -OverlordEmail you@example.com

  Every parameter is passed on to install-production.ps1 (see that script for the list).
#>
# A plain (not advanced) script, so parameters it does not know (-DbHost, -OverlordEmail, ...) land in $args.
param(
  [string]$Branch = 'claude/eager-ride-t1oaiq',
  [string]$SourceDir = 'C:\src\loandesk'
)
$InstallerArgs = $args
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator, then run this script again.' }

Write-Host "`n==> Downloading LoanDesk ($Branch) from GitHub" -ForegroundColor Green
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$zip = Join-Path $env:TEMP 'loandesk-source.zip'
$unpack = Join-Path $env:TEMP 'loandesk-source'
Invoke-WebRequest "https://github.com/systemkunal-pixel/sampleone/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
Expand-Archive $zip -DestinationPath $unpack -Force
Remove-Item $zip -Force
$top = Get-ChildItem $unpack -Directory | Select-Object -First 1
if (-not $top -or -not (Test-Path (Join-Path $top.FullName 'scripts\install-production.ps1'))) { Fail 'The download did not contain LoanDesk. Check the branch name.' }

# Replace the source copy (it holds no data: the installed app lives in C:\websites\loandesk\app).
New-Item -ItemType Directory -Force -Path $SourceDir | Out-Null
& robocopy.exe $top.FullName $SourceDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying the code to $SourceDir failed (robocopy code $LASTEXITCODE)." }
Remove-Item $unpack -Recurse -Force
Write-Host "Code is in $SourceDir"

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceDir 'scripts\install-production.ps1') @InstallerArgs
exit $LASTEXITCODE
