# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# pkg ends whatever a package's scripts leave running, so the package starts nothing: a first
# installation is finished by circagraph-setup, run by the administrator. An upgrade (its
# configuration exists) is advised on, as the other packages do; so is an installation of
# openchronology-server (the package's name until 0.30), whose configuration moves now.
if [ -e /usr/local/etc/circagraph/circagraph.env ] ||
  { [ -e /usr/local/etc/openchronology/openchronology.env ] && [ ! -L /usr/local/etc/openchronology ]; }; then
  /usr/local/sbin/circagraph-setup upgrade || true
else
  cat <<'MSG'

Circagraph is installed. To finish, as root:

  circagraph-setup

It initializes and enables PostgreSQL if needed, creates the circagraph database, and
enables and starts the circagraph service on 127.0.0.1:5173.
See /usr/local/share/doc/circagraph-server/README.FreeBSD.

MSG
fi
exit 0
