# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# Upgrades reinstall the package at once; a removal says what it left behind, under the names
# the installation has: circagraph, or openchronology for one from before the rename.
if [ "${PKG_UPGRADE:-}" = true ]; then
  exit 0
fi
user=$(stat -L -f %Sg /usr/local/etc/circagraph/circagraph.env 2>/dev/null) || user=circagraph
case $user in
  circagraph | openchronology) ;;
  *) user=circagraph ;;
esac
cat <<MSG

Circagraph was removed. Its configuration (/usr/local/etc/circagraph, including
AUTH_ENCRYPTION_KEY), the PostgreSQL database and the $user and $user-logs
system users remain. To delete them as well:

  sysrc -x circagraph_enable circagraph_mail_enable circagraph_syslog_enable \\
    circagraph_github_enable circagraph_account
  rm -rf /usr/local/etc/circagraph /usr/local/etc/openchronology /var/db/$user \\
    /var/db/$user-github
  su -l postgres -c 'dropdb $user && dropuser $user'
  pw userdel $user
  pw userdel $user-logs

MSG
exit 0
