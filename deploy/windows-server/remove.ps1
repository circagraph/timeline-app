# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# Removes the Circagraph services (the server, the syslog and GitHub receivers, email
# delivery and PostgreSQL) before the uninstaller deletes the installation (#116, #125). The
# configuration and the database, in %ProgramData%\Circagraph, remain.
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference = 'Continue'
# Each WinSW service, and the copy of the wrapper that installed it.
$services = [ordered]@{
  CircagraphSyslog = 'circagraph-syslog-service.exe'
  CircagraphGitHub = 'circagraph-github-service.exe'
  CircagraphMail   = 'circagraph-mail-service.exe'
  Circagraph       = 'circagraph-service.exe'
}
foreach ($name in $services.Keys) {
  if (Get-Service $name -ErrorAction SilentlyContinue) {
    Stop-Service $name -Force -ErrorAction SilentlyContinue
    & (Join-Path $InstallDir "service\$($services[$name])") uninstall | Out-Host
  }
}
if (Get-Service CircagraphPostgreSQL -ErrorAction SilentlyContinue) {
  Stop-Service CircagraphPostgreSQL -Force -ErrorAction SilentlyContinue
  & (Join-Path $InstallDir 'pgsql\bin\pg_ctl.exe') unregister -N CircagraphPostgreSQL | Out-Host
}
$data = Join-Path $env:ProgramData 'Circagraph'
Write-Host @"

Circagraph was removed. Its configuration (including AUTH_ENCRYPTION_KEY) and its database
remain in $data; delete that folder to remove them as well (and
$env:ProgramData\OpenChronology, a link to it left by an upgrade from OpenChronology Server,
if there is one).
"@
