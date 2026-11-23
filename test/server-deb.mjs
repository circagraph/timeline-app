// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Installs a server .deb (scripts/server-package.mjs) in a fresh container of its distribution and
// checks the first install, the running server, an upgrade and a purge; then its installation
// over the last openchronology-server release, which it replaces.
// Usage: node test/server-deb.mjs server-artifacts/circagraph-server-<target>-amd64.deb
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
const deb = resolve(process.argv[2] ?? '');
const target = Object.keys(serverTargets).find((t) => basename(deb) === serverPackage(t));
const base = target && serverTargets[target].format === 'deb' && serverTargets[target].base;
if (!base) throw new Error('Pass a server .deb built by scripts/server-package.mjs.');
const name = 'och-server-deb-' + process.pid;
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

await run('docker', ['run', '-d', '--rm', '--name', name, base, 'sleep', 'infinity']);
try {
  await run('docker', ['cp', deb, `${name}:/tmp/${basename(deb)}`]);
  // apt retries a failed download and gives up on a stalled mirror after 30 s (#367).
  await sh(
    `printf 'Acquire::Retries "3";\\nAcquire::http::Timeout "30";\\nAcquire::https::Timeout "30";\\n' > /etc/apt/apt.conf.d/80-retries`,
  );
  // A server without systemd, like a container: the package starts PostgreSQL itself.
  const install = await sh(
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq /tmp/${basename(deb)} curl 2>&1`,
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

  // The server runs as its service would (no systemd here), and answers.
  // The launcher reads the configuration itself when not started by systemd.
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
  // Health checks the tables the platform needs; the plugin catalogue reads the database.
  assert.deepEqual(JSON.parse(await sh('curl -s http://127.0.0.1:5173/healthz')), {
    status: 'ok',
    storage: 'postgresql',
  });
  assert.equal(
    (await sh('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/api/plugins')).trim(),
    '200',
  );
  assert.match(await sh('curl -s http://127.0.0.1:5173/'), /<html/i);
  // The SQLite converter finds its libraries on this distribution.
  assert.doesNotMatch(await sh('ldd /usr/lib/circagraph/bin/cg-convert'), /not found/);
  // och-convert, its name before the rename.
  assert.equal((await sh('readlink /usr/lib/circagraph/bin/och-convert')).trim(), 'cg-convert');
  // The log importer runs as a command with the bundled Node.js.
  assert.match(await sh('cg-import-logs --help'), /^Usage: cg-import-logs/);
  // The GitHub importer too (docs/github.md).
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
  const dry = JSON.parse(
    await sh(
      "printf 'Oct  9 08:15:01 host sshd[1]: Accepted\\n' > /tmp/syslog && cg-import-logs --format syslog --timezone UTC --year 2026 --dry-run --quiet /tmp/syslog 2>/dev/null",
    ),
  );
  assert.equal(dry.entries, 1);
  assert.equal(dry.samples[0].moment.time, `${Date.UTC(2026, 9, 9, 8, 15, 1) / 1000}/1`);
  // The services are valid systemd units, and the syslog receiver delivers a message into a
  // timeline as its unit runs it (#125).
  await checkSystemdServices({
    sh,
    psql,
    name: target,
    installSystemd: 'export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq systemd',
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
    upgrade: () => sh(`dpkg -i /tmp/${basename(deb)} 2>&1`),
  });
  assert.match(upgrade, /is installed over/, upgrade);
  assert.match(upgrade, /sudo circagraph-migrate/);
  assert.match(upgrade, /diff -u \/etc\/circagraph\/circagraph\.env/);
  assert.match(await sh('cat /etc/circagraph/circagraph.env'), new RegExp('^' + key + '$', 'm'));
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
  assert.match(migrate, /Circagraph schema installed\./);

  // Purging removes the configuration and keeps the database.
  const purge = await sh('apt-get purge -y -qq circagraph-server 2>&1');
  assert.match(purge, /never dropped automatically|database and the circagraph/i);
  assert.match(await sh('test -e /etc/circagraph && echo present || echo gone'), /gone/);
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}

// Installed over openchronology-server, the package's name until 0.30: it replaces it, moves the
// configuration to /etc/circagraph and keeps the installation's users and database.
const previous = `https://github.com/circagraph/timeline-app/releases/download/${PREVIOUS}/openchronology-server-${target}-amd64.deb`;
await run('docker', ['run', '-d', '--rm', '--name', name, base, 'sleep', 'infinity']);
try {
  await run('docker', ['cp', deb, `${name}:/tmp/${basename(deb)}`]);
  await sh(
    `printf 'Acquire::Retries "3";\\nAcquire::http::Timeout "30";\\nAcquire::https::Timeout "30";\\n' > /etc/apt/apt.conf.d/80-retries`,
  );
  const old = await sh(
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && curl -fsSL --retry 3 -o /tmp/old.deb ${previous} && apt-get install -y -qq /tmp/old.deb 2>&1`,
  );
  assert.match(old, /OpenChronology is installed and ready/, old.slice(-3000));
  await psql(
    "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
    'openchronology',
  );
  const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(
    await sh('cat /etc/openchronology/openchronology.env'),
  )[0];
  const replaced = await sh(
    `export DEBIAN_FRONTEND=noninteractive; apt-get install -y -qq /tmp/${basename(deb)} 2>&1`,
  );
  assert.match(replaced, /is installed over openchronology-server/, replaced.slice(-3000));
  assert.match(replaced, /OpenChronology is now Circagraph/);
  assert.match(replaced, /sudo -u postgres pg_dump -p \d+ openchronology > openchronology\.sql/);
  assert.doesNotMatch(replaced, /Circagraph is installed and/);
  assert.match(
    await sh("dpkg-query -W -f='${db:Status-Abbrev} ' openchronology-server 2>&1; true"),
    /^(un|rc) |no packages found/,
  );
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
  // Purging removes the moved configuration and its link, and names the users it keeps.
  const purge = await sh('apt-get purge -y -qq circagraph-server 2>&1');
  assert.match(purge, /dropdb openchronology/);
  assert.match(
    await sh('ls -d /etc/openchronology /etc/circagraph 2>&1; true'),
    /No such file[^]*No such file/,
  );
  assert.match(await sh('ls /etc/systemd/system/circagraph.service.d 2>&1; true'), /No such file/);
  console.log(
    `PASS server package on ${base}: install, database with pgmp, server, upgrade, purge, and in place of openchronology-server ${PREVIOUS}.`,
  );
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}
