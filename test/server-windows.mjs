// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Installs the Windows server (deploy/windows-server) unattended and checks it (#116): the
// services, PostgreSQL with pgmp, the configuration, the server answering, the
// administrator's password (#118), an upgrade (the installer again) and removal; then the
// installer over OpenChronology Server, its name until 0.30. Run on Windows as an
// administrator:
//   node test/server-windows.mjs server-artifacts\circagraph-server-windows-amd64-setup.exe
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkSyslogService, fetchApi } from './server-syslog.mjs';

const run = promisify(execFile);
const installer = resolve(process.argv[2] ?? '');
// The release the second part installs first: the last as OpenChronology Server.
const PREVIOUS = 'v0.30.2';
const dir = 'C:\\Program Files\\Circagraph Server';
const data = 'C:\\ProgramData\\Circagraph';
const configFile = `${data}\\circagraph.env`;
const ps = async (script, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await run(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout + stderr;
  } catch (error) {
    if (allowFailure) return (error.stdout ?? '') + (error.stderr ?? '');
    throw new Error(`${script}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
};
// The installer, unattended: its exit code is setup's outcome.
const install = async (file = installer, folder = data) => {
  const code = (
    await ps(`(Start-Process -Wait -PassThru -FilePath '${file}' -ArgumentList '/S').ExitCode`)
  ).trim();
  const log = await ps(`Get-Content -Raw '${folder}\\setup.log'`, { allowFailure: true });
  assert.equal(code, '0', `The installer exited with ${code}:\n${log.slice(-12000)}`);
  return log;
};
const status = async (name) =>
  (await ps(`(Get-Service ${name} -ErrorAction SilentlyContinue).Status`)).trim();
const psql = async (sql, db = 'circagraph', { program = dir, folder = data } = {}) => {
  const superuser = (await readFile(`${folder}\\postgres-superuser.txt`, 'utf8')).trim();
  const { stdout } = await run(
    `${program}\\pgsql\\bin\\psql.exe`,
    ['-X', '-Atq', '-h', '127.0.0.1', '-p', '5442', '-U', 'postgres', '-d', db, '-c', sql],
    { env: { ...process.env, PGPASSWORD: superuser } },
  );
  return stdout.trim();
};
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
  throw new Error(
    'The server did not answer:\n' +
      (await ps(`Get-Content -Tail 50 '${data}\\logs\\*.log'`, { allowFailure: true })),
  );
};

// Installed: PostgreSQL and the server as services, the database with pgmp, the configuration.
const setup = await install();
assert.match(setup, /Circagraph is installed and running/, setup.slice(-4000));
assert.match(setup, /Circagraph schema installed\./);
assert.equal(await status('CircagraphPostgreSQL'), 'Running');
assert.equal(await status('Circagraph'), 'Running');
assert.match(await ps('(Get-Service Circagraph).StartType'), /Automatic/);
assert.equal(await psql("SELECT extname FROM pg_extension WHERE extname='pgmp'"), 'pgmp');
assert.equal(await psql("SELECT '1/3'::mpq + '1/6'::mpq"), '1/2');
assert.equal(await psql("SELECT to_regclass('oc_timelines') IS NOT NULL"), 't');
const config = await readFile(configFile, 'utf8');
assert.match(config, /^AUTH_ENCRYPTION_KEY=[a-f0-9]{64}$/m);
assert.match(
  config,
  /^DATABASE_URL=postgresql:\/\/circagraph:[a-f0-9]{48}@127\.0\.0\.1:5442\/circagraph$/m,
);
// Only administrators, the system and the server's Local Service account read it.
const access = await ps(`icacls '${configFile}'`);
assert.match(access, /BUILTIN\\Administrators:\(F\)/);
assert.match(access, /NT AUTHORITY\\LOCAL SERVICE:\(R\)/);
assert.doesNotMatch(access, /BUILTIN\\Users|Everyone|Authenticated Users/);
// The server's process runs as Local Service.
assert.match(
  await ps('(Get-CimInstance Win32_Service -Filter "Name=\'Circagraph\'").StartName'),
  /LocalService/i,
);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
const session = await (await fetch('http://127.0.0.1:5173/api/session')).json();
assert.equal(session.server, true, 'The server reaches its database.');
assert.equal((await fetch('http://127.0.0.1:5173/api/plugins')).status, 200);
assert.match(await (await fetch('http://127.0.0.1:5173/')).text(), /<html/i);
assert.match(await ps(`& '${dir}\\cg-import-logs.cmd' --help`), /Usage: cg-import-logs/);
assert.match(await ps(`& '${dir}\\cg-import-github.cmd' --help`), /Usage: cg-import-github/);
// The commands' names until 0.30 run them too.
assert.match(await ps(`& '${dir}\\och-import-logs.cmd' --help`), /Usage: cg-import-logs/);
assert.match(await ps(`& '${dir}\\och-import-github.cmd' --help`), /Usage: cg-import-github/);

// The syslog and GitHub receivers and email delivery are services too (#125), installed to
// start by hand.
for (const name of ['CircagraphSyslog', 'CircagraphGitHub', 'CircagraphMail']) {
  assert.equal(await status(name), 'Stopped');
  assert.match(await ps(`(Get-Service ${name}).StartType`), /Manual/);
}
// Configured and started as README.Windows.txt says, the receiver delivers a message into a
// timeline as Local Service, which setup let read its configuration and routes.
const syslogConfig = `${data}\\syslog.env`;
await checkSyslogService({
  name: 'Windows',
  psql,
  api: fetchApi,
  configure: async (key, routes) => {
    const text = await readFile(syslogConfig, 'utf8');
    await writeFile(syslogConfig, text.replace(/^OCH_API_KEY=.*$/m, `OCH_API_KEY=${key}`));
    await writeFile(`${data}\\syslog-routes.json`, routes);
  },
  start: async () => {
    await ps('Set-Service CircagraphSyslog -StartupType Automatic; Start-Service CircagraphSyslog');
    assert.equal(await status('CircagraphSyslog'), 'Running');
    assert.match(
      await ps('(Get-CimInstance Win32_Service -Filter "Name=\'CircagraphSyslog\'").StartName'),
      /LocalService/i,
    );
  },
  stop: async () => {
    await ps('Stop-Service CircagraphSyslog');
    assert.equal(await status('CircagraphSyslog'), 'Stopped');
  },
  logs: () =>
    ps(`Get-Content -Tail 40 '${data}\\logs\\circagraph-syslog-service*.log'`, {
      allowFailure: true,
    }),
});

// The administrator (#118): its password is read whole from the configuration, # and all,
// and circagraph-reset-admin-password sets it again.
const adminPassword = 'Abc!def#ghi@jkl-mno';
await writeFile(
  configFile,
  config
    .replace(/^ADMIN_USERNAME=.*$/m, 'ADMIN_USERNAME=admin')
    .replace(/^ADMIN_INITIAL_PASSWORD=.*$/m, `ADMIN_INITIAL_PASSWORD=${adminPassword}`),
);
const migrated = await ps(`& '${dir}\\circagraph-migrate.cmd'`);
assert.match(migrated, /Circagraph schema installed\./);
assert.match(migrated, /Circagraph restarted\./);
// The mail worker is not enabled, so it stays stopped (#371); the syslog receiver, stopped but
// set to start with Windows above, runs again (#374).
assert.doesNotMatch(migrated, /mail worker restarted/);
assert.match(migrated, /Circagraph syslog receiver restarted\./);
assert.equal(await status('CircagraphSyslog'), 'Running');
assert.equal(await status('CircagraphMail'), 'Stopped');
// The GitHub receiver, not set to start with Windows, stays stopped too.
assert.doesNotMatch(migrated, /GitHub receiver restarted/);
assert.equal(await status('CircagraphGitHub'), 'Stopped');
const { passwordMatches } = await import(pathToFileURL(`${dir}\\app\\server\\auth.mjs`).href);
const adminMatches = async () =>
  passwordMatches(
    adminPassword,
    await psql("SELECT password_hash FROM oc_users WHERE username='admin'"),
  );
assert.equal(await adminMatches(), true, 'the administrator has the whole password');
await psql("UPDATE oc_users SET password_hash=NULL WHERE username='admin'");
const reset = await ps(`& '${dir}\\openchronology-reset-admin-password.cmd'`);
assert.match(reset, /The password of admin \(administrator\) is now ADMIN_INITIAL_PASSWORD/, reset);
assert.equal(await adminMatches(), true);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });

// An upgrade (the installer again) keeps the configuration and database and runs again.
const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(config)[0];
const upgrade = await install();
assert.match(upgrade, /Circagraph is upgraded/, upgrade.slice(-3000));
assert.match(await readFile(configFile, 'utf8'), new RegExp('^' + key + '$', 'm'));
assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='admin'"), '1');
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
// The receiver, set to start with Windows, runs again after the upgrade; email delivery, still
// started by hand, does not.
assert.equal(await status('CircagraphSyslog'), 'Running');
assert.equal(await status('CircagraphMail'), 'Stopped');
assert.equal(await status('CircagraphGitHub'), 'Stopped');

// Removing it removes the services and the program, and keeps the configuration and data.
await ps(`Start-Process -Wait -FilePath '${dir}\\uninstall.exe' -ArgumentList '/S', '_?=${dir}'`);
assert.equal(await status('Circagraph'), '');
assert.equal(await status('CircagraphPostgreSQL'), '');
assert.equal(await status('CircagraphSyslog'), '');
assert.equal(await status('CircagraphGitHub'), '');
assert.equal(await status('CircagraphMail'), '');
assert.match(await ps(`Test-Path '${configFile}'`), /True/);
assert.match(await ps(`Test-Path '${data}\\pgdata\\PG_VERSION'`), /True/);
assert.match(await ps(`Test-Path '${dir}\\app'`), /False/);
await assert.rejects(fetch('http://127.0.0.1:5173/healthz'));

// Installed over OpenChronology Server (PREVIOUS), the installer takes its place: the old
// services, program and uninstall entry go; the configuration and database move to
// %ProgramData%\Circagraph and keep the database's name; the receivers that started with
// Windows still do.
const oldDir = 'C:\\Program Files\\OpenChronology Server';
const oldData = 'C:\\ProgramData\\OpenChronology';
await rm(data, { recursive: true, force: true });
const oldInstaller = join(tmpdir(), 'openchronology-server-windows-amd64-setup.exe');
for (let attempt = 1; ; attempt++) {
  try {
    const response = await fetch(
      `https://github.com/circagraph/timeline-app/releases/download/${PREVIOUS}/openchronology-server-windows-amd64-setup.exe`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await writeFile(oldInstaller, Buffer.from(await response.arrayBuffer()));
    break;
  } catch (error) {
    if (attempt === 3) throw error;
    await new Promise((r) => setTimeout(r, 10000 * attempt));
  }
}
const old = await install(oldInstaller, oldData);
assert.match(old, /OpenChronology is installed and running/, old.slice(-4000));
assert.equal(await status('OpenChronology'), 'Running');
const oldPsql = (sql) => psql(sql, 'openchronology', { program: oldDir, folder: oldData });
await oldPsql(
  "INSERT INTO oc_users(id,username,email_verified_at,terms_version) VALUES(gen_random_uuid(),'kept',now(),oc_policy_version())",
);
const oldKey = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(
  await readFile(`${oldData}\\openchronology.env`, 'utf8'),
)[0];
// The syslog receiver, configured and set to start with Windows; email delivery is not.
const oldSyslog = await readFile(`${oldData}\\syslog.env`, 'utf8');
// OpenChronology Server wrote the path with a forward slash before the file's name.
assert.match(oldSyslog, /^SYSLOG_ROUTES=C:\\ProgramData\\OpenChronology[\\/]syslog-routes\.json$/m);
await writeFile(
  `${oldData}\\syslog.env`,
  oldSyslog.replace(/^OCH_API_KEY=.*$/m, `OCH_API_KEY=och_key_${'0'.repeat(32)}_${'0'.repeat(64)}`),
);
// A default timeline, without which the receiver stops as it starts.
await writeFile(
  `${oldData}\\syslog-routes.json`,
  '{"routes": [], "default": "00000000-0000-4000-8000-000000000000"}',
);
await ps('Set-Service OpenChronologySyslog -StartupType Automatic');
await ps('Start-Service OpenChronologySyslog', { allowFailure: true });
if ((await status('OpenChronologySyslog')) !== 'Running')
  console.log(
    'OpenChronologySyslog did not start:\n' +
      (await ps(`Get-Content -Tail 40 '${oldData}\\logs\\*syslog*.log'`, { allowFailure: true })),
  );

const replaced = await install();
assert.match(replaced, /OpenChronology Server is now Circagraph Server/, replaced.slice(-4000));
assert.match(replaced, /Circagraph is upgraded/);
assert.match(replaced, /CircagraphSyslog starts with Windows, as its OpenChronology service did/);
for (const name of [
  'OpenChronology',
  'OpenChronologyPostgreSQL',
  'OpenChronologySyslog',
  'OpenChronologyGitHub',
  'OpenChronologyMail',
])
  assert.equal(await status(name), '', `${name} is removed`);
assert.equal(await status('CircagraphPostgreSQL'), 'Running');
assert.equal(await status('Circagraph'), 'Running');
assert.match(await ps('(Get-Service CircagraphSyslog).StartType'), /Automatic/);
assert.match(await ps('(Get-Service CircagraphMail).StartType'), /Manual/);
assert.match(await ps('(Get-Service CircagraphGitHub).StartType'), /Manual/);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
// The configuration, moved and renamed, with a link under the old folder's name; the paths in
// it name the new folder; the database keeps its name.
const moved = await readFile(configFile, 'utf8');
assert.match(moved, new RegExp('^' + oldKey + '$', 'm'));
assert.match(
  moved,
  /^DATABASE_URL=postgresql:\/\/openchronology:[a-f0-9]{48}@127\.0\.0\.1:5442\/openchronology$/m,
);
assert.match(await ps(`Test-Path '${data}\\openchronology.env'`), /False/);
assert.match(await ps(`(Get-Item '${oldData}').LinkType`), /Junction/);
assert.match(
  await readFile(`${data}\\syslog.env`, 'utf8'),
  /^SYSLOG_ROUTES=C:\\ProgramData\\Circagraph[\\/]syslog-routes\.json$/m,
);
assert.equal(
  await psql("SELECT count(*) FROM oc_users WHERE username='kept'", 'openchronology'),
  '1',
);
// The old program and its entry in Settings > Apps are gone.
assert.match(await ps(`Test-Path '${oldDir}'`), /False/);
assert.match(
  await ps(
    "Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenChronologyServer'",
  ),
  /False/,
);
// The command by its old name migrates the database it names.
assert.match(
  await ps(`& '${dir}\\openchronology-migrate.cmd' --no-restart`),
  /Circagraph schema installed\./,
);
// Setup run again finds nothing left to move.
const again = await ps(
  `powershell -NoProfile -ExecutionPolicy Bypass -File '${dir}\\setup.ps1' -InstallDir '${dir}'`,
);
assert.doesNotMatch(again, /OpenChronology Server is now/);
assert.match(again, /Circagraph is upgraded/);

console.log(
  `PASS Windows server: install with PostgreSQL 17 and pgmp as services, configuration access, the server, the administrator's password, upgrade, removal, installing over OpenChronology Server ${PREVIOUS}.\n\n${setup.slice(-1500)}`,
);
