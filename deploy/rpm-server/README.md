# deploy/rpm-server

Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only

The `circagraph-server` .rpm for Rocky Linux 10, RHEL 10 and Fedora (#116); it replaces `openchronology-server`, its name until 0.30, and keeps that installation. The [Dockerfile](Dockerfile) builds it for one distribution; run it through [`scripts/server-package.mjs`](../../scripts/server-package.mjs) (`rocky10` or `fedora44`), and check a package with `node test/server-rpm.mjs`. Its services, configuration templates and commands are the [Debian package's](../debian-server/README.md), laid out the same way; only the setup, the spec and the guide are its own. `README.RPM` is the administrator's guide the package installs.

## Contents

| File                                                     | What it is for                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`Dockerfile`](Dockerfile)                               | Builds the .rpm for one distribution: och-convert and pgmp against its own libraries and PostgreSQL, the platform, and the package.                                                              |
| [`circagraph-server.spec.in`](circagraph-server.spec.in) | The RPM spec template: dependencies, the users, the install, removal and replacement scriptlets, and the packaged files.                                                                         |
| [`circagraph-setup`](circagraph-setup)                   | Sets up an installation (run by the package): the configuration, PostgreSQL, the database with pgmp, the migration and the service; moves an openchronology-server installation's configuration. |
| [`README.RPM`](README.RPM)                               | The administrator's guide the package installs: installing, configuring, upgrading and removing.                                                                                                 |
