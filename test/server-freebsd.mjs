// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Installs the FreeBSD server package (deploy/freebsd-server/build.sh) on a fresh FreeBSD
// system and checks the first install (PostgreSQL initialized and enabled, the service
// running), an upgrade and removal (#116), then its installation over openchronology-server,
// the package's name until 0.30. Run as root on a FreeBSD virtual machine that has
// only Node.js for this test:
//   node test/server-freebsd.mjs server-artifacts/circagraph-server-freebsd14-amd64.pkg
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkSyslogService, fetchApi } from './server-syslog.mjs';

const run = promisify(execFile);
const file = resolve(process.argv[2] ?? '');
const target = /circagraph-server-(freebsd\d+)-amd64\.pkg$/.exec(file)?.[1];
if (!target)
  throw new Error('Pass a FreeBSD server package built by deploy/freebsd-server/build.sh.');
const sh = async (script, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await run('sh', ['-c', script], { maxBuffer: 64 * 1024 * 1024 });
    return stdout + stderr;
  } catch (error) {
    if (allowFailure) return (error.stdout ?? '') + (error.stderr ?? '');
    throw new Error(`${script}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
};
const psql = (sql, db = 'circagraph') =>
  sh(`printf '%s\\n' "${sql}" | su -l postgres -c 'psql -X -Atq -d ${db}'`).then((s) => s.trim());
const healthy = async () => {
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch('http://127.0.0.1:5173/healthz');
      if (response.ok) return response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('The server did not answer:\n' + (await sh('tail -50 /var/log/messages')));
};

// Installed as the README says: pkg resolves its dependencies from FreeBSD's repositories,
// starts nothing, and says to finish with circagraph-setup.
const installed = await sh(`env ASSUME_ALWAYS_YES=yes pkg install -y ${file} 2>&1`);
assert.match(installed, /To finish, as root:\s+circagraph-setup/, installed.slice(-4000));
assert.doesNotMatch(
  await sh('service postgresql onestatus 2>&1', { allowFailure: true }),
  /is running/,
);
const install = await sh('circagraph-setup 2>&1');
assert.match(install, /Circagraph is installed and running/, install.slice(-4000));
assert.match(install, /Circagraph schema installed\./);

// PostgreSQL, the database, its pgmp extension and the configuration.
assert.match(await sh('sysrc -n postgresql_enable'), /YES/);
assert.equal(
  await psql("SELECT rolname FROM pg_roles WHERE rolname='circagraph'", 'postgres'),
  'circagraph',
);
assert.equal(await psql("SELECT extname FROM pg_extension WHERE extname='pgmp'"), 'pgmp');
assert.equal(await psql("SELECT '1/3'::mpq + '1/6'::mpq"), '1/2');
assert.equal(await psql("SELECT to_regclass('oc_timelines') IS NOT NULL"), 't');
const configFile = '/usr/local/etc/circagraph/circagraph.env';
const config = await sh(`stat -f '%Lp %Su %Sg' ${configFile} && cat ${configFile}`);
assert.match(config, /^640 root circagraph/);
assert.match(config, /^AUTH_ENCRYPTION_KEY=[a-f0-9]{64}$/m);
assert.match(config, /^DATABASE_URL=postgresql:\/\/circagraph@\/circagraph\?host=\/tmp$/m);

// The rc.d service runs the server, which answers.
assert.match(await sh('sysrc -n circagraph_enable'), /YES/);
assert.match(await sh('service circagraph status'), /is running/);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
const session = await (await fetch('http://127.0.0.1:5173/api/session')).json();
assert.equal(session.server, true, 'The server reaches its database.');
assert.equal((await fetch('http://127.0.0.1:5173/api/plugins')).status, 200);
assert.match(await (await fetch('http://127.0.0.1:5173/')).text(), /<html/i);
// The SQLite converter finds its libraries.
assert.doesNotMatch(await sh('ldd /usr/local/lib/circagraph/bin/cg-convert'), /not found/);
// och-convert, its name before the rename.
assert.equal((await sh('readlink /usr/local/lib/circagraph/bin/och-convert')).trim(), 'cg-convert');
assert.match(await sh('cg-import-logs --help'), /^Usage: cg-import-logs/);
assert.match(await sh('cg-import-github --help'), /^Usage: cg-import-github/);
// The commands' names until 0.30.
assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
assert.match(await sh('och-import-github --help'), /^Usage: cg-import-github/);
// The GitHub receiver's rc.d service and configuration are installed, stopped until enabled.
assert.match(
  await sh(
    'test -x /usr/local/etc/rc.d/circagraph_github && test -f /usr/local/etc/circagraph/github.env && echo installed',
  ),
  /installed/,
);
assert.match(
  await sh('service circagraph_github onestatus 2>&1; true'),
  /circagraph_github is not running/,
);

// The syslog receiver as its rc.d service, run as the circagraph-logs user, delivers a
// message into a timeline (#125).
const syslogConfig = '/usr/local/etc/circagraph';
await checkSyslogService({
  name: 'FreeBSD',
  psql,
  api: fetchApi,
  configure: (key, routes) =>
    sh(
      `sed -i '' 's|^OCH_API_KEY=.*|OCH_API_KEY=${key}|' ${syslogConfig}/syslog.env && printf '%s' '${routes}' > ${syslogConfig}/syslog-routes.json`,
    ),
  start: async () => {
    await sh('sysrc circagraph_syslog_enable=YES && service circagraph_syslog start');
    assert.match(await sh('service circagraph_syslog status'), /is running/);
  },
  stop: async () => {
    assert.match(await sh('ps -U circagraph-logs -o command='), /server\/syslog-receiver\.mjs/);
    await sh('service circagraph_syslog stop && sysrc circagraph_syslog_enable=NO');
  },
  logs: () => sh('grep circagraph_syslog /var/log/messages | tail -40', { allowFailure: true }),
});

// The administrator (#118): its password is read whole from the configuration, # and all,
// and circagraph-reset-admin-password sets it again.
const adminPassword = 'Abc!def#ghi@jkl-mno';
await sh(
  `sed -i '' -e 's/^ADMIN_USERNAME=.*/ADMIN_USERNAME=admin/' -e 's/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=${adminPassword}/' ${configFile}`,
);
await sh('circagraph-migrate --no-restart');
const { passwordMatches } = await import('/usr/local/lib/circagraph/server/auth.mjs');
const adminMatches = async () =>
  passwordMatches(
    adminPassword,
    await psql("SELECT password_hash FROM oc_users WHERE username='admin'"),
  );
assert.equal(await adminMatches(), true, 'the administrator has the whole password');
await psql("UPDATE oc_users SET password_hash=NULL WHERE username='admin'");
assert.equal(await adminMatches(), false);
const reset = await sh('circagraph-reset-admin-password 2>&1');
assert.match(reset, /The password of admin \(administrator\) is now ADMIN_INITIAL_PASSWORD/, reset);
assert.equal(await adminMatches(), true);

// Reinstalling takes the upgrade path: configuration and database are kept, and the
// administrator is told what to review and to run circagraph-migrate.
await psql(
  "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
);
const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(config)[0];
const upgrade = await sh(`env ASSUME_ALWAYS_YES=yes pkg install -f -y ${file} 2>&1`);
assert.match(upgrade, /is installed over an earlier version/, upgrade.slice(-4000));
assert.match(upgrade, /circagraph-migrate/);
assert.doesNotMatch(upgrade, /OpenChronology is now Circagraph/);
assert.match(upgrade, /diff -u \/usr\/local\/etc\/circagraph\/circagraph\.env/);
assert.match(await sh(`cat ${configFile}`), new RegExp('^' + key + '$', 'm'));
assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
const migrated = await sh('circagraph-migrate 2>&1');
assert.match(migrated, /Circagraph schema installed\./);
assert.match(migrated, /Circagraph restarted\./);
// The mail worker and the syslog and GitHub receivers are not enabled, so they stay stopped
// (#371, #374).
assert.doesNotMatch(migrated, /mail worker restarted/);
assert.doesNotMatch(migrated, /syslog receiver restarted/);
assert.doesNotMatch(migrated, /GitHub receiver restarted/);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });

// Removing it stops the service and keeps the configuration and the database.
const remove = await sh('env ASSUME_ALWAYS_YES=yes pkg delete -y circagraph-server 2>&1');
assert.match(
  remove,
  /the PostgreSQL database and the circagraph and circagraph-logs\s+system users remain/i,
);
assert.match(await sh(`test -e ${configFile} && echo present || echo gone`), /present/);
assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
await assert.rejects(fetch('http://127.0.0.1:5173/healthz'));

// Deleted as the removal note says, so that this system is fresh again for the next part.
for (const name of ['', '_mail', '_syslog', '_github'])
  await sh(`sysrc -x circagraph${name}_enable`, { allowFailure: true });
await sh('rm -rf /usr/local/etc/circagraph /var/db/circagraph /var/db/circagraph-github');
await sh(`su -l postgres -c 'dropdb circagraph && dropuser circagraph'`);
await sh('pw userdel circagraph && pw userdel circagraph-logs');

// Installed after openchronology-server, the package's name until 0.30, is removed (pkg will not
// replace it: both have pgmp's files and the old commands' names): the configuration moves to
// /usr/local/etc/circagraph and its rc.conf settings to the new names, and the installation keeps
// its users and database.
const PREVIOUS = 'v0.30.2';
const previous = `https://github.com/circagraph/timeline-app/releases/download/${PREVIOUS}/openchronology-server-${target}-amd64.pkg`;
await sh(`fetch -q -o /tmp/openchronology-server.pkg ${previous}`);
const old = await sh(
  'env ASSUME_ALWAYS_YES=yes pkg install -y /tmp/openchronology-server.pkg 2>&1',
);
assert.match(old, /To finish, as root:\s+openchronology-setup/, old.slice(-4000));
const oldSetup = await sh('openchronology-setup 2>&1');
assert.match(oldSetup, /OpenChronology is installed and running/, oldSetup.slice(-4000));
await psql(
  "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
  'openchronology',
);
const oldKey = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(
  await sh('cat /usr/local/etc/openchronology/openchronology.env'),
)[0];
// An enabled worker stays enabled (not started here: it has no email configuration).
await sh('sysrc openchronology_mail_enable=YES');
const refused = await sh(`env ASSUME_ALWAYS_YES=yes pkg install -y ${file} 2>&1 || true`);
assert.match(refused, /conflicts with openchronology-server/, refused.slice(-4000));
await sh('env ASSUME_ALWAYS_YES=yes pkg delete -y openchronology-server 2>&1');
const replaced = await sh(`env ASSUME_ALWAYS_YES=yes pkg install -y ${file} 2>&1`);
assert.match(
  replaced,
  /Circagraph \S+ is installed over openchronology-server/,
  replaced.slice(-4000),
);
assert.match(replaced, /OpenChronology is now Circagraph/);
assert.match(replaced, /su -l postgres -c 'pg_dump openchronology' > openchronology\.sql/);
assert.doesNotMatch(replaced, /Circagraph is installed and running/);
assert.match(
  await sh('pkg info -e openchronology-server && echo installed || echo removed'),
  /removed/,
);
// The configuration, moved, with links under its old names; the users and database kept.
assert.equal(
  (
    await sh(
      'readlink /usr/local/etc/openchronology; readlink /usr/local/etc/circagraph/openchronology.env',
    )
  ).trim(),
  'circagraph\ncircagraph.env',
);
const movedConfig = await sh(`stat -f '%Lp %Su %Sg' ${configFile} && cat ${configFile}`);
assert.match(movedConfig, /^640 root openchronology/);
assert.match(movedConfig, new RegExp('^' + oldKey + '$', 'm'));
assert.match(
  movedConfig,
  /^DATABASE_URL=postgresql:\/\/openchronology@\/openchronology\?host=\/tmp$/m,
);
assert.equal(
  (
    await sh(
      'stat -f %Sg /usr/local/etc/circagraph/syslog.env /usr/local/etc/circagraph/github.env',
    )
  ).trim(),
  'openchronology-logs\nopenchronology-logs',
);
assert.match(await sh('pw usershow circagraph 2>&1; true'), /no such user/);
// The rc.conf settings, under the new names, and the user the services run as.
assert.equal(
  (
    await sh(
      'sysrc -n circagraph_enable circagraph_mail_enable circagraph_account; sysrc -n -q openchronology_enable openchronology_mail_enable; true',
    )
  ).trim(),
  'YES\nYES\nopenchronology',
);
// circagraph-setup (the download page runs it after pkg) takes the upgrade path, and creates
// no database.
const resetup = await sh('circagraph-setup 2>&1');
assert.match(resetup, /is installed over an earlier version/, resetup);
assert.equal(
  await psql("SELECT count(*) FROM pg_database WHERE datname='circagraph'", 'postgres'),
  '0',
);
await sh('sysrc circagraph_mail_enable=NO');
// The commands, under both names, as the installation's user.
const movedMigrate = await sh('openchronology-migrate 2>&1');
assert.match(movedMigrate, /Circagraph restarted\./, movedMigrate);
assert.match(await sh('service circagraph status'), /is running/);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
// The server runs as the installation's user (Next.js names its process next-server).
assert.match(await sh('ps -U openchronology -o command='), /next-server|circagraph-server\.mjs/);
assert.equal(
  await psql("SELECT count(*) FROM oc_users WHERE username='kept'", 'openchronology'),
  '1',
);
assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
// Removing it names the installation's users and database.
const movedRemove = await sh('env ASSUME_ALWAYS_YES=yes pkg delete -y circagraph-server 2>&1');
assert.match(movedRemove, /the openchronology and openchronology-logs\s+system users remain/);
assert.match(movedRemove, /dropdb openchronology/);
await assert.rejects(fetch('http://127.0.0.1:5173/healthz'));
console.log(
  `PASS FreeBSD server package: install, PostgreSQL initialized, database with pgmp, rc.d service, upgrade, removal, and in place of openchronology-server ${PREVIOUS}.\n\nInstall output:\n${install.slice(-1500)}\n\nUpgrade output:\n${upgrade.slice(-1500)}\n\nIn place of openchronology-server:\n${replaced.slice(-2500)}`,
);
