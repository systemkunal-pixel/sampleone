# Shows LoanDesk's "Updating — back in a minute" page instead of IIS's "502 - Web server received an
# invalid response" while LoanDesk is updating or restarting. Run once on the server, in PowerShell as
# Administrator (install-production.ps1 also does this on a fresh install). Safe to run again.
#
#   powershell -ExecutionPolicy Bypass -File C:\websites\loandesk\app\scripts\iis-updating-page.ps1
#
# It copies deploy\updating.html into the IIS site folder and adds one custom-error entry (for 502) to
# the site's web.config. LoanDesk's own error replies (JSON) are not touched: IIS only uses the page for
# the 502 it generates itself when LoanDesk does not answer.
[CmdletBinding()]
param(
  [string]$AppDir = 'C:\websites\loandesk\app',
  [string]$SiteDir = 'C:\websites\loandesk\site'
)
$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

$page = Join-Path $AppDir 'deploy\updating.html'
$config = Join-Path $SiteDir 'web.config'
if (-not (Test-Path $page)) { throw "$page not found. Install LoanDesk 1.5.2 or later first." }
if (-not (Test-Path $config)) { throw "$config not found. Is -SiteDir the IIS site folder of LoanDesk?" }

$target = Join-Path $SiteDir 'updating.html'
Copy-Item $page $target -Force

# A site's web.config may point its error page at a full path only when the server allows it.
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/httpErrors' -Name 'allowAbsolutePathsWhenDelegated' -Value 'True'

Copy-Item $config "$config.bak" -Force
[xml]$xml = Get-Content $config -Raw
$ws = $xml.configuration.'system.webServer'
$errors = $ws.SelectSingleNode('httpErrors')
if (-not $errors) { $errors = $ws.AppendChild($xml.CreateElement('httpErrors')) }
foreach ($n in @($errors.SelectNodes("*[@statusCode='502']"))) { [void]$errors.RemoveChild($n) }
$remove = $xml.CreateElement('remove'); $remove.SetAttribute('statusCode', '502')
$add = $xml.CreateElement('error')
$add.SetAttribute('statusCode', '502'); $add.SetAttribute('path', $target); $add.SetAttribute('responseMode', 'File')
[void]$errors.AppendChild($remove); [void]$errors.AppendChild($add)
$settings = New-Object Xml.XmlWriterSettings
$settings.Indent = $true; $settings.Encoding = New-Object Text.UTF8Encoding $false
$w = [Xml.XmlWriter]::Create($config, $settings); $xml.Save($w); $w.Close()

Write-Host "Done. While LoanDesk is down, visitors now see $target instead of the IIS 502 page."
Write-Host "The old web.config is kept as $config.bak."
