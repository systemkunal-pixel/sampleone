#Requires -Version 5.1
<#
.SYNOPSIS
  LoanDesk - production installer for Windows Server 2019+ (also Windows 10/11).

.DESCRIPTION
  Installs LoanDesk on a server that uses an EXISTING MariaDB (10.6+) which you manage, and serves it
  on HTTPS at your domain with Caddy (free Let's Encrypt certificate, renewed automatically).

  Before running it, on the MariaDB server create the database and a user for LoanDesk only:
      CREATE DATABASE loandesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER 'loandesk'@'%' IDENTIFIED BY '<a strong password>';
      GRANT ALL PRIVILEGES ON loandesk.* TO 'loandesk'@'%';
  (replace '%' with this server's address if you can). The domain's DNS must point to this server
  and ports 80 and 443 must be open to the internet.

  It then:
    - installs Node.js LTS (winget) if missing
    - copies the app to C:\LoanDesk (keeps .env, logs, backups and data on re-runs)
    - writes .env with the database details, checks the connection and creates/upgrades the tables
    - creates the first admin (company BRMC) and the overlord account, saved to C:\LoanDesk\credentials.txt
    - runs LoanDesk (the updater agent) as a start-up task listening only on 127.0.0.1
    - downloads Caddy 2.8.4 (checksum verified), configures HTTPS for the domain, runs it as a start-up task
      and opens ports 80 and 443 in Windows Firewall
  Safe to re-run for updates: the database, passwords, signing key and data are kept.

  Run in PowerShell as Administrator, from the project folder:
    powershell -ExecutionPolicy Bypass -File .\scripts\install-production.ps1 -DbHost 26.182.8.0 -DbPort 3321 -OverlordEmail you@example.com

.PARAMETER Domain         Public name (default loandesk.datahaat.com).
.PARAMETER AppDir         Install folder (default C:\LoanDesk).
.PARAMETER Port           Local port LoanDesk listens on behind Caddy (default 8080).
.PARAMETER DbHost         MariaDB server address (required on first install).
.PARAMETER DbPort         MariaDB port (default 3306).
.PARAMETER DbName         Database (default loandesk).
.PARAMETER DbUser         Database user (default loandesk).
.PARAMETER DbPassword     Database password (asked for, hidden, when not given and not already in .env).
.PARAMETER OverlordEmail  Sign-in email of the first overlord (required on first install).
.PARAMETER AcmeEmail      Email Let's Encrypt uses for certificate notices (default: OverlordEmail).
.PARAMETER Web            How HTTPS is served: Auto (default: IIS if it is installed, else Caddy), IIS, Caddy, or None.
                          IIS: adds a 'LoanDesk' site for the domain that forwards to LoanDesk (URL Rewrite + ARR, installed
                          from Microsoft if missing) and gets the certificate with win-acme, which renews it.
.PARAMETER WacsPath       Path to wacs.exe if win-acme is not found automatically.
.PARAMETER NoHttps        Same as -Web None: LoanDesk listens on -Port only (HTTPS handled elsewhere).
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', '', Justification = 'The password goes into .env as text; it is normally entered via a hidden prompt.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Installer script, not a module.')]
[CmdletBinding()]
param(
  [string]$Domain = 'loandesk.datahaat.com',
  [string]$AppDir = 'C:\LoanDesk',
  [int]$Port = 8080,
  [string]$DbHost,
  [int]$DbPort = 3306,
  [string]$DbName = 'loandesk',
  [string]$DbUser = 'loandesk',
  [string]$DbPassword,
  [string]$OverlordEmail,
  [string]$AcmeEmail,
  [ValidateSet('Auto', 'IIS', 'Caddy', 'None')][string]$Web = 'Auto',
  [string]$WacsPath,
  [switch]$NoHttps
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$TaskName = 'LoanDesk'
$CaddyTask = 'LoanDesk-HTTPS'
$CaddyVersion = '2.8.4'
$CaddySha512 = '89f8fc9ece9941a15a0981b3c69543d3b9b5fe095e747875a05fc1775d4d78d4505a7fe54a58d496dade601e85f6053a00a1b0382a781d3e8b6eec044384f6e6'
$SrcDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $AppDir '.env'
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
  # Readable only by the installing account, Administrators and SYSTEM (the account LoanDesk runs as).
  $me = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "${me}:F" '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
}
function Test-PortFree([int]$Number, [string]$BindAddress) {
  $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Parse($BindAddress)), $Number
  try { $listener.Start(); return $true } catch { return $false } finally { try { $listener.Stop() } catch { Write-Verbose 'listener not started' } }
}
function Get-EnvValue([string]$Name) {
  if (-not (Test-Path $EnvFile)) { return $null }
  $m = Select-String -Path $EnvFile -Pattern "^$Name=(.*)$" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim() }
  return $null
}
function Stop-LoanDesk {
  # The task, plus any LoanDesk server started by hand (node ... server\index.js or server\supervisor.js).
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'server[\\/](index|supervisor)\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
function Register-StartupTask([string]$Name, [string]$Exe, [string]$Arguments, [string]$WorkDir, [string]$Description) {
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT30S'
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description $Description -Force | Out-Null
}

# ------------------------------------------------------------------ checks
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as Administrator, then run this script again.' }
if (-not (Test-Path (Join-Path $SrcDir 'server\supervisor.js'))) { Fail "Run this script from the LoanDesk project folder (server\supervisor.js not found in $SrcDir)." }
if ($DbName -notmatch '^[A-Za-z0-9_]+$') { Fail '-DbName may only contain letters, digits and _' }
if ($NoHttps) { $Web = 'None' }
if ($Web -eq 'Auto') { $Web = if (Get-Service W3SVC -ErrorAction SilentlyContinue) { 'IIS' } else { 'Caddy' } }
Write-Host "HTTPS will be served by: $Web"
if ($Web -ne 'None' -and $Domain -notmatch '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { Fail "-Domain '$Domain' is not a valid host name." }

# Settings from an earlier install are kept unless given again.
$firstInstall = -not (Test-Path $EnvFile)
if (-not $DbHost) { $DbHost = Get-EnvValue 'DB_HOST' }
if (-not $PSBoundParameters.ContainsKey('DbPort') -and (Get-EnvValue 'DB_PORT')) { $DbPort = [int](Get-EnvValue 'DB_PORT') }
if (-not $PSBoundParameters.ContainsKey('DbName') -and (Get-EnvValue 'DB_NAME')) { $DbName = Get-EnvValue 'DB_NAME' }
if (-not $PSBoundParameters.ContainsKey('DbUser') -and (Get-EnvValue 'DB_USER')) { $DbUser = Get-EnvValue 'DB_USER' }
if (-not $PSBoundParameters.ContainsKey('Port') -and (Get-EnvValue 'PORT')) { $Port = [int](Get-EnvValue 'PORT') }
if (-not $DbPassword) { $DbPassword = Get-EnvValue 'DB_PASSWORD' }
$UpdateKey = Get-EnvValue 'UPDATE_PUBLIC_KEY'
if (-not $DbHost) { Fail 'Give the MariaDB server with -DbHost (and -DbPort if it is not 3306).' }
if (-not $DbPassword) {
  $secure = Read-Host "Password of MariaDB user '$DbUser'" -AsSecureString
  $DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $DbPassword) { Fail 'The database password is required.' }
if ($DbPassword -match '[\r\n#]' -or $DbPassword -match '^\s|\s$') { Fail 'Use a database password without #, line breaks or leading/trailing spaces (they do not survive in .env).' }

# ------------------------------------------------------------------ Node.js
function Test-Node {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
  $v = (& node.exe -p 'process.versions.node').Split('.')
  return ([int]$v[0] -gt 20) -or ([int]$v[0] -eq 20 -and [int]$v[1] -ge 12)
}
Step 'Checking Node.js'
if (-not (Test-Node)) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Fail 'Node.js 20.12+ is needed and winget is not available. Install Node.js LTS from https://nodejs.org/ and re-run.'
  }
  & winget.exe install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  Update-SessionPath
  if (-not (Test-Node)) { Fail 'Node.js did not install. Install Node.js LTS from https://nodejs.org/, open a new PowerShell as Administrator and re-run.' }
}
$Node = (Get-Command node.exe).Source
$Npm = Join-Path (Split-Path $Node) 'npm.cmd'
Write-Host "Node.js $(& $Node -v) at $Node"

# Local port for LoanDesk: keep the earlier one; on a first install pick a free one if 8080 is taken (IIS often uses it).
if ($firstInstall -and -not $PSBoundParameters.ContainsKey('Port') -and -not (Test-PortFree $Port '127.0.0.1')) {
  $Port = (8080..8099) + (9080..9099) | Where-Object { Test-PortFree $_ '127.0.0.1' } | Select-Object -First 1
  if (-not $Port) { Fail 'No free local port between 8080 and 9099. Re-run with -Port <a free port>.' }
  Note "Port 8080 is in use on this server; LoanDesk will use $Port (only reachable from this server)."
}

# ------------------------------------------------------------------ app files
Step "Copying LoanDesk to $AppDir"
Stop-LoanDesk
New-Item -ItemType Directory -Force -Path $AppDir, (Join-Path $AppDir 'logs') | Out-Null
if ((Resolve-Path $SrcDir).Path.TrimEnd('\') -ne (Resolve-Path $AppDir).Path.TrimEnd('\')) {
  & robocopy.exe $SrcDir $AppDir /E /XD .git node_modules logs updates backups caddy /XF .env credentials.txt *.ldpatch *.pem /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Copying the files failed (robocopy code $LASTEXITCODE)." }
}

# Folder with mariadb-dump.exe: the updater agent backs up the database with it before schema changes.
$dbBin = Get-EnvValue 'DB_BIN_DIR'
if (-not $dbBin -or -not (Test-Path (Join-Path $dbBin 'mariadb-dump.exe'))) {
  $dbBin = Get-ChildItem 'C:\Program Files\MariaDB*\bin\mariadb-dump.exe', 'C:\Program Files\MySQL\*\bin\mysqldump.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 | ForEach-Object { $_.DirectoryName }
}
if (-not $dbBin) {
  Note 'mariadb-dump.exe was not found on this server. Updates that change the database will be refused until the MariaDB client tools are installed (install MariaDB with only the client components, then re-run this script).'
}

Step 'Writing settings (.env)'
Write-TextFile $EnvFile @"
# Written by scripts/install-production.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Keep this file private.
APP_ENV=Production
PORT=$Port
HOST=$(if ($Web -eq 'None') { '0.0.0.0' } else { '127.0.0.1' })
TZ=Asia/Kolkata
SESSION_DAYS=30

DB_HOST=$DbHost
DB_PORT=$DbPort
DB_NAME=$DbName
DB_USER=$DbUser
DB_PASSWORD=$DbPassword
DB_POOL_SIZE=10
DB_BIN_DIR=$dbBin

# Public key that signed update packages must match (from: node scripts/patch.js keygen on the release PC).
UPDATE_PUBLIC_KEY=$UpdateKey
"@
Protect-File $EnvFile

Push-Location $AppDir
try {
  Step 'Installing Node.js packages'
  & $Npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed - check the internet connection and re-run.' }

  Step "Connecting to MariaDB at ${DbHost}:$DbPort and creating / upgrading tables"
  & $Node server\admin.js migrate
  if ($LASTEXITCODE -ne 0) {
    Fail ("Could not use database '$DbName' as '$DbUser' at ${DbHost}:$DbPort (see the message above). Check that the database " +
      'and user exist with ALL PRIVILEGES on it, that the user may connect from this server, and that the port is reachable.')
  }

  # ---------------------------------------------------------------- first accounts
  $NewCreds = @()
  $status = (& $Node server\admin.js status) | Select-Object -Last 1 | ConvertFrom-Json
  if ($status.brmcAdmins -eq 0) {
    Step 'Creating the BRMC admin account'
    $AdminPass = 'Lr' + (New-Secret 12) + (Get-Random -Minimum 10 -Maximum 99)
    & $Node server\admin.js add-user --company BRMC --code ADMIN --name Administrator --role admin --branch 'Head Office' --pin $AdminPass | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'Creating the admin account failed (see above). If the code ADMIN is taken, add an admin from the overlord console instead.' }
    $NewCreds += "Admin console: https://$Domain/admin/  -  admin code ADMIN, password $AdminPass"
  }
  if ($status.overlords -eq 0) {
    if (-not $OverlordEmail) { Fail 'Give -OverlordEmail you@example.com for the first overlord account.' }
    Step "Creating the overlord account ($OverlordEmail)"
    $OverlordPass = 'Ov' + (New-Secret 14) + (Get-Random -Minimum 10 -Maximum 99)
    & $Node server\admin.js add-overlord --email $OverlordEmail --name 'Platform owner' --password $OverlordPass | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'Creating the overlord account failed (see above).' }
    $NewCreds += "Overlord console: https://$Domain/overlord/  -  $OverlordEmail, password $OverlordPass (scan the QR code at first sign-in)"
  }
} finally { Pop-Location }

if ($NewCreds.Count) {
  $cred = @()
  if (Test-Path $CredFile) { $cred = @(Get-Content $CredFile) }
  $cred += "LoanDesk accounts created $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
  $cred += $NewCreds
  Write-TextFile $CredFile (($cred -join "`r`n") + "`r`n")
  Protect-File $CredFile
}

# ------------------------------------------------------------------ LoanDesk service
Step 'Starting LoanDesk'
$log = Join-Path $AppDir 'logs\server.log'
Register-StartupTask $TaskName 'cmd.exe' "/c `"`"$Node`" server\supervisor.js >> `"$log`" 2>&1`"" $AppDir 'LoanDesk server and updater agent (Node.js)'
Start-ScheduledTask -TaskName $TaskName
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3; if ($h.ok) { $ok = $true; break } } catch { Start-Sleep -Seconds 1 }
}
if (-not $ok) {
  if (Test-Path $log) { Get-Content $log -Tail 30 }
  Fail "LoanDesk did not answer on port $Port. See the log above ($log)."
}
Write-Host "LoanDesk $($h.version) is running on 127.0.0.1:$Port"

# ------------------------------------------------------------------ HTTPS with Caddy
if ($Web -eq 'Caddy') {
  Step "Setting up HTTPS for $Domain (Caddy $CaddyVersion)"
  $caddyDir = Join-Path $AppDir 'caddy'
  $caddyExe = Join-Path $caddyDir 'caddy.exe'
  New-Item -ItemType Directory -Force -Path $caddyDir, (Join-Path $caddyDir 'data') | Out-Null
  Stop-ScheduledTask -TaskName $CaddyTask -ErrorAction SilentlyContinue
  Get-Process caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $caddyExe } | Stop-Process -Force
  $haveVersion = if (Test-Path $caddyExe) { (& $caddyExe version) -join ' ' } else { '' }
  if ($haveVersion -notmatch [regex]::Escape("v$CaddyVersion")) {
    $zip = Join-Path $env:TEMP "caddy_$CaddyVersion.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" -OutFile $zip -UseBasicParsing
    if ((Get-FileHash $zip -Algorithm SHA512).Hash -ne $CaddySha512) { Remove-Item $zip -Force; Fail 'The downloaded Caddy file does not match its published checksum. Try again later.' }
    Expand-Archive $zip -DestinationPath $caddyDir -Force
    Remove-Item $zip -Force
  }
  foreach ($p in 80, 443) {
    if (-not (Test-PortFree $p '0.0.0.0')) {
      $owner = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 |
        ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
      Fail ("Port $p is already used by '$owner'. HTTPS needs ports 80 and 443. If IIS or another web server uses them, either stop it, " +
        'or re-run with -Web IIS (for IIS) or -Web None and point that web server to http://127.0.0.1:' + $Port + '.')
    }
  }
  if (-not $AcmeEmail) { $AcmeEmail = $OverlordEmail }
  $dataDir = (Join-Path $caddyDir 'data') -replace '\\', '/'
  $logDir = (Join-Path $AppDir 'logs') -replace '\\', '/'
  Write-TextFile (Join-Path $caddyDir 'Caddyfile') @"
{
	$(if ($AcmeEmail) { "email $AcmeEmail" })
	storage file_system {
		root $dataDir
	}
}

$Domain {
	encode gzip
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	request_body {
		max_size 50MB
	}
	reverse_proxy 127.0.0.1:$Port
	log {
		output file $logDir/https-access.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
"@
  & $caddyExe validate --config (Join-Path $caddyDir 'Caddyfile') --adapter caddyfile 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { & $caddyExe validate --config (Join-Path $caddyDir 'Caddyfile') --adapter caddyfile; Fail 'The HTTPS configuration is not valid (see above).' }
  $caddyLog = Join-Path $AppDir 'logs\https.log'
  Register-StartupTask $CaddyTask 'cmd.exe' "/c `"`"$caddyExe`" run --config Caddyfile --adapter caddyfile >> `"$caddyLog`" 2>&1`"" $caddyDir "HTTPS for $Domain (Caddy)"
  foreach ($p in 80, 443) {
    if (-not (Get-NetFirewallRule -DisplayName "LoanDesk HTTPS $p" -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName "LoanDesk HTTPS $p" -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow | Out-Null
    }
  }
  Start-ScheduledTask -TaskName $CaddyTask
  Write-Host 'Waiting for the certificate (Let''s Encrypt needs the domain to point here and port 80 to be reachable)...'
  $https = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { $r = Invoke-RestMethod "https://$Domain/api/health" -TimeoutSec 5; if ($r.ok) { $https = $true; break } } catch { Start-Sleep -Seconds 3 }
  }
  if ($https) { Write-Host "https://$Domain is live." -ForegroundColor Green }
  else { Note "https://$Domain did not answer yet. Check DNS and that ports 80/443 are open, then look at $caddyLog. Caddy keeps retrying." }
}

# ------------------------------------------------------------------ HTTPS with IIS
if ($Web -eq 'IIS') {
  Step "Setting up IIS for $Domain"
  Import-Module WebAdministration
  $inetsrv = Join-Path $env:SystemRoot 'System32\inetsrv'

  # URL Rewrite and Application Request Routing (ARR), from Microsoft, only if missing.
  function Install-IisModule([string]$Name, [string]$Url) {
    $msi = Join-Path $env:TEMP (Split-Path $Url -Leaf)
    Write-Host "Installing $Name from Microsoft..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest $Url -OutFile $msi -UseBasicParsing
    $sig = Get-AuthenticodeSignature $msi
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
      Remove-Item $msi -Force
      Fail "The downloaded $Name installer is not signed by Microsoft. Install $Name yourself from https://www.iis.net/downloads, then re-run."
    }
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    Remove-Item $msi -Force
    if ($p.ExitCode -notin 0, 3010) { Fail "Installing $Name failed (msiexec code $($p.ExitCode))." }
  }
  if (-not (Test-Path (Join-Path $inetsrv 'rewrite.dll'))) {
    Install-IisModule 'IIS URL Rewrite 2.1' 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi'
  }
  $arrInstalled = $true
  try { Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -ErrorAction Stop | Out-Null } catch { $arrInstalled = $false }
  if (-not $arrInstalled) {
    Install-IisModule 'IIS Application Request Routing 3.0' 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi'
  }
  # Let IIS forward requests. This only affects sites whose rules forward to another address, like LoanDesk's.
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'preserveHostHeader' -Value 'True'
  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'timeout' -Value '00:02:00'

  # The site: an empty folder whose web.config redirects HTTP to HTTPS and forwards everything to LoanDesk.
  $siteDir = Join-Path $AppDir 'iis'
  New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
  Write-TextFile (Join-Path $siteDir 'web.config') @"
<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by scripts/install-production.ps1: IIS in front of LoanDesk on 127.0.0.1:$Port. -->
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="LoanDesk: HTTP to HTTPS" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{HTTPS}" pattern="off" />
            <add input="{REQUEST_URI}" pattern="^/\.well-known/acme-challenge/" negate="true" />
          </conditions>
          <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
        </rule>
        <rule name="LoanDesk: forward" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{REQUEST_URI}" pattern="^/\.well-known/acme-challenge/" negate="true" />
          </conditions>
          <action type="Rewrite" url="http://127.0.0.1:$Port/{R:1}" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="52428800" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
        <add name="Strict-Transport-Security" value="max-age=31536000; includeSubDomains" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
"@
  $pool = 'LoanDesk'
  if (-not (Test-Path "IIS:\AppPools\$pool")) {
    New-WebAppPool -Name $pool | Out-Null
    Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
  }
  $site = Get-Website | Where-Object { $_.Name -eq 'LoanDesk' }
  $taken = Get-WebBinding | Where-Object { $_.bindingInformation -match ":$([regex]::Escape($Domain))$" -and $_.ItemXPath -notmatch "@name='LoanDesk'" }
  if ($taken) { Fail "Another IIS site already has a binding for $Domain. Remove it in IIS Manager, then re-run." }
  if (-not $site) {
    $site = New-Website -Name 'LoanDesk' -PhysicalPath $siteDir -ApplicationPool $pool -HostHeader $Domain -Port 80 -IPAddress '*'
  } else {
    Set-ItemProperty 'IIS:\Sites\LoanDesk' -Name physicalPath -Value $siteDir
    Set-ItemProperty 'IIS:\Sites\LoanDesk' -Name applicationPool -Value $pool
    if (-not (Get-WebBinding -Name 'LoanDesk' -Protocol http -HostHeader $Domain)) { New-WebBinding -Name 'LoanDesk' -Protocol http -Port 80 -HostHeader $Domain }
  }
  Start-Website -Name 'LoanDesk' -ErrorAction SilentlyContinue
  try {
    $r = Invoke-WebRequest "http://127.0.0.1/api/health" -Headers @{ Host = $Domain } -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10 -ErrorAction Stop
    Write-Host "IIS forwards to LoanDesk (HTTP $($r.StatusCode))."
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -in 301, 302) { Write-Host 'IIS answers for the domain and redirects HTTP to HTTPS.' }
    else { Note "IIS did not forward the test request: $($_.Exception.Message)" }
  }

  # Certificate with win-acme: an existing installation (found through its renewal task) or -WacsPath.
  if (-not $WacsPath) {
    $WacsPath = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'win-acme*' } |
      ForEach-Object { $_.Actions.Execute } | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  }
  if (-not $WacsPath) {
    $WacsPath = @('C:\Program Files\win-acme\wacs.exe', 'C:\win-acme\wacs.exe', 'C:\tools\win-acme\wacs.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  $hasHttps = Get-WebBinding -Name 'LoanDesk' -Protocol https -HostHeader $Domain
  if ($hasHttps) {
    Write-Host "IIS already has an HTTPS binding for $Domain; win-acme keeps renewing it."
  } elseif (-not $WacsPath) {
    Note ("win-acme (wacs.exe) was not found. Re-run with -WacsPath 'C:\path\to\wacs.exe', or open win-acme, choose " +
      "'Create certificate (default settings)' and pick the site 'LoanDesk' ($Domain).")
  } else {
    if (-not $AcmeEmail) { $AcmeEmail = $OverlordEmail }
    $wacsArgs = @('--source', 'iis', '--siteid', "$($site.Id)", '--host', $Domain, '--installation', 'iis', '--accepttos')
    if ($AcmeEmail) { $wacsArgs += @('--emailaddress', $AcmeEmail) }
    Write-Host "Requesting the certificate with $WacsPath ..."
    & $WacsPath @wacsArgs
    if ($LASTEXITCODE -ne 0 -or -not (Get-WebBinding -Name 'LoanDesk' -Protocol https -HostHeader $Domain)) {
      Note ("win-acme did not finish (see its output above). Open win-acme, choose 'Create certificate (default settings)' " +
        "and pick the site 'LoanDesk' ($Domain); it then renews it with your other certificates.")
    }
  }
  try {
    $h2 = Invoke-RestMethod "https://$Domain/api/health" -TimeoutSec 10
    if ($h2.ok) { Write-Host "https://$Domain is live." -ForegroundColor Green }
  } catch { Note "https://$Domain did not answer yet ($($_.Exception.Message)). Check DNS and the HTTPS binding of the LoanDesk site in IIS." }
}

# ------------------------------------------------------------------ summary
Step 'Done - LoanDesk is installed'
$base = if ($Web -eq 'None') { "http://<this server>:$Port" } else { "https://$Domain" }
Write-Host ''
Write-Host "  Home page     : $base/"
Write-Host "  Field app     : $base/app/"
Write-Host "  Admin console : $base/admin/"
Write-Host "  Overlord      : $base/overlord/"
Write-Host "  Database      : $DbName on ${DbHost}:$DbPort as $DbUser"
Write-Host "  App folder    : $AppDir   (settings in $EnvFile, logs in $AppDir\logs)"
if ($NewCreds.Count) {
  Write-Host '  New accounts  :' -ForegroundColor Cyan
  $NewCreds | ForEach-Object { Write-Host "    $_" -ForegroundColor Cyan }
  Write-Host "    (saved in $CredFile - change the passwords after signing in)"
} else {
  Write-Host '  Accounts      : unchanged (existing admin and overlord accounts kept)'
}
if (-not $UpdateKey) { Write-Host '  Updates       : add UPDATE_PUBLIC_KEY to .env (node scripts\patch.js keygen on the release PC) to install updates from the overlord console.' }
Write-Host "  Restart       : Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName"
if ($firstInstall) { Write-Host '  Next          : sign in to the overlord console, scan the QR code, then sign in to the admin console and change its password.' }
Write-Host ''
