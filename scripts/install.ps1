#Requires -Version 5.1
<#
.SYNOPSIS
  Loan Recovery - one-step installer for Windows 10 / 11 (and Windows Server 2019+).

.DESCRIPTION
  Installs Node.js LTS and MariaDB with winget (if missing), creates the database and its user,
  copies the app to C:\LoanRecovery, creates the first admin, and runs the server in the background
  at every start-up (Windows scheduled task, restarted automatically if it stops).
  Safe to re-run: it updates the code and keeps the existing database, data and passwords.

  Run in PowerShell **as Administrator**, from the project folder:
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Demo

.PARAMETER Demo            Load demo officers and loans (only into an empty database).
.PARAMETER Public          Listen on the network (opens the Windows firewall port) - for testing from phones on your Wi-Fi.
.PARAMETER AppDir          Install folder (default C:\LoanRecovery). Pass the project folder itself to run the app in place.
.PARAMETER Port            HTTP port (default 8080).
.PARAMETER DbName          Database name (default loan_recovery).
.PARAMETER DbRootPassword  MariaDB root password, if MariaDB was already installed before (you are asked if needed).
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '', Justification = 'Passwords go to the MariaDB client as text; normally entered via a hidden prompt.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Installer script, not a module.')]
[CmdletBinding()]
param(
  [switch]$Demo,
  [switch]$Public,
  [string]$AppDir = 'C:\LoanRecovery',
  [int]$Port = 8080,
  [string]$DbName = 'loan_recovery',
  [string]$DbRootPassword
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$DbUser = 'recovery'
$TaskName = 'LoanRecovery'
$SrcDir = Split-Path -Parent $PSScriptRoot
$CredFile = Join-Path $AppDir 'credentials.txt'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Note($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

function New-Secret([int]$Length) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $bytes = New-Object byte[] $Length
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Write-TextFile([string]$Path, [string]$Text) {
  # UTF-8 without BOM (Node's .env reader would otherwise see a stray character).
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Protect-File([string]$Path) {
  # Only Administrators and SYSTEM (the account the server runs as) may read it.
  & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
}

function Invoke-Winget([string]$Id) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Fail "winget is not available. Install 'App Installer' from the Microsoft Store, or install $Id manually, then re-run."
  }
  & winget.exe install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { Note "winget returned code $LASTEXITCODE for $Id - checking whether it installed anyway." }
  Update-SessionPath
}

# ------------------------------------------------------------------ checks
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator (right-click PowerShell > Run as administrator), then run this script again.' }
if (-not (Test-Path (Join-Path $SrcDir 'server\index.js'))) { Fail "Run this script from the project folder (server\index.js not found in $SrcDir)." }
if ($DbName -notmatch '^[A-Za-z0-9_]+$') { Fail '-DbName may only contain letters, digits and _' }

# ------------------------------------------------------------------ Node.js
function Test-Node {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
  $v = (& node.exe -p 'process.versions.node').Split('.')
  return ([int]$v[0] -gt 20) -or ([int]$v[0] -eq 20 -and [int]$v[1] -ge 12)
}
Step 'Checking Node.js'
if (-not (Test-Node)) {
  Write-Host 'Installing Node.js LTS with winget...'
  Invoke-Winget 'OpenJS.NodeJS.LTS'
  if (-not (Test-Node)) { Fail 'Node.js 20.12 or newer is required. Close PowerShell, open a new one as Administrator and re-run (to pick up the new PATH).' }
}
$Node = (Get-Command node.exe).Source
$Npm = Join-Path (Split-Path $Node) 'npm.cmd'
Write-Host "Node.js $(& $Node -v) at $Node"

# ------------------------------------------------------------------ MariaDB
function Find-DbClient {
  $exe = Get-ChildItem -Path 'C:\Program Files\MariaDB*\bin\mariadb.exe', 'C:\Program Files\MariaDB*\bin\mysql.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($exe) { return $exe.FullName }
  return $null
}
function Find-DbService { Get-Service | Where-Object { $_.Name -match '^(MariaDB|MySQL)' } | Select-Object -First 1 }

Step 'Checking MariaDB'
$DbClient = Find-DbClient
if (-not $DbClient) {
  Write-Host 'Installing MariaDB with winget (this can take a few minutes)...'
  Invoke-Winget 'MariaDB.Server'
  $DbClient = Find-DbClient
  if (-not $DbClient) { Fail 'MariaDB did not install. Install it from https://mariadb.org/download/ (keep "Install as service" ticked), then re-run with -DbRootPassword <the root password you chose>.' }
}
$svc = Find-DbService
if (-not $svc) { Fail 'MariaDB is installed but its Windows service was not found. Reinstall MariaDB with "Install as service" ticked.' }
if ($svc.Status -ne 'Running') { Start-Service $svc.Name }
Set-Service $svc.Name -StartupType Automatic
Write-Host "MariaDB service '$($svc.Name)' is running ($DbClient)"

function Invoke-Sql([string]$Sql, [string]$Password, [string]$Database = '') {
  $env:MYSQL_PWD = $Password
  try {
    $dbArgs = @('-u', 'root', '-h', '127.0.0.1', '--protocol=TCP', '-N', '-B', '-e', $Sql)
    if ($Database) { $dbArgs += $Database }
    $out = & $DbClient @dbArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    return ($out | Out-String).Trim()
  } finally { Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue }
}
function Test-RootPassword([string]$Password) {
  try { Invoke-Sql 'SELECT 1' $Password | Out-Null; return $true } catch { return $false }
}

# Work out the root password: given, saved by an earlier run, blank on a fresh install, or ask.
$RootPass = $null
$newRootPass = $null
$saved = $null
if (Test-Path $CredFile) {
  $m = Select-String -Path $CredFile -Pattern '^MariaDB root password:\s*(\S+)' | Select-Object -First 1
  if ($m) { $saved = $m.Matches[0].Groups[1].Value }
}
foreach ($candidate in @($DbRootPassword, $saved, '')) {
  if ($null -ne $candidate -and (Test-RootPassword $candidate)) { $RootPass = $candidate; break }
}
if ($null -eq $RootPass) {
  $secure = Read-Host 'Enter the MariaDB root password' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if (-not (Test-RootPassword $plain)) { Fail 'That MariaDB root password is not correct.' }
  $RootPass = $plain
}
if ($RootPass -eq '') {
  # Fresh MariaDB with no root password: secure it now.
  $newRootPass = New-Secret 24
  Invoke-Sql ("ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '$newRootPass'; " +
    "ALTER USER IF EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '$newRootPass'; " +
    "ALTER USER IF EXISTS 'root'@'::1' IDENTIFIED BY '$newRootPass'; FLUSH PRIVILEGES;") '' | Out-Null
  $RootPass = $newRootPass
  Write-Host 'MariaDB root password set (saved in credentials.txt).'
}

# ------------------------------------------------------------------ app files
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$AppDir = (Resolve-Path $AppDir).Path.TrimEnd('\', '/')
$CredFile = Join-Path $AppDir 'credentials.txt'
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'logs') | Out-Null
if ($AppDir -ieq (Resolve-Path $SrcDir).Path.TrimEnd('\', '/')) {
  Step "Installing in place in $AppDir"
} else {
  Step "Copying the app to $AppDir"
  & robocopy.exe $SrcDir $AppDir /E /XD .git node_modules logs /XF .env credentials.txt /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Copying files failed (robocopy code $LASTEXITCODE)." }
  $global:LASTEXITCODE = 0
}

# ------------------------------------------------------------------ database & .env
$envFile = Join-Path $AppDir '.env'
$DbPass = $null
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^DB_PASSWORD=([^\s#]+)' | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value -ne 'change-me') { $DbPass = $m.Matches[0].Groups[1].Value }
}
if (-not $DbPass) { $DbPass = New-Secret 28 }

Step "Creating database '$DbName' and user '$DbUser'"
$grant = ''
foreach ($h in @('localhost', '127.0.0.1')) {
  $grant += "CREATE USER IF NOT EXISTS '$DbUser'@'$h' IDENTIFIED BY '$DbPass'; ALTER USER '$DbUser'@'$h' IDENTIFIED BY '$DbPass'; " +
    "GRANT ALL PRIVILEGES ON $DbName.* TO '$DbUser'@'$h'; "
}
Invoke-Sql ("CREATE DATABASE IF NOT EXISTS $DbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; $grant FLUSH PRIVILEGES;") $RootPass | Out-Null

$listenHost = '127.0.0.1'
if ($Public) { $listenHost = '0.0.0.0' }
Write-TextFile $envFile @"
# Written by scripts/install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Keep this file private.
PORT=$Port
HOST=$listenHost
TZ=Asia/Kolkata
SESSION_DAYS=30

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DbName
DB_USER=$DbUser
DB_PASSWORD=$DbPass
DB_POOL_SIZE=10
"@
Protect-File $envFile

Push-Location $AppDir
try {
  Step 'Installing Node.js packages'
  & $Npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed - check your internet connection and re-run.' }

  Step 'Creating / upgrading tables'
  & $Node server\admin.js migrate
  if ($LASTEXITCODE -ne 0) { Fail 'Database migration failed (see the message above).' }

  # ---------------------------------------------------------------- first admin
  $users = [int](Invoke-Sql 'SELECT COUNT(*) FROM users' $RootPass $DbName)
  $AdminPass = $null
  if ($Demo -and $users -eq 0) {
    Step 'Loading demo data'
    & $Node server\admin.js seed-demo | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'Loading demo data failed.' }
    Write-Host "Demo branch 'Lucknow Rural': officers FO27 / FO31 (PIN 1234), supervisor SUP1 (PIN 9999), 12 loans"
    $AdminPass = 'Lr' + (New-Secret 12) + (Get-Random -Minimum 10 -Maximum 99)
    & $Node server\admin.js set-pin --code ADMIN --pin $AdminPass | Out-Null
  } elseif ($Demo) {
    Note 'Database already has users - demo data not loaded.'
  }
  $admins = [int](Invoke-Sql "SELECT COUNT(*) FROM users WHERE role = 'admin'" $RootPass $DbName)
  if (-not $AdminPass -and $admins -eq 0) {
    Step 'Creating the first admin account'
    $AdminPass = 'Lr' + (New-Secret 12) + (Get-Random -Minimum 10 -Maximum 99)
    & $Node server\admin.js add-user --code ADMIN --name Administrator --role admin --branch 'Head Office' --pin $AdminPass | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'Creating the admin account failed.' }
  }
} finally { Pop-Location }

# Credentials: keep earlier lines (e.g. root password) and add what is new.
$cred = @()
if (Test-Path $CredFile) { $cred = @(Get-Content $CredFile) }
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
if ($newRootPass) { $cred = @($cred | Where-Object { $_ -notmatch '^MariaDB root password:' }) + "MariaDB root password: $newRootPass" }
if ($AdminPass) {
  $cred = @($cred | Where-Object { $_ -notmatch '^Admin (code|password):' -and $_ -notmatch '^Demo field logins' }) +
    'Admin code: ADMIN' + "Admin password: $AdminPass"
  if ($Demo) { $cred += 'Demo field logins: FO27 / FO31 (PIN 1234), supervisor SUP1 (PIN 9999)' }
}
if ($cred.Count) {
  if ($cred[0] -notmatch '^Loan Recovery') { $cred = @("Loan Recovery credentials - updated $stamp", "Admin console: http://localhost:$Port/admin/") + $cred }
  else { $cred[0] = "Loan Recovery credentials - updated $stamp" }
  Write-TextFile $CredFile (($cred -join "`r`n") + "`r`n")
  Protect-File $CredFile
}

# ------------------------------------------------------------------ background service
Step 'Starting the Loan Recovery server'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*server\index.js*' -or $_.CommandLine -like '*server/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$log = Join-Path $AppDir 'logs\server.log'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $AppDir `
  -Argument "/c `"`"$Node`" server\index.js >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # give MariaDB time to start after a reboot
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Loan Recovery server (Node.js)' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

if ($Public) {
  if (-not (Get-NetFirewallRule -DisplayName 'Loan Recovery' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Loan Recovery' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain | Out-Null
  }
}

$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $ok) {
  if (Test-Path $log) { Get-Content $log -Tail 30 }
  Fail "The server did not answer on port $Port. See the log above ($log)."
}

# ------------------------------------------------------------------ summary
Step 'Done - Loan Recovery is running'
Write-Host ''
Write-Host "  Field app     : http://localhost:$Port/"
Write-Host "  Admin console : http://localhost:$Port/admin/"
if ($Public) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -First 1).IPAddress
  if ($ip) { Write-Host "  On your Wi-Fi : http://${ip}:$Port/   (phones need HTTPS for camera, GPS and install)" }
}
Write-Host "  App folder    : $AppDir   (settings in $envFile)"
Write-Host "  Database      : $DbName on MariaDB, user $DbUser"
if ($AdminPass) {
  Write-Host "  Admin login   : ADMIN / $AdminPass" -ForegroundColor Cyan
  Write-Host "                  (also saved in $CredFile - change it after signing in)"
} else {
  Write-Host '  Admin login   : unchanged (existing admin accounts kept)'
}
Write-Host "  Server log    : $log"
Write-Host "  Restart       : Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName   (it also starts with Windows)"
Write-Host ''
Start-Process "http://localhost:$Port/admin/"
