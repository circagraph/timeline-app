# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# An upgrade stops the services: the server starts again once circagraph-migrate has run.
# circagraph-setup creates the system users, under the names the installation's configuration
# has (circagraph, or openchronology for one from before the rename).
for service in circagraph circagraph_mail circagraph_syslog circagraph_github; do
  if [ -x "/usr/local/etc/rc.d/$service" ]; then
    service "$service" onestop >/dev/null 2>&1 || true
  fi
done
exit 0
