// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Renders the AUR packages (#331) from deploy/arch: circagraph-server, built from a platform
// archive, and circagraph-desktop-bin, unpacked from a desktop .deb. Each goes in its own
// folder of `--out` with the files its PKGBUILD names, ready for `makepkg --printsrcinfo` and
// a push to aur.archlinux.org. Releases render them for their assets; CI builds and installs
// the server's from local files. `--transitional` also renders openchronology-server and
// openchronology-desktop-bin, the packages' names until 0.30: empty packages that depend on
// circagraph-server and circagraph-desktop-bin, so that AUR helpers move their installations
// over.
// Usage: node scripts/aur-packages.mjs --out <dir> [--version <version>]
//          [--platform <tarball> [--platform-url <url>]] [--desktop <deb> [--desktop-url <url>]]
//          [--transitional]
// A file without its URL is copied beside the PKGBUILD and named as a local source. Without
// --version: the release tag's (RELEASE_TAG), or this checkout's development version.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { freebsdVersion, upstreamVersion } from './server-targets.mjs';

/** The files circagraph-server's PKGBUILD names beside it, by where they come from. */
export const SERVER_FILES = {
  'deploy/debian-server': [
    'circagraph.service',
    'circagraph-mail.service',
    'circagraph-syslog.service',
    'circagraph-github.service',
    'circagraph-journald.service',
    'circagraph.env',
    'syslog.env',
    'github.env',
    'journald.env',
    'circagraph-migrate',
    'circagraph-reset-admin-password',
    'cg-import-logs',
    'cg-import-github',
    'circagraph-log-files',
    'circagraph-units',
  ],
  'deploy/arch': ['circagraph-setup', 'circagraph-server.sysusers', 'README.Arch'],
};
/**
 * The first version named circagraph-server and circagraph-desktop-bin, which conflict with
 * the openchronology-server and openchronology-desktop-bin packages before it (their
 * PKGBUILD.in): the transitional packages must not be one of them.
 */
export const RENAMED_IN = '0.31';
/** The packages' names until 0.30, rendered by `transitional` from deploy/arch/<name>.PKGBUILD.in. */
export const TRANSITIONAL = ['openchronology-server', 'openchronology-desktop-bin'];
// The pinned pgmp source's checksum, which the Windows build checks the same download against:
// a release never takes it from whatever the download returns that day.
const PGMP_SHA256 = 'deploy/windows-server/pgmp.sha256';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** An AUR version: pacman compares dotted parts, so a suffix becomes more of them. */
export const aurVersion = (upstream) => freebsdVersion(upstream);
/**
 * Whether AUR version `a` sorts before `b` for pacman, by their dotted parts: numbers compare
 * as numbers, and a part that is not a number (a pre-release's) sorts before any number.
 */
export const olderThan = (a, b) => {
  const parts = (v) => v.split('.').map((part) => (/^[0-9]+$/.test(part) ? Number(part) : -1));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (p !== q) return p < q;
  }
  return false;
};

/**
 * Renders the packages into `out`. `platform` and `desktop` are { file, url? }; either may be
 * left out, and its package is not rendered. `transitional` renders the TRANSITIONAL packages
 * too.
 * @returns {Promise<string[]>} the folders written
 */
export async function renderAur({ out, version, platform, desktop, transitional = false }) {
  if (!/^[0-9][0-9A-Za-z.]*$/.test(version))
    throw new Error('An AUR version is dotted letters and digits.');
  if (transitional && olderThan(version, RENAMED_IN))
    throw new Error(
      `A transitional package at ${version} would conflict with the package renamed from it, which replaces the versions before ${RENAMED_IN}.`,
    );
  const written = [];
  if (platform) {
    const dir = join(out, 'circagraph-server');
    await mkdir(dir, { recursive: true });
    const local = Object.entries(SERVER_FILES).flatMap(([from, names]) =>
      names.map((name) => ({ from: join(from, name), name })),
    );
    const archive = `circagraph-server-platform-${version}.tar.gz`;
    if (!platform.url) await copyFile(platform.file, join(dir, archive));
    const pgmp = (await readFile(PGMP_SHA256, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(pgmp)) throw new Error(`${PGMP_SHA256} is not a SHA-256 checksum.`);
    const sums = [sha256(await readFile(platform.file)), pgmp];
    for (const { from, name } of local) {
      const bytes = await readFile(from);
      await writeFile(join(dir, name), bytes);
      sums.push(sha256(bytes));
    }
    await copyFile('deploy/arch/circagraph-server.install', join(dir, 'circagraph-server.install'));
    const pkgbuild = (await readFile('deploy/arch/circagraph-server.PKGBUILD.in', 'utf8'))
      .replace('@VERSION@', version)
      .replace(
        '"circagraph-server-platform-$pkgver.tar.gz::@PLATFORM_URL@"',
        platform.url
          ? `"circagraph-server-platform-$pkgver.tar.gz::${platform.url}"`
          : '"circagraph-server-platform-$pkgver.tar.gz"',
      )
      .replace('@LOCAL_SOURCES@', local.map(({ name }) => `        '${name}'`).join('\n'))
      .replace('@SHA256SUMS@', sums.map((sum) => `'${sum}'`).join('\n            '));
    await writeFile(join(dir, 'PKGBUILD'), pkgbuild);
    written.push(dir);
  }
  for (const name of transitional ? TRANSITIONAL : []) {
    const dir = join(out, name);
    await mkdir(dir, { recursive: true });
    const pkgbuild = (await readFile(`deploy/arch/${name}.PKGBUILD.in`, 'utf8')).replace(
      '@VERSION@',
      version,
    );
    await writeFile(join(dir, 'PKGBUILD'), pkgbuild);
    written.push(dir);
  }
  if (desktop) {
    const dir = join(out, 'circagraph-desktop-bin');
    await mkdir(dir, { recursive: true });
    const deb = `circagraph-desktop-${version}.deb`;
    if (!desktop.url) await copyFile(desktop.file, join(dir, deb));
    const pkgbuild = (await readFile('deploy/arch/circagraph-desktop-bin.PKGBUILD.in', 'utf8'))
      .replace('@VERSION@', version)
      .replace(
        '"circagraph-desktop-$pkgver.deb::@DESKTOP_URL@"',
        desktop.url
          ? `"circagraph-desktop-$pkgver.deb::${desktop.url}"`
          : '"circagraph-desktop-$pkgver.deb"',
      )
      .replace('@DESKTOP_SHA256@', sha256(await readFile(desktop.file)));
    await writeFile(join(dir, 'PKGBUILD'), pkgbuild);
    written.push(dir);
  }
  return written;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      version: { type: 'string' },
      platform: { type: 'string' },
      'platform-url': { type: 'string' },
      desktop: { type: 'string' },
      'desktop-url': { type: 'string' },
      transitional: { type: 'boolean', default: false },
    },
  });
  if (!values.out || (!values.platform && !values.desktop && !values.transitional))
    throw new Error('Supply --out and --platform, --desktop or --transitional.');
  let version = values.version;
  if (!version) {
    const exec = promisify(execFile);
    const git = async (...args) => (await exec('git', args)).stdout.trim();
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const stamp = await git('show', '-s', '--format=%cd', '--date=format:%Y%m%d%H%M', 'HEAD');
    version = aurVersion(
      process.env.RELEASE_TAG
        ? upstreamVersion(process.env.RELEASE_TAG)
        : `${pkg.version}~dev.${stamp}.${(await git('rev-parse', 'HEAD')).slice(0, 7)}`,
    );
  }
  const dirs = await renderAur({
    out: values.out,
    version,
    platform: values.platform && { file: values.platform, url: values['platform-url'] },
    desktop: values.desktop && { file: values.desktop, url: values['desktop-url'] },
    transitional: values.transitional,
  });
  for (const dir of dirs) console.log(dir);
}
