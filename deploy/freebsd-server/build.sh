#!/bin/sh
# Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
# Makes the FreeBSD server package (#116) from the platform built on Linux
# (node scripts/server-package.mjs freebsd14, into server-artifacts/): builds
# och-convert and pgmp against FreeBSD's own libraries and PostgreSQL, lays the server out
# under /usr/local with rc.d services, and writes server-artifacts/<asset>.pkg.
# Usage, as root on FreeBSD, from the repository: sh deploy/freebsd-server/build.sh
set -eu
cd "$(dirname "$0")/../.."
REPO=$(pwd)
. "$REPO/server-artifacts/freebsd/build.env" # VERSION, PG_MAJOR, ASSET
HERE=$REPO/deploy/freebsd-server
SHARED=$REPO/deploy/debian-server
WORK=$(mktemp -d /tmp/circagraph-pkg.XXXXXX)
STAGE=$WORK/stage
PREFIX=/usr/local
ROOT=$STAGE$PREFIX
APP=$ROOT/lib/circagraph
DOC=$ROOT/share/doc/circagraph-server

# Build tools, and what the package depends on (its runtime: Node.js, PostgreSQL, GMP, SQLite).
RUNTIME="node24 postgresql${PG_MAJOR}-server postgresql${PG_MAJOR}-client gmp sqlite3"
env ASSUME_ALWAYS_YES=yes pkg install -y $RUNTIME rust gmake python3 pkgconf cmake-core

# och-convert, against FreeBSD's GMP and SQLite in /usr/local.
CFLAGS=-I/usr/local/include LDFLAGS=-L/usr/local/lib RUSTFLAGS="-L native=/usr/local/lib" \
  cargo build --manifest-path native-store/Cargo.toml --release --locked --bin och-convert

# The same pinned pgmp as deploy/Dockerfile.postgres, for FreeBSD's PostgreSQL.
PGMP_COMMIT=1849585416f2bc3d070bf8cef6a659907687ec7f
mkdir -p "$WORK/pgmp"
fetch -q -o "$WORK/pgmp.tar.gz" "https://codeload.github.com/dvarrazzo/pgmp/tar.gz/$PGMP_COMMIT"
tar -xzf "$WORK/pgmp.tar.gz" -C "$WORK/pgmp" --strip-components=1
(
  cd "$WORK/pgmp"
  python3 tools/unmix.py <sql/pgmp.pysql >sql/pgmp--1.1.sql
  python3 tools/sql2extension.py --extname pgmp sql/pgmp--1.1.sql >sql/pgmp--unpackaged--1.1.sql
  gmake PG_CONFIG=/usr/local/bin/pg_config with_llvm=no
  gmake PG_CONFIG=/usr/local/bin/pg_config with_llvm=no DESTDIR="$STAGE" install
)

# The platform, its converter, documentation and configuration templates.
mkdir -p "$ROOT/lib" "$ROOT/share/doc"
tar -xzf "$REPO/server-artifacts/circagraph-server-platform.tar.gz" -C "$WORK"
mv "$WORK/lib/circagraph" "$APP"
mv "$WORK/doc" "$DOC"
mkdir -p "$APP/bin" "$DOC/pgmp"
install -m 0755 native-store/target/release/och-convert "$APP/bin/och-convert"
install -m 0755 "$SHARED/circagraph-log-files" "$APP/bin/circagraph-log-files"
install -m 0644 "$WORK/pgmp/COPYING" "$DOC/pgmp/COPYING"
sed "s/@PG_MAJOR@/$PG_MAJOR/g" "$HERE/README.FreeBSD" >"$DOC/README.FreeBSD"
# The Linux packages' templates, with FreeBSD's paths: configuration under /usr/local/etc,
# PostgreSQL's socket in /tmp, and rc.d services. The database user is named: FreeBSD's su -m
# keeps the caller's USER, which the PostgreSQL client would otherwise connect as. The
# templates name circagraph's; circagraph-setup writes the installation's user instead.
freebsd_paths() {
  sed -e 's|/etc/circagraph|/usr/local/etc/circagraph|g' \
    -e 's|/usr/lib/circagraph|/usr/local/lib/circagraph|g' \
    -e 's|/usr/share/|/usr/local/share/|g' \
    -e 's|sudo systemctl restart circagraph|service circagraph restart|g' \
    -e 's|\(sudo \)\{0,1\}systemctl enable --now circagraph-\([a-z]*\)|sysrc circagraph_\2_enable=YES \&\& service circagraph_\2 start|g' \
    -e 's|sudo circagraph-|circagraph-|g' \
    -e 's|postgresql:///circagraph?host=/var/run/postgresql|postgresql://circagraph@/circagraph?host=/tmp|' \
    -e 's|/var/lib/circagraph-github|/var/db/circagraph-github|g' \
    -e 's|README.Debian|README.FreeBSD|g' "$@"
}
mkdir -p "$ROOT/share/circagraph"
freebsd_paths "$SHARED/circagraph.env" >"$ROOT/share/circagraph/circagraph.env.example"
freebsd_paths "$SHARED/syslog.env" >"$ROOT/share/circagraph/syslog.env.example"
freebsd_paths "$SHARED/github.env" >"$ROOT/share/circagraph/github.env.example"
mkdir -p "$ROOT/etc/rc.d" "$ROOT/sbin" "$ROOT/bin"
for service in circagraph circagraph_mail circagraph_syslog circagraph_github; do
  install -m 0755 "$HERE/$service.rc" "$ROOT/etc/rc.d/$service"
done
sed -e "s/@PG_MAJOR@/$PG_MAJOR/g" -e "s/@VERSION@/$VERSION/g" "$HERE/circagraph-setup" \
  >"$ROOT/sbin/circagraph-setup"
chmod 0755 "$ROOT/sbin/circagraph-setup"
install -m 0755 "$HERE/circagraph-migrate" "$ROOT/sbin/circagraph-migrate"
install -m 0755 "$HERE/circagraph-reset-admin-password" \
  "$ROOT/sbin/circagraph-reset-admin-password"
for tool in cg-import-logs cg-import-github; do
  freebsd_paths "$SHARED/$tool" |
    sed 's|"\$APP/node/bin/node"|/usr/local/bin/node|g' >"$ROOT/bin/$tool"
  chmod 0755 "$ROOT/bin/$tool"
done
# The commands' names until 0.30. openchronology-server has these files, and pgmp's: pkg
# removes it when installing this package, which is how this package replaces it.
for command in setup migrate reset-admin-password; do
  ln -s "circagraph-$command" "$ROOT/sbin/openchronology-$command"
done
ln -s cg-import-logs "$ROOT/bin/och-import-logs"
ln -s cg-import-github "$ROOT/bin/och-import-github"
find "$STAGE" -type d -exec chmod 0755 {} +

# The package: its manifest, scripts and file list.
META=$WORK/meta
mkdir -p "$META"
deps=
for dep in $RUNTIME; do
  deps="$deps  $(pkg query '%n: { origin: "%o", version: "%v" }' "$dep")
"
done
cat >"$META/+MANIFEST" <<MANIFEST
name: circagraph-server
version: "$VERSION"
origin: www/circagraph-server
comment: "Circagraph timeline platform server"
www: "https://github.com/circagraph/timeline-app"
maintainer: "athan.clark@gmail.com"
prefix: /usr/local
licenselogic: single
licenses: [GPLv3]
categories: [www, databases]
desc: <<EOD
The Circagraph platform: accounts, shared and public timelines, collaboration, search
and live updates, served by Next.js with PostgreSQL storage. Times are exact rationals,
stored with the bundled pgmp extension for PostgreSQL $PG_MAJOR.

The first installation initializes PostgreSQL if it is not yet, creates a local database,
migrates it and starts the circagraph service on 127.0.0.1:5173. Configuration is in
/usr/local/etc/circagraph/circagraph.env. After an upgrade, run circagraph-migrate.
It replaces openchronology-server, its name until 0.30, keeping that installation's
configuration, database and system users.
EOD
deps: {
$deps}
MANIFEST
for script in pre-install post-install pre-deinstall post-deinstall; do
  install -m 0644 "$HERE/$script.sh" "$META/+$(echo "$script" | tr a-z- A-Z_)"
done
(
  cd "$ROOT"
  find . -type f -o -type l | sed 's|^\./||' | sort
  # Directories the package owns, removed with it when empty.
  find lib/circagraph share/circagraph share/doc/circagraph-server \
    -type d | sort -r | sed 's|^|@dir |'
) >"$WORK/plist"
mkdir -p "$WORK/out"
pkg create -m "$META" -r "$STAGE" -p "$WORK/plist" -o "$WORK/out"
cp "$WORK/out/"circagraph-server-*.pkg "$REPO/server-artifacts/$ASSET"
rm -rf "$WORK"
echo "Wrote server-artifacts/$ASSET (circagraph-server $VERSION)"
