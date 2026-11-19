@echo off
rem Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
rem Imports GitHub issues and pull requests into Circagraph timelines: cg-import-github --help,
rem and github.md. OCH_API_URL, OCH_API_KEY and GITHUB_TOKEN come from the environment or, when
rem it has no API key, github.env.
setlocal
set "HERE=%~dp0"
if "%OCH_API_KEY%"=="" if exist "%ProgramData%\Circagraph\github.env" set "OCH_CONFIG=%ProgramData%\Circagraph\github.env"
"%HERE%node\node.exe" "%HERE%app\server\import-github.mjs" %*
