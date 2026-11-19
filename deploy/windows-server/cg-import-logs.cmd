@echo off
rem Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
rem Imports log files into Circagraph timelines: cg-import-logs --help, and log-import.md.
rem OCH_API_URL and OCH_API_KEY come from the environment or, when it has none, syslog.env.
setlocal
set "HERE=%~dp0"
if "%OCH_API_KEY%"=="" if exist "%ProgramData%\Circagraph\syslog.env" set "OCH_CONFIG=%ProgramData%\Circagraph\syslog.env"
"%HERE%node\node.exe" "%HERE%app\server\import-logs.mjs" %*
