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
.PARAMETER DbPort          Port of the MariaDB server to use, if several are installed (default 3306).
.PARAMETER DbRootPassword  MariaDB root password, if MariaDB was already installed before (you are asked if needed).
.PARAMETER ResetRootPassword  Forgotten the MariaDB root password? Sets a new one (saved in credentials.txt); data is kept.
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
  [int]$DbPort = 3306,
  [string]$DbRootPassword,
  [switch]$ResetRootPassword
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
# Every MariaDB/MySQL server installed as a Windows service, with its port and data folder (read from its my.ini).
function Get-DbServer {
  Get-CimInstance Win32_Service | Where-Object { $_.PathName -match '(mysqld|mariadbd)(\.exe)?' } | ForEach-Object {
    $path = $_.PathName
    if ($path -match '^\s*"([^"]+)"') { $exe = $Matches[1] } else { $exe = ($path -split '\s+')[0] }
    $ini = $null
    if ($path -match '--defaults-file="?([^"]+?\.(ini|cnf))') { $ini = $Matches[1] }
    $port = 3306
    $dataDir = '(default)'
    if ($ini -and (Test-Path $ini)) {
      $m = Select-String -Path $ini -Pattern '^\s*port\s*=\s*(\d+)' | Select-Object -First 1
      if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
      $m = Select-String -Path $ini -Pattern '^\s*datadir\s*=\s*"?([^"\r\n]+)"?' | Select-Object -First 1
      if ($m) { $dataDir = $m.Matches[0].Groups[1].Value.Trim() }
    }
    # Plain string handling: the service may point at a drive that is not mounted right now.
    $bin = $exe.Substring(0, [Math]::Max(0, $exe.LastIndexOfAny([char[]]'\/')))
    $client = @('mariadb.exe', 'mysql.exe') | ForEach-Object { "$bin\$_" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $adminTool = @('mariadb-admin.exe', 'mysqladmin.exe') | ForEach-Object { "$bin\$_" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $version = ''
    if (Test-Path -LiteralPath $exe) { $version = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
    if (-not $version) { $version = ($bin -split '[\\/]')[-2] }
    [pscustomobject]@{ Service = $_.Name; State = $_.State; Version = $version; Port = $port; DataDir = $dataDir
                       Exe = $exe; Ini = $ini; Client = $client; AdminTool = $adminTool }
  }
}

Step 'Checking MariaDB'
$instances = @(Get-DbServer)
if (-not $instances.Count) {
  Write-Host 'No MariaDB found - installing it with winget (this can take a few minutes)...'
  Invoke-Winget 'MariaDB.Server'
  $instances = @(Get-DbServer)
  if (-not $instances.Count) { Fail 'MariaDB did not install. Install it from https://mariadb.org/download/ (keep "Install as service" ticked), then re-run.' }
}
Write-Host 'Database servers found on this PC:'
$instances | Format-Table Service, State, Version, Port, DataDir -AutoSize | Out-String | Write-Host

$inst = $instances | Where-Object { $_.Port -eq $DbPort } | Select-Object -First 1
if (-not $inst) {
  if ($instances.Count -eq 1 -and -not $PSBoundParameters.ContainsKey('DbPort')) { $inst = $instances[0] }
  else { Fail "No database service uses port $DbPort. Re-run with -DbPort <port> to choose one of the servers listed above." }
}
$DbPort = $inst.Port
if (-not $inst.Client) { Fail "Could not find mariadb.exe or mysql.exe next to $($inst.Exe)." }
$DbClient = $inst.Client
if ($inst.State -ne 'Running') { Start-Service $inst.Service }
Set-Service $inst.Service -StartupType Automatic

# Make sure the program answering on the port really is this service (XAMPP/WAMP often hold 3306 too).
Start-Sleep -Seconds 2
$listener = Get-NetTCPConnection -State Listen -LocalPort $DbPort -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).Path
  if ($owner -and ($owner -ne $inst.Exe)) {
    Fail "Port $DbPort is held by $owner, not by the '$($inst.Service)' service ($($inst.Exe)). Stop that program, or re-run with -DbPort <another port> to use another server listed above."
  }
}
Write-Host "Using: service '$($inst.Service)' - MariaDB $($inst.Version) on 127.0.0.1:$DbPort" -ForegroundColor Cyan
Write-Host "       data folder $($inst.DataDir)"

function Invoke-Sql([string]$Sql, [string]$Password, [string]$Database = '') {
  $env:MYSQL_PWD = $Password
  try {
    $dbArgs = @('-u', 'root', '-h', '127.0.0.1', '-P', "$DbPort", '--protocol=TCP', '-N', '-B', '-e', $Sql)
    if ($Database) { $dbArgs += $Database }
    $out = & $DbClient @dbArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    return ($out | Out-String).Trim()
  } finally { Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue }
}
function Test-RootPassword([string]$Password) {
  try { Invoke-Sql 'SELECT 1' $Password | Out-Null; return $true } catch { return $false }
}
function Set-RootPasswordSql([string]$Password) {
  "ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '$Password'; " +
  "ALTER USER IF EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '$Password'; " +
  "ALTER USER IF EXISTS 'root'@'::1' IDENTIFIED BY '$Password'; FLUSH PRIVILEGES;"
}

# Forgotten root password: restart the server briefly without permission checks and set a new one.
function Reset-RootPassword {
  Write-Host "`nThis stops the '$($inst.Service)' service for about a minute and gives MariaDB's root account a new password." -ForegroundColor Yellow
  Write-Host 'Your existing databases and data are not changed. Programs that use the old root password will need the new one.'
  if ((Read-Host 'Type YES to continue') -ne 'YES') { Fail 'Cancelled.' }
  Stop-Service $inst.Service -Force
  $startArgs = @()
  if ($inst.Ini) { $startArgs += "--defaults-file=`"$($inst.Ini)`"" }
  $startArgs += @('--skip-grant-tables', "--port=$DbPort", '--bind-address=127.0.0.1')
  $proc = Start-Process -FilePath $inst.Exe -ArgumentList $startArgs -PassThru -WindowStyle Hidden
  $up = $false
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if (Test-RootPassword '') { $up = $true; break } }
  if (-not $up) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Service $inst.Service
    Fail 'Could not start MariaDB in recovery mode. The service has been restarted unchanged.'
  }
  $newPass = New-Secret 24
  try { Invoke-Sql ('FLUSH PRIVILEGES; ' + (Set-RootPasswordSql $newPass)) '' | Out-Null }
  finally {
    # Clean shutdown with the new password, then back to the normal service.
    if ($inst.AdminTool) {
      $env:MYSQL_PWD = $newPass
      & $inst.AdminTool -u root -h 127.0.0.1 -P "$DbPort" --protocol=TCP shutdown 2>&1 | Out-Null
      Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
    }
    if (-not $proc.WaitForExit(30000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Service $inst.Service
    Start-Sleep -Seconds 3
  }
  if (-not (Test-RootPassword $newPass)) { Fail 'The new root password did not take effect. Your MariaDB service has been restarted unchanged.' }
  Write-Host 'MariaDB root password reset (saved in credentials.txt).' -ForegroundColor Green
  return $newPass
}

# Work out the root password: given, saved by an earlier run, blank on a fresh install, or ask.
$RootPass = $null
$newRootPass = $null
$saved = $null
if (Test-Path $CredFile) {
  $m = Select-String -Path $CredFile -Pattern '^MariaDB root password:\s*(\S+)' | Select-Object -First 1
  if ($m) { $saved = $m.Matches[0].Groups[1].Value }
}
if ($ResetRootPassword) {
  $newRootPass = Reset-RootPassword
  $RootPass = $newRootPass
} else {
  foreach ($candidate in @($DbRootPassword, $saved, '')) {
    if ($null -ne $candidate -and (Test-RootPassword $candidate)) { $RootPass = $candidate; break }
  }
}
if ($null -eq $RootPass) {
  Write-Host "MariaDB's root password is needed (it was chosen when MariaDB was first installed on this PC)."
  for ($try = 1; $try -le 3 -and $null -eq $RootPass; $try++) {
    $secure = Read-Host "Enter the MariaDB root password (attempt $try of 3)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if (Test-RootPassword $plain) { $RootPass = $plain } else { Note 'That password is not correct.' }
  }
  if ($null -eq $RootPass) {
    Fail ("The root password was not accepted by the '$($inst.Service)' server on port $DbPort.`n" +
      "If you have forgotten it, re-run the same command with -ResetRootPassword added.")
  }
}
if ($RootPass -eq '') {
  # Fresh MariaDB with no root password: secure it now.
  $newRootPass = New-Secret 24
  Invoke-Sql (Set-RootPasswordSql $newRootPass) '' | Out-Null
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
DB_PORT=$DbPort
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
Write-Host "  Database      : $DbName on MariaDB ($($inst.Service), port $DbPort), user $DbUser"
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
