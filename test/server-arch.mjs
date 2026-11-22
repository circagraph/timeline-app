// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Builds the AUR server package (scripts/aur-packages.mjs) with makepkg in a fresh Arch Linux
// container, installs it, and checks circagraph-setup (PostgreSQL initialized for it), the
// running server on Arch's Node.js and PostgreSQL, an upgrade and removal (#331). Then, in a
// second container, the package in place of openchronology-server, its name until 0.30:
// v0.30.2's AUR package, built from that release's platform archive and set up, moves to it, and
// the transitional openchronology-server installs beside it.
// Usage: node test/server-arch.mjs <folder with the rendered circagraph-server PKGBUILD>
//   (run in a checkout with the v0.30.2 tag)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { renderAur } from '../scripts/aur-packages.mjs';
import { checkSystemdServices } from './server-syslog.mjs';
import { checkServicesUpgrade } from './server-upgrade-services.mjs';

const run = promisify(execFile);
const folder = resolve(process.argv[2] ?? '');
if (!existsSync(join(folder, 'PKGBUILD')))
  throw new Error('Pass the folder scripts/aur-packages.mjs rendered circagraph-server in.');
const name = 'och-server-arch-' + process.pid;
const PREVIOUS = 'v0.30.2';
const work = await mkdtemp(join(tmpdir(), 'och-server-arch-'));
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

/** A fresh Arch container that builds packages as `builder`. */
const startArch = async () => {
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    'archlinux:latest',
    'sleep',
    'infinity',
  ]);
  // pacman gives up on a stalled mirror (#367); its download sandbox needs kernel features a
  // container may lack.
  await sh(
    "sed -i -e 's/^#\\?ParallelDownloads.*/ParallelDownloads = 4/' -e '/^\\[options\\]/a DisableSandbox' /etc/pacman.conf",
  );
  // makepkg's own needs, then the package's dependencies, so it builds without root.
  await sh(
    'pacman -Syu --noconfirm --needed base-devel git curl cargo cmake pkgconf python nodejs postgresql gmp sqlite >/dev/null',
  );
  await sh('useradd -m builder');
};
/** Copies a rendered package's folder in and builds it; returns the package's file. */
const makepkg = async (dir, as, flags = '') => {
  await run('docker', ['cp', dir, `${name}:/home/builder/${as}`]);
  await sh(`chown -R builder:builder /home/builder/${as}`);
  await sh(`cd /home/builder/${as} && runuser -u builder -- makepkg --noconfirm ${flags} 2>&1`);
  const file = (await sh(`cd /home/builder/${as} && ls *.pkg.tar.zst`)).trim();
  return `/home/builder/${as}/${file}`;
};

// The package file the first container built, for the second.
let built = '';
await startArch();
try {
  await run('docker', ['cp', folder, `${name}:/home/builder/circagraph-server`]);
  await sh('chown -R builder:builder /home/builder/circagraph-server');
  const build = (script) =>
    sh(`cd /home/builder/circagraph-server && runuser -u builder -- ${script}`);
  // The PKGBUILD is what the AUR reads: its .SRCINFO, and a build that checks every source.
  assert.match(await build('makepkg --printsrcinfo'), /pkgbase = circagraph-server/);
  await build('makepkg --noconfirm 2>&1');
  const pkg = (await build('ls circagraph-server-*.pkg.tar.zst')).trim();
  // Kept for the second container.
  await run('docker', ['cp', `${name}:/home/builder/circagraph-server/${pkg}`, work]);
  built = pkg;

  // Installing creates the system user and says what to run, and sets nothing else up.
  const install = await sh(`pacman -U --noconfirm /home/builder/circagraph-server/${pkg} 2>&1`);
  assert.match(install, /sudo circagraph-setup/, install.slice(-3000));
  assert.match(await sh('getent passwd circagraph'), /^circagraph:/);
  assert.match(await sh('test -e /etc/circagraph/circagraph.env && echo set || echo not'), /not/);

  // A server without systemd, like a container: setup initializes and starts PostgreSQL itself.
  const setup = await sh('circagraph-setup 2>&1');
  assert.match(setup, /Circagraph is installed and ready/, setup.slice(-3000));
  assert.match(setup, /Circagraph schema installed\./);

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
  assert.match(await sh('cat /var/lib/postgres/data/pg_hba.conf'), /^local\s+all\s+all\s+peer/m);

  // The server runs as its service would (no systemd here) on this system's Node.js.
  assert.equal((await sh('readlink /usr/lib/circagraph/node/bin/node')).trim(), '/usr/bin/node');
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
  assert.match(await sh('curl -s http://127.0.0.1:5173/'), /<html/i);
  assert.doesNotMatch(await sh('ldd /usr/lib/circagraph/bin/cg-convert'), /not found/);
  // och-convert, its name before the rename.
  assert.equal((await sh('readlink /usr/lib/circagraph/bin/och-convert')).trim(), 'cg-convert');
  assert.match(await sh('cg-import-logs --help'), /^Usage: cg-import-logs/);
  assert.match(await sh('cg-import-github --help'), /^Usage: cg-import-github/);
  // The commands' names before the rename.
  assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
  assert.equal(
    (await sh('readlink /usr/bin/openchronology-setup /usr/bin/openchronology-migrate')).trim(),
    'circagraph-setup\ncircagraph-migrate',
  );
  assert.match(await sh('ls -d /etc/openchronology 2>&1; true'), /No such file/);
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
  assert.match(
    await sh('cd /usr/lib/circagraph && node/bin/node server/journald-receiver.mjs 2>&1; true'),
    /Set JOURNALD_TIMELINE/,
  );
  // The services are valid systemd units, and the syslog receiver delivers a message into a
  // timeline as its unit runs it (#125).
  await checkSystemdServices({ sh, psql, name: 'arch', installSystemd: 'true' });
  await sh('kill "$(cat /tmp/server.pid)" || true');

  // The administrator (#118), from the configuration, and set again on request.
  await sh(
    "sed -i -e 's/^ADMIN_USERNAME=.*/ADMIN_USERNAME=admin/' -e 's/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=Abc!def#ghi@jkl-mno/' /etc/circagraph/circagraph.env",
  );
  await sh('circagraph-migrate --no-restart');
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='admin'"), '1');
  assert.match(
    await sh('circagraph-reset-admin-password 2>&1'),
    /The password of admin \(administrator\) is now ADMIN_INITIAL_PASSWORD/,
  );

  // Reinstalling takes the upgrade path: configuration and database are kept, and the
  // administrator is told what to review and to run circagraph-migrate.
  await psql(
    "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
  );
  const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(config)[0];
  const { upgrade, migrate } = await checkServicesUpgrade({
    sh,
    upgrade: () => sh(`pacman -U --noconfirm /home/builder/circagraph-server/${pkg} 2>&1`),
  });
  assert.match(upgrade, /is installed over an earlier version/, upgrade);
  assert.match(upgrade, /sudo circagraph-migrate/);
  assert.match(
    await sh('cat /etc/circagraph/circagraph.env'),
    new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'),
  );
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
  assert.match(migrate, /Circagraph schema installed\./);
  assert.match(await sh('circagraph-setup 2>&1'), /Circagraph is installed and ready/);

  // Removing it keeps the configuration and the database, and says how to delete them.
  const remove = await sh('pacman -R --noconfirm circagraph-server 2>&1');
  assert.match(
    remove,
    /the PostgreSQL database and the circagraph and circagraph-logs system\s+users remain/i,
  );
  assert.match(await sh('test -e /etc/circagraph && echo present || echo gone'), /present/);
  assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='kept'"), '1');
  console.log(
    'PASS server package on Arch Linux: built with makepkg, installed, set up with PostgreSQL initialized, database with pgmp, server on Arch’s Node.js, upgrade, removal.',
  );
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}

// In place of openchronology-server: v0.30.2's AUR package, rendered by that release's
// scripts/aur-packages.mjs from its deploy files and platform archive, built and set up.
const old = join(work, 'previous');
const previousPlatform = `https://github.com/circagraph/timeline-app/releases/download/${PREVIOUS}/openchronology-server-platform.tar.gz`;
await run('sh', [
  '-c',
  `mkdir -p "$1" && git archive ${PREVIOUS} deploy/arch deploy/debian-server deploy/windows-server/pgmp.sha256 scripts/aur-packages.mjs scripts/server-targets.mjs | tar -x -C "$1"`,
  'sh',
  old,
]);
const download = await fetch(previousPlatform);
assert.ok(download.ok, `${previousPlatform}: ${download.status}`);
await writeFile(join(old, 'platform.tar.gz'), Buffer.from(await download.arrayBuffer()));
await run(
  process.execPath,
  [
    'scripts/aur-packages.mjs',
    '--out',
    'aur',
    '--version',
    PREVIOUS.slice(1),
    '--platform',
    'platform.tar.gz',
    '--platform-url',
    previousPlatform,
  ],
  { cwd: old },
);
// The transitional package as a release renders it (its version at least 0.31).
await renderAur({ out: work, version: '0.31.0', transitional: true });

await startArch();
try {
  const oldPkg = await makepkg(join(old, 'aur', 'openchronology-server'), 'openchronology-server');
  const transitional = await makepkg(
    join(work, 'openchronology-server'),
    'transitional',
    '--nodeps',
  );
  await run('docker', ['cp', join(work, built), `${name}:/tmp/circagraph-server.pkg.tar.zst`]);
  await sh(`pacman -U --noconfirm ${oldPkg} >/dev/null 2>&1`);
  const setup = await sh('openchronology-setup 2>&1');
  assert.match(setup, /OpenChronology is installed and ready/, setup.slice(-3000));
  await psql(
    "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
    'openchronology',
  );
  const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(
    await sh('cat /etc/openchronology/openchronology.env'),
  )[0];
  // The mail worker was enabled; without systemd running, removing the old package leaves it so.
  await sh('systemctl enable openchronology-mail.service 2>&1');
  assert.match(
    await sh('ls /etc/systemd/system/multi-user.target.wants/'),
    /^openchronology-mail\.service$/m,
  );

  // As an AUR helper installs it: pacman asks to remove the conflicting openchronology-server.
  const replaced = await sh('yes | pacman -U /tmp/circagraph-server.pkg.tar.zst 2>&1');
  assert.match(replaced, /Remove openchronology-server\?/, replaced.slice(-3000));
  assert.match(replaced, /is installed over openchronology-server/, replaced.slice(-3000));
  assert.match(replaced, /OpenChronology is now Circagraph/);
  assert.match(replaced, /Enabled again, as before: circagraph-mail\./);
  assert.match(replaced, /sudo -u postgres pg_dump openchronology > openchronology\.sql/);
  assert.doesNotMatch(replaced, /Circagraph is installed and/);
  // Gone, its name provided by circagraph-server.
  assert.equal((await sh('pacman -Qq | grep -x openchronology-server; true')).trim(), '');
  // The configuration, moved, with links under its old names; the users and database kept.
  assert.equal(
    (await sh('readlink /etc/openchronology; readlink /etc/circagraph/openchronology.env')).trim(),
    'circagraph\ncircagraph.env',
  );
  const config = await sh(
    'stat -c "%a %U %G" /etc/circagraph/circagraph.env /etc/circagraph/syslog.env && cat /etc/circagraph/circagraph.env',
  );
  assert.match(config, /^640 root openchronology\n640 root openchronology-logs$/m);
  assert.match(config, new RegExp('^' + key + '$', 'm'));
  assert.match(config, /^DATABASE_URL=postgresql:\/\/\/openchronology\?/m);
  assert.match(
    await sh('cat /etc/systemd/system/circagraph.service.d/50-users.conf'),
    /^User=openchronology\nGroup=openchronology$/m,
  );
  assert.match(
    await sh('cat /etc/systemd/system/circagraph-github.service.d/50-users.conf'),
    /^User=openchronology-logs\n[^]*^StateDirectory=openchronology-github$/m,
  );
  // Enabled again under its new name.
  const wants = await sh('ls /etc/systemd/system/multi-user.target.wants/');
  assert.match(wants, /^circagraph-mail\.service$/m);
  assert.doesNotMatch(wants, /^openchronology/m);
  // The commands, under both names, as the installation's user.
  const migrated = await sh('openchronology-migrate --no-restart 2>&1');
  assert.match(migrated, /Circagraph schema (installed|is current)|migrat/i, migrated);
  assert.equal(
    await psql("SELECT count(*) FROM oc_users WHERE username='kept'", 'openchronology'),
    '1',
  );
  assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
  // Set up again by hand, it keeps to the installation's users and database.
  assert.match(await sh('circagraph-setup 2>&1'), /Circagraph is installed and ready/);
  assert.equal(
    await psql(
      "SELECT datname FROM pg_database WHERE datname IN ('circagraph', 'openchronology')",
      'postgres',
    ),
    'openchronology',
  );

  // The transitional openchronology-server installs beside it, and both upgrade after.
  const beside = await sh(`pacman -U --noconfirm ${transitional} 2>&1`);
  assert.doesNotMatch(beside, /are in conflict|error/i, beside);
  assert.match(
    await sh('pacman -Q openchronology-server circagraph-server'),
    /^openchronology-server 0\.31\.0-1$/m,
  );
  const again = await sh('pacman -U --noconfirm /tmp/circagraph-server.pkg.tar.zst 2>&1');
  assert.match(again, /is installed over an earlier version/, again.slice(-3000));
  assert.doesNotMatch(again, /OpenChronology is now Circagraph/);
  console.log(
    `PASS server package on Arch Linux in place of openchronology-server ${PREVIOUS}: configuration moved, users and database kept, services enabled again, transitional package beside it.`,
  );
} finally {
  await run('docker', ['rm', '-f', name]).catch(() => {});
  await rm(work, { recursive: true, force: true });
}
