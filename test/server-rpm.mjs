// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Installs a server .rpm (scripts/server-package.mjs) in a fresh container of its distribution
// and checks the first install (PostgreSQL initialized for it), the running server, an upgrade
// and removal (#116); then its installation over the last openchronology-server release, which it
// replaces.
// Usage: node test/server-rpm.mjs server-artifacts/circagraph-server-<target>-amd64.rpm
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serverPackage, serverTargets } from '../scripts/server-targets.mjs';
import { checkSystemdServices } from './server-syslog.mjs';
import { checkServicesUpgrade } from './server-upgrade-services.mjs';

const run = promisify(execFile);
/** The last release of openchronology-server, which this package replaces. */
const PREVIOUS = 'v0.30.2';
const rpm = resolve(process.argv[2] ?? '');
const target = Object.keys(serverTargets).find((t) => basename(rpm) === serverPackage(t));
const base = target && serverTargets[target].format === 'rpm' && serverTargets[target].base;
if (!base) throw new Error('Pass a server .rpm built by scripts/server-package.mjs.');
const name = 'och-server-rpm-' + process.pid;
const sh = async (script, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await run('docker', ['exec', name, 'bash', '-c', script], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout + stderr;
  } catch (error) {
    if (allowFailure) return (error.stdout ?? '') + (error.stderr ?? '');
    throw new Error(`${script}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
};
const psql = (sql, db = 'circagraph') =>
  sh(`runuser -u postgres -- psql -X -Atq -d ${db} -c "${sql}"`).then((s) => s.trim());
const file = '/tmp/' + basename(rpm);

await run('docker', ['run', '-d', '--rm', '--name', name, base, 'sleep', 'infinity']);
try {
  await run('docker', ['cp', rpm, `${name}:${file}`]);
  // dnf retries a failed download and gives up on a stalled mirror after 30 s (#367).
  await sh("sed -i '/^\\[main\\]/a retries=3\\ntimeout=30' /etc/dnf/dnf.conf");
  // A server without systemd, like a container: the package initializes and starts
  // PostgreSQL itself.
  // dnf 5 (Fedora) prints the package scripts' output; dnf 4 (Rocky, RHEL) logs it.
  const install = await sh(
    `dnf install -y -q ${file} 2>&1; cat /var/log/dnf.rpm.log 2>/dev/null || true`,
  );
  assert.match(install, /Circagraph is installed and ready/, install.slice(-3000));
  assert.match(install, /Circagraph schema installed\./);

  // The database, its pgmp extension and the configuration.
  assert.equal(
    await psql("SELECT rolname FROM pg_roles WHERE rolname='circagraph'", 'postgres'),
    'circagraph',
  );
  assert.equal(await psql("SELECT extname FROM pg_extension WHERE extname='pgmp'"), 'pgmp');
  assert.equal(await psql("SELECT '1/3'::mpq + '1/6'::mpq"), '1/2');
  assert.equal(await psql("SELECT to_regclass('oc_timelines') IS NOT NULL"), 't');
  const config = await sh(
    'stat -c "%a %U %G" /etc/circagraph/circagraph.env && cat /etc/circagraph/circagraph.env',
  );
  assert.match(config, /^640 root circagraph/);
  assert.match(config, /^AUTH_ENCRYPTION_KEY=[a-f0-9]{64}$/m);
  assert.match(config, /^DATABASE_URL=postgresql:\/\/\/circagraph\?host=\/var\/run\/postgresql$/m);
  // Local connections authenticate as the operating system user.
  assert.match(await sh('cat /var/lib/pgsql/data/pg_hba.conf'), /^local\s+all\s+all\s+peer/m);

  // The server runs as its service would (no systemd here), and answers.
  await sh(
    'runuser -u circagraph -- /usr/lib/circagraph/node/bin/node /usr/lib/circagraph/circagraph-server.mjs > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid',
  );
  let health = '';
  for (let i = 0; i < 60 && !health.includes('200'); i++) {
    health = await sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/healthz', {
      allowFailure: true,
    });
    if (!health.includes('200')) await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(health.trim(), '200', await sh('cat /tmp/server.log', { allowFailure: true }));
  const session = JSON.parse(await sh('curl -s http://127.0.0.1:5173/api/session'));
  assert.equal(session.server, true, 'The server reaches its database.');
  assert.equal(
    (await sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/api/plugins')).trim(),
    '200',
  );
  assert.match(await sh('curl -s http://127.0.0.1:5173/'), /<html/i);
  // The SQLite converter finds its libraries on this distribution.
  assert.doesNotMatch(await sh('ldd /usr/lib/circagraph/bin/och-convert'), /not found/);
  assert.match(await sh('cg-import-logs --help'), /^Usage: cg-import-logs/);
  assert.match(await sh('cg-import-github --help'), /^Usage: cg-import-github/);
  // The GitHub receiver is installed, with its configuration template, and loads with the
  // bundled Node.js; it refuses to start without the webhook's secret.
  assert.match(
    await sh(
      'test -f /usr/lib/systemd/system/circagraph-github.service && test -f /usr/share/circagraph/github.env.example && echo installed',
    ),
    /installed/,
  );
  assert.match(
    await sh(
      `cd /usr/lib/circagraph && GITHUB_ROUTES_JSON='{"default":"00000000-0000-0000-0000-000000000000"}' node/bin/node server/github-receiver.mjs 2>&1; true`,
    ),
    /GITHUB_WEBHOOK_SECRET/,
  );
  // The journald follower is installed, and loads with the bundled Node.js (#151).
  assert.match(
    await sh(
      'test -f /usr/lib/systemd/system/circagraph-journald.service && test -f /usr/share/circagraph/journald.env.example && echo installed',
    ),
    /installed/,
  );
  assert.match(
    await sh('cd /usr/lib/circagraph && node/bin/node server/journald-receiver.mjs 2>&1; true'),
    /Set JOURNALD_TIMELINE/,
  );
  // The services are valid systemd units, and the syslog receiver delivers a message into a
  // timeline as its unit runs it (#125).
  await checkSystemdServices({
    sh,
    psql,
    name: target,
    installSystemd: 'dnf install -y -q systemd',
  });
  await sh('kill "$(cat /tmp/server.pid)" || true');

  // The administrator (#118): its password is read whole from the configuration, # and
  // all, and circagraph-reset-admin-password sets it again.
  const adminPassword = 'Abc!def#ghi@jkl-mno';
  await sh(
    `sed -i -e 's/^ADMIN_USERNAME=.*/ADMIN_USERNAME=admin/' -e 's/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=${adminPassword}/' /etc/circagraph/circagraph.env`,
  );
  await sh('circagraph-migrate --no-restart');
  const adminMatches = async () =>
    (
      await sh(
        `cd / && /usr/lib/circagraph/node/bin/node --input-type=module -e "import { passwordMatches } from '/usr/lib/circagraph/server/auth.mjs'; console.log(await passwordMatches(process.argv[1], process.argv[2]))" '${adminPassword}' "$(runuser -u postgres -- psql -X -Atq -d circagraph -c "SELECT password_hash FROM oc_users WHERE username='admin'")"`,
      )
    ).trim();
  assert.equal(await adminMatches(), 'true', 'the administrator has the whole password');
  await psql("UPDATE oc_users SET password_hash=NULL WHERE username='admin'");
  assert.equal(await adminMatches(), 'false');
  const reset = await sh('circagraph-reset-admin-password 2>&1');
  assert.match(
    reset,
    /The password of admin \(administrator\) is now ADMIN_INITIAL_PASSWORD/,
    reset,
  );
  assert.equal(await adminMatches(), 'true');

  // Reinstalling takes the upgrade path: configuration and database are kept, and the
  // administrator is told what to review and to run circagraph-migrate.
  await psql(
    "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
  );
  const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(config)[0];
  // The mail worker and the log importers, enabled and running, are stopped by the upgrade
  // and started again by circagraph-migrate (#371, #374).
  const { upgrade, migrate } = await checkServicesUpgrade({
    sh,
    upgrade: () => sh(`rpm -Uvh --replacepkgs ${file} 2>&1`),
  });
  assert.match(upgrade, /is installed over an earlier version/, upgrade);
  assert.match(upgrade, /sudo circagraph-migrate/);
  assert.match(upgrade, /diff -u \/etc\/circagraph\/circagraph\.env/);
  assert.match(await sh('cat /etc/circagraph/circagraph.env'), new RegExp('^' + key + '$', 'm'));
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
  assert.match(migrate, /Circagraph schema installed\./);
  // Setup is safe to run again by hand.
  assert.match(await sh('circagraph-setup 2>&1'), /Circagraph is installed and ready/);

  // Removing it keeps the configuration and the database, and says how to delete them.
  const remove = await sh('rpm -e circagraph-server 2>&1');
  assert.match(
    remove,
    /the PostgreSQL database and the circagraph and circagraph-logs system users remain/i,
  );
  assert.match(await sh('test -e /etc/circagraph && echo present || echo gone'), /present/);
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}

// Installed over openchronology-server, the package's name until 0.30: dnf replaces it (Obsoletes),
// the configuration moves to /etc/circagraph, and the installation keeps its users and database.
// The old package's removal comes after the new package's %post and disables its services by
// their old names; those enabled before are enabled again under their new names at the end of
// the transaction. A stand-in systemctl keeps the units' enabled state (there is no systemd).
const previous = `https://github.com/circagraph/timeline-app/releases/download/${PREVIOUS}/openchronology-server-${target}-amd64.rpm`;
const enabledState = '/run/och-test-systemd';
const fakeSystemctl = `#!/bin/bash
# A stand-in for systemctl that keeps the units' enabled state (test/server-rpm.mjs).
echo "systemctl $*" >> ${enabledState}/calls
action= status=0
for arg; do
  case $arg in
    -*) ;;
    *) if [ -z "$action" ]; then action=$arg; continue; fi
       unit=${enabledState}/\${arg%.service}.service.enabled
       case $action in
         enable) touch "$unit" ;;
         disable) rm -f "$unit" ;;
         is-enabled) [ -e "$unit" ] || status=1 ;;
         is-active) status=3 ;;
       esac ;;
  esac
done
exit $status
`;
await run('docker', ['run', '-d', '--rm', '--name', name, base, 'sleep', 'infinity']);
try {
  await run('docker', ['cp', rpm, `${name}:${file}`]);
  await sh("sed -i '/^\\[main\\]/a retries=3\\ntimeout=30' /etc/dnf/dnf.conf");
  const old = await sh(
    `dnf install -y -q ${previous} 2>&1; cat /var/log/dnf.rpm.log 2>/dev/null || true`,
  );
  assert.match(old, /OpenChronology is installed and ready/, old.slice(-3000));
  await psql(
    "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
    'openchronology',
  );
  const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(
    await sh('cat /etc/openchronology/openchronology.env'),
  )[0];
  // The server and its mail worker enabled, the log importers not.
  await sh(
    `set -e; real=$(command -v systemctl || true); mkdir -p ${enabledState} /run/systemd/system; ` +
      `echo ${Buffer.from(fakeSystemctl).toString('base64')} | base64 -d > "\${real:-/usr/bin/systemctl}"; ` +
      `chmod 0755 "\${real:-/usr/bin/systemctl}"; ` +
      'systemctl enable openchronology.service openchronology-mail.service; ' +
      ': > /var/log/dnf.rpm.log 2>/dev/null || true',
  );
  const replaced = await sh(
    `dnf install -y -q ${file} 2>&1; cat /var/log/dnf.rpm.log 2>/dev/null || true`,
  );
  assert.match(replaced, /is installed over openchronology-server/, replaced.slice(-3000));
  assert.match(replaced, /OpenChronology is now Circagraph\. Its configuration was kept/);
  assert.match(
    replaced,
    /Enabled again under their new names: circagraph\.service circagraph-mail\.service/,
  );
  assert.match(replaced, /sudo -u postgres pg_dump openchronology > openchronology\.sql/);
  assert.doesNotMatch(replaced, /Circagraph is installed and/);
  assert.match(await sh('rpm -q openchronology-server; true'), /not installed/);
  assert.match(await sh('rpm -q --whatprovides openchronology-server'), /^circagraph-server-/);
  // The old package's removal disabled the services by their old names first; then they were
  // enabled under their new ones.
  const calls = await sh(`cat ${enabledState}/calls`);
  assert.match(
    calls,
    /^systemctl disable --now openchronology\.service[^]*^systemctl enable --quiet circagraph\.service circagraph-mail\.service$/m,
    calls,
  );
  assert.equal(
    (await sh(`ls ${enabledState} | grep enabled`)).trim(),
    'circagraph-mail.service.enabled\ncircagraph.service.enabled',
  );
  assert.match(await sh('ls /var/lib/rpm-state/circagraph-server 2>&1; true'), /No such file/);
  // The configuration, moved, with links under its old names; the users and database kept.
  assert.equal(
    (await sh('readlink /etc/openchronology; readlink /etc/circagraph/openchronology.env')).trim(),
    'circagraph\ncircagraph.env',
  );
  const config = await sh(
    'stat -c "%a %U %G" /etc/circagraph/circagraph.env && cat /etc/circagraph/circagraph.env',
  );
  assert.match(config, /^640 root openchronology/);
  assert.match(config, new RegExp('^' + key + '$', 'm'));
  assert.match(config, /^DATABASE_URL=postgresql:\/\/\/openchronology\?/m);
  assert.equal((await sh('getent passwd circagraph circagraph-logs; true')).trim(), '');
  assert.match(
    await sh('stat -c "%U %G" /etc/circagraph/syslog.env'),
    /^root openchronology-logs$/m,
  );
  assert.match(
    await sh('cat /etc/systemd/system/circagraph.service.d/50-users.conf'),
    /^User=openchronology\nGroup=openchronology$/m,
  );
  assert.match(
    await sh('cat /etc/systemd/system/circagraph-github.service.d/50-users.conf'),
    /^User=openchronology-logs\n[^]*^StateDirectory=openchronology-github$/m,
  );
  // The commands, under both names, as the installation's user.
  const migrated = await sh('openchronology-migrate --no-restart 2>&1');
  assert.match(migrated, /Circagraph schema (installed|is current)|migrat/i, migrated);
  assert.equal(
    await psql("SELECT count(*) FROM oc_users WHERE username='kept'", 'openchronology'),
    '1',
  );
  assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
  assert.match(await sh('openchronology-setup 2>&1'), /Circagraph is installed and running/);
  // Removing it keeps the moved configuration and its link, and names the users it keeps.
  const remove = await sh('rpm -e circagraph-server 2>&1');
  assert.match(remove, /dropdb openchronology/, remove);
  assert.match(remove, /sudo rm -rf \/etc\/circagraph \/etc\/openchronology /);
  assert.equal(
    (
      await sh('readlink /etc/openchronology; test -f /etc/circagraph/circagraph.env && echo kept')
    ).trim(),
    'circagraph\nkept',
  );
  assert.match(await sh('ls /etc/systemd/system/circagraph.service.d 2>&1; true'), /No such file/);
  assert.equal((await sh(`ls ${enabledState} | grep enabled; true`)).trim(), '');
  assert.equal(
    await psql("SELECT count(*) FROM oc_users WHERE username='kept'", 'openchronology'),
    '1',
  );
  console.log(
    `PASS server package on ${base}: install, PostgreSQL initialized, database with pgmp, server, upgrade, removal, and in place of openchronology-server ${PREVIOUS}.`,
  );
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}
