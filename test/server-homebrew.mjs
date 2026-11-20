// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Checks the Homebrew formula (deploy/homebrew) once installed on a Mac (#116): setup with
// PostgreSQL 17 and the service, the server answering, the administrator's password (#118),
// setup again, and removal. CI installs the formula from a local tap first. Then, from a clean
// slate, the formula as 0.30.2 published it, openchronology-server, is installed and set up and
// upgraded to this circagraph-server through the tap's formula_renames.json: its configuration
// moves, its database stays, and circagraph-migrate moves its service and launchd agent.
// Usage, on macOS with circagraph-server installed from the local tap circagraph/local, from
// a checkout with tags and server-artifacts/circagraph-server-platform.tar.gz:
//   node test/server-homebrew.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkSyslogService, fetchApi } from './server-syslog.mjs';

const run = promisify(execFile);
const sh = async (script, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await run('sh', ['-c', script], { maxBuffer: 64 * 1024 * 1024 });
    return stdout + stderr;
  } catch (error) {
    if (allowFailure) return (error.stdout ?? '') + (error.stderr ?? '');
    throw new Error(`${script}\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
};
const prefix = (await sh('brew --prefix')).trim();
const pgBin = (await sh('brew --prefix postgresql@17')).trim() + '/bin';
const configFile = `${prefix}/etc/circagraph/circagraph.env`;
const psql = (sql, db = 'circagraph') =>
  sh(`"${pgBin}/psql" -X -Atq -h /tmp -d ${db} -c "${sql}"`).then((s) => s.trim());
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
      (await sh(`tail -50 "${prefix}/var/log/circagraph.log"`, { allowFailure: true })),
  );
};

// Setup: PostgreSQL started, the database with pgmp, the configuration and the service.
const setup = await sh('circagraph-setup 2>&1');
assert.match(setup, /Circagraph is installed and running/, setup);
assert.match(setup, /Circagraph schema installed\./);
assert.equal(await psql("SELECT extname FROM pg_extension WHERE extname='pgmp'"), 'pgmp');
assert.equal(await psql("SELECT '1/3'::mpq + '1/6'::mpq"), '1/2');
assert.equal(await psql("SELECT to_regclass('oc_timelines') IS NOT NULL"), 't');
const config = await sh(`stat -f '%Lp' "${configFile}" && cat "${configFile}"`);
assert.match(config, /^600$/m);
assert.match(config, /^AUTH_ENCRYPTION_KEY=[a-f0-9]{64}$/m);
// The server connects as the database's owner, a role that is not a superuser.
assert.match(config, /^DATABASE_URL=postgresql:\/\/circagraph@\/circagraph\?host=\/tmp$/m);
assert.equal(await psql("SELECT rolsuper FROM pg_roles WHERE rolname='circagraph'"), 'f');
assert.equal(
  await psql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='circagraph'"),
  'circagraph',
);
// brew colors its status even when piped; the words are what matter.
const services = (await sh('brew services list')).replace(/\x1B\[[0-9;]*m/g, '');
assert.match(services, /^circagraph-server\s+started/m, services);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
const session = await (await fetch('http://127.0.0.1:5173/api/session')).json();
assert.equal(session.server, true, 'The server reaches its database.');
assert.equal((await fetch('http://127.0.0.1:5173/api/plugins')).status, 200);
assert.match(await (await fetch('http://127.0.0.1:5173/')).text(), /<html/i);
assert.match(await sh('cg-import-logs --help'), /^Usage: cg-import-logs/);
assert.match(await sh('cg-import-github --help'), /^Usage: cg-import-github/);
// The commands' names before the rename still work.
assert.match(await sh('och-import-logs --help'), /^Usage: cg-import-logs/);
assert.match(
  await sh('openchronology-agent start nothing 2>&1', { allowFailure: true }),
  /Usage: circagraph-agent/,
);
// The GitHub receiver's command and configuration are installed; it is not started.
assert.match(
  await sh(
    `test -x "${prefix}/bin/circagraph-github" && test -f "${prefix}/etc/circagraph/github.env" && echo installed`,
  ),
  /installed/,
);

// The syslog receiver as a launchd agent (circagraph-agent, #125) delivers a message into
// a timeline, keeps running once macOS registers it as a background item, and stops for good
// when stopped.
const agents = `${process.env.HOME}/Library/LaunchAgents`;
const agentPlist = `${agents}/org.circagraph.syslog.plist`;
const agentLog = `${prefix}/var/log/circagraph-syslog.log`;
// The agent's status, failing with launchd's account of it (and its log) unless it is running.
const assertRunning = async (when) => {
  const status = await sh('circagraph-agent status syslog', { allowFailure: true });
  if (/^state = running$/m.test(status)) return;
  assert.fail(
    `${when}: ${status}` +
      (await sh(
        `launchctl print-disabled "gui/$(id -u)" | grep -i circagraph; tail -20 "${agentLog}"; ` +
          `log show --last 2m --style compact --info --debug --predicate 'eventMessage CONTAINS "org.circagraph" OR eventMessage CONTAINS "launchdDidScanPath" OR eventMessage CONTAINS "register-only"' | grep -v ' log\\[' | tail -60`,
        { allowFailure: true },
      )),
  );
};
await checkSyslogService({
  name: 'macOS',
  psql,
  api: fetchApi,
  configure: (key, routes) =>
    sh(
      `sed -i '' 's|^OCH_API_KEY=.*|OCH_API_KEY=${key}|' "${prefix}/etc/circagraph/syslog.env" && printf '%s' '${routes}' > "${prefix}/etc/circagraph/syslog-routes.json"`,
    ),
  start: async () => {
    assert.match(await sh('circagraph-agent start syslog'), /circagraph-syslog started/);
    assert.match(await sh(`plutil -lint "${agentPlist}"`), /OK/);
    assert.match(
      await sh('launchctl print-disabled "gui/$(id -u)"'),
      /"org\.circagraph\.syslog" => enabled/,
    );
    // macOS registers a new agent as a background item seconds after it starts; an agent not
    // enabled explicitly is removed then.
    await sh('sleep 15');
    await assertRunning('15 seconds after starting');
  },
  stop: async () => {
    await assertRunning('Before stopping');
    assert.match(await sh('circagraph-agent stop syslog'), /stopped/);
  },
  logs: () =>
    sh(`tail -40 "${agentLog}"; launchctl print "gui/$(id -u)/org.circagraph.syslog"`, {
      allowFailure: true,
    }),
});
assert.match(await sh(`test -e "${agentPlist}" && echo present || echo gone`), /gone/);
assert.match(
  await sh('circagraph-agent status syslog; echo "exit $?"', { allowFailure: true }),
  /is not started[\s\S]*exit 3/,
);
assert.match(await sh(`tail -5 "${agentLog}"`), /^syslog: stopped/m);
assert.match(
  await sh('circagraph-agent start nothing 2>&1; echo "exit $?"', { allowFailure: true }),
  /Usage: circagraph-agent[\s\S]*exit 2/,
);

// The administrator (#118): its password is read whole from the configuration, # and all,
// and circagraph-reset-admin-password sets it again.
const adminPassword = 'Abc!def#ghi@jkl-mno';
await sh(
  `sed -i '' -e 's/^ADMIN_USERNAME=.*/ADMIN_USERNAME=admin/' -e 's/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=${adminPassword}/' "${configFile}"`,
);
const migrated = await sh('circagraph-migrate 2>&1');
assert.match(migrated, /Circagraph schema installed\./);
assert.match(migrated, /Circagraph restarted\./);
// The mail worker and the syslog and GitHub receivers are not enabled, so they stay stopped
// (#371, #374).
assert.doesNotMatch(migrated, /mail worker restarted/);
assert.doesNotMatch(migrated, /syslog receiver restarted/);
assert.doesNotMatch(migrated, /GitHub receiver restarted/);
const { passwordMatches } = await import(`${prefix}/opt/circagraph-server/libexec/server/auth.mjs`);
const adminMatches = async () =>
  passwordMatches(
    adminPassword,
    await psql("SELECT password_hash FROM oc_users WHERE username='admin'"),
  );
assert.equal(await adminMatches(), true, 'the administrator has the whole password');
await psql("UPDATE oc_users SET password_hash=NULL WHERE username='admin'");
const reset = await sh('circagraph-reset-admin-password 2>&1');
assert.match(reset, /The password of admin \(administrator\) is now ADMIN_INITIAL_PASSWORD/, reset);
assert.equal(await adminMatches(), true);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });

// Setup again keeps the configuration and database, and says how to migrate.
const key = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(config)[0];
const again = await sh('circagraph-setup 2>&1');
assert.match(again, /set up already/, again);
assert.match(again, /circagraph-migrate/);
assert.doesNotMatch(again, /OpenChronology is now Circagraph/);
assert.match(await sh(`cat "${configFile}"`), new RegExp('^' + key + '$', 'm'));

// Removing it keeps the configuration and the database. Homebrew would remove PostgreSQL 17
// with it too (as an unneeded dependency) unless asked to keep it, as README.Homebrew says.
await sh('brew install postgresql@17 2>&1');
await sh('brew services stop circagraph-server && brew uninstall circagraph-server');
assert.match(await sh(`test -e "${configFile}" && echo present || echo gone`), /present/);
assert.equal(await psql("SELECT count(*) FROM oc_users WHERE username='admin'"), '1');
await assert.rejects(fetch('http://127.0.0.1:5173/healthz'));

// From openchronology-server (the formula's name until 0.30): from a clean slate, 0.30.2's
// formula (from the tag) and platform archive (from the release) are installed and set up,
// with the syslog receiver's launchd agent started; then the tap renames it, as releases do
// (formula_renames.json, the old formula removed), and brew upgrade moves the installation.
await sh(`rm -rf "${prefix}/etc/circagraph" "${prefix}/var/circagraph"`);
await sh(`"${pgBin}/dropdb" -h /tmp circagraph && "${pgBin}/dropuser" -h /tmp circagraph`);
const tap = (await sh('brew --repository circagraph/local')).trim();
const formula = await readFile(`${tap}/Formula/circagraph-server.rb`, 'utf8');
await rm(`${tap}/Formula/circagraph-server.rb`);
const work = await mkdtemp(join(tmpdir(), 'homebrew-rename-'));
const release = 'https://github.com/circagraph/timeline-app/releases/download/v0.30.2';
await sh(
  `git show v0.30.2:deploy/homebrew/openchronology-server.rb.in > "${work}/old.rb.in" && ` +
    `curl -fsSL -o "${work}/old.tar.gz" ${release}/openchronology-server-platform.tar.gz && ` +
    `node scripts/homebrew-formula.mjs --template "${work}/old.rb.in" --tarball "${work}/old.tar.gz" ` +
    `--url ${release}/openchronology-server-platform.tar.gz --version 0.30.2 ` +
    `--out "${tap}/Formula/openchronology-server.rb"`,
);
await sh('brew install --build-from-source circagraph/local/openchronology-server 2>&1');
const oldSetup = await sh('openchronology-setup 2>&1');
assert.match(oldSetup, /OpenChronology is installed and running/, oldSetup);
const oldConfig = await sh(`cat "${prefix}/etc/openchronology/openchronology.env"`);
const oldKey = /^AUTH_ENCRYPTION_KEY=.*$/m.exec(oldConfig)[0];
assert.match(await sh('openchronology-agent start syslog'), /org\.openchronology\.syslog/);
await sh(`test -e "${agents}/org.openchronology.syslog.plist"`);

await writeFile(
  `${tap}/formula_renames.json`,
  JSON.stringify({ 'openchronology-server': 'circagraph-server' }) + '\n',
);
await rm(`${tap}/Formula/openchronology-server.rb`);
// A version above 0.30.2, so that brew upgrade upgrades it.
await writeFile(
  `${tap}/Formula/circagraph-server.rb`,
  formula.replace(/^ {2}version ".*"$/m, '  version "0.31.0"'),
);
// Homebrew colours formula names in its output even when it is not a terminal.
const upgraded = (await sh('brew upgrade circagraph-server 2>&1')).replace(/\x1b\[[0-9;]*m/g, '');
assert.match(upgraded, /Migrating formula openchronology-server to circagraph-server/, upgraded);
assert.match(await sh('brew list --versions circagraph-server'), /0\.31\.0/);
// The configuration moved, with links from its old names, and still names the old database.
assert.match(
  await sh(
    `readlink "${prefix}/etc/openchronology"; readlink "${prefix}/etc/circagraph/openchronology.env"`,
  ),
  /^circagraph\ncircagraph\.env$/m,
);
const movedConfig = await sh(`cat "${configFile}"`);
assert.match(movedConfig, new RegExp('^' + oldKey + '$', 'm'));
assert.match(
  movedConfig,
  /^DATABASE_URL=postgresql:\/\/openchronology@\/openchronology\?host=\/tmp$/m,
);
// Setup leaves it alone and says what moved; migrate moves the service and the agent.
const renamedSetup = await sh('circagraph-setup 2>&1');
assert.match(renamedSetup, /set up already/, renamedSetup);
assert.match(renamedSetup, /OpenChronology is now Circagraph/);
assert.match(renamedSetup, /pg_dump -h \/tmp openchronology > openchronology\.sql/);
const renamedMigrate = await sh('openchronology-migrate 2>&1');
assert.match(
  renamedMigrate,
  /openchronology-server service is now circagraph-server/,
  renamedMigrate,
);
assert.match(renamedMigrate, /syslog receiver moved to org\.circagraph\.syslog/);
const launchd = (label) =>
  sh(`launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1 && echo loaded || echo unloaded`);
assert.match(await launchd('homebrew.mxcl.openchronology-server'), /^unloaded/);
assert.match(await launchd('org.openchronology.syslog'), /^unloaded/);
assert.match(await launchd('org.circagraph.syslog'), /^loaded/);
assert.match(
  await sh(
    `ls "${agents}/homebrew.mxcl.openchronology-server.plist" "${agents}/org.openchronology.syslog.plist" 2>&1`,
    { allowFailure: true },
  ),
  /No such file[\s\S]*No such file/,
);
const renamedServices = (await sh('brew services list')).replace(/\x1B\[[0-9;]*m/g, '');
assert.match(renamedServices, /^circagraph-server\s+started/m, renamedServices);
assert.deepEqual(await healthy(), { status: 'ok', storage: 'postgresql' });
const renamedSession = await (await fetch('http://127.0.0.1:5173/api/session')).json();
assert.equal(renamedSession.server, true, 'The server reaches the database it had.');
assert.equal(
  await psql("SELECT count(*) FROM pg_database WHERE datname='circagraph'", 'postgres'),
  '0',
);
// Once moved, migrate restarts what runs, under the new names.
const remigrated = await sh('circagraph-migrate 2>&1');
assert.match(remigrated, /Circagraph restarted\./);
assert.match(remigrated, /syslog receiver restarted\./);
assert.doesNotMatch(remigrated, /moved|is now/);
await sh('circagraph-agent stop syslog');
await sh('brew services stop circagraph-server && brew uninstall circagraph-server');
console.log(
  `PASS Homebrew formula: setup with PostgreSQL 17 and pgmp, the service, the administrator's password, setup again, removal, and the upgrade from openchronology-server 0.30.2.\n\n${setup.slice(-1200)}\n${renamedMigrate}`,
);
