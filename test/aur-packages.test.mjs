// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Rendering the AUR packages (scripts/aur-packages.mjs, #331): circagraph-server names every
// file its PKGBUILD installs, with a checksum each, and takes the place of openchronology-server
// before 0.31, whose last, transitional version depends on it; circagraph-desktop-bin likewise
// takes the place of openchronology-desktop-bin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RENAMED_IN,
  SERVER_FILES,
  TRANSITIONAL,
  olderThan,
  renderAur,
} from '../scripts/aur-packages.mjs';

const withOut = async (run) => {
  const out = await mkdtemp(join(tmpdir(), 'och-aur-'));
  try {
    return await run(out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
};

test('circagraph-server names, checks and installs the files beside its PKGBUILD', async () => {
  for (const [from, names] of Object.entries(SERVER_FILES))
    for (const name of names) assert.ok(existsSync(join(from, name)), `${from}/${name}`);
  await withOut(async (out) => {
    const platform = join(out, 'platform.tar.gz');
    await writeFile(platform, 'platform fixture');
    const dirs = await renderAur({ out, version: '0.31.0', platform: { file: platform } });
    assert.deepEqual(dirs, [join(out, 'circagraph-server')]);
    const dir = dirs[0];
    const pkgbuild = await readFile(join(dir, 'PKGBUILD'), 'utf8');
    assert.match(pkgbuild, /^pkgname=circagraph-server$/m);
    assert.match(pkgbuild, /^pkgver=0\.31\.0$/m);
    assert.doesNotMatch(pkgbuild, /@[A-Z_0-9]+@/);
    const files = Object.values(SERVER_FILES).flat();
    // The archive, pgmp and each file: one checksum each, in the sources' order.
    const sums = /^sha256sums=\(([^)]*)\)/m.exec(pkgbuild)[1].match(/'[0-9a-f]{64}'/g);
    assert.equal(sums.length, files.length + 2);
    const source = /^source=\(([^)]*)\)/m.exec(pkgbuild)[1];
    for (const name of files) assert.match(source, new RegExp(`'${name.replace('.', '\\.')}'`));
    assert.match(source, /"circagraph-server-platform-\$pkgver\.tar\.gz"/);
    // What package() takes from $srcdir is a source, or made from one.
    const used = new Set([...pkgbuild.matchAll(/"\$srcdir\/([^"/$]+)"/g)].map(([, name]) => name));
    for (const name of used) assert.ok(files.includes(name), `${name} is not a source`);
    for (const name of files.filter((f) => !f.endsWith('.service')))
      assert.ok(used.has(name), `${name} is not installed`);
    assert.deepEqual(
      (await readdir(dir)).sort(),
      [
        ...files,
        'PKGBUILD',
        'circagraph-server.install',
        'circagraph-server-platform-0.31.0.tar.gz',
      ].sort(),
    );
    // In place of openchronology-server before the rename, with its commands' names.
    assert.match(
      pkgbuild,
      new RegExp(`^conflicts=\\('openchronology-server<${RENAMED_IN}'\\)$`, 'm'),
    );
    assert.match(
      pkgbuild,
      new RegExp(`^replaces=\\('openchronology-server<${RENAMED_IN}'\\)$`, 'm'),
    );
    assert.match(pkgbuild, /^provides=\("openchronology-server=\$pkgver"\)$/m);
    for (const [link, target] of [
      ['openchronology-setup', 'circagraph-setup'],
      ['openchronology-migrate', 'circagraph-migrate'],
      ['openchronology-reset-admin-password', 'circagraph-reset-admin-password'],
      ['och-import-logs', 'cg-import-logs'],
      ['och-import-github', 'cg-import-github'],
    ])
      assert.ok(pkgbuild.includes(`ln -s ${target} "$pkgdir/usr/bin/${link}"`), link);
  });
});

test('circagraph-desktop-bin takes the place of openchronology-desktop-bin before 0.31', async () => {
  await withOut(async (out) => {
    const deb = join(out, 'desktop.deb');
    await writeFile(deb, 'desktop fixture');
    const dirs = await renderAur({ out, version: '0.31.0', desktop: { file: deb } });
    assert.deepEqual(dirs, [join(out, 'circagraph-desktop-bin')]);
    assert.deepEqual((await readdir(dirs[0])).sort(), [
      'PKGBUILD',
      'circagraph-desktop-0.31.0.deb',
    ]);
    const pkgbuild = await readFile(join(dirs[0], 'PKGBUILD'), 'utf8');
    assert.match(pkgbuild, /^pkgname=circagraph-desktop-bin$/m);
    assert.doesNotMatch(pkgbuild, /@[A-Z_0-9]+@/);
    assert.match(pkgbuild, /^source=\("circagraph-desktop-\$pkgver\.deb"\)$/m);
    assert.match(
      pkgbuild,
      new RegExp(`^replaces=\\('openchronology-desktop-bin<${RENAMED_IN}'\\)$`, 'm'),
    );
    assert.match(pkgbuild, /^provides=\(.*"openchronology-desktop-bin=\$pkgver"\)$/m);
  });
});

test('the transitional packages depend on the packages renamed from them', async () => {
  await withOut(async (out) => {
    const dirs = await renderAur({ out, version: '0.31.0', transitional: true });
    assert.deepEqual(
      dirs,
      TRANSITIONAL.map((name) => join(out, name)),
    );
    for (const [dir, renamed] of [
      [dirs[0], 'circagraph-server'],
      [dirs[1], 'circagraph-desktop-bin'],
    ]) {
      assert.deepEqual(await readdir(dir), ['PKGBUILD']);
      const pkgbuild = await readFile(join(dir, 'PKGBUILD'), 'utf8');
      assert.match(pkgbuild, new RegExp(`^pkgname=${dir.split('/').pop()}$`, 'm'));
      assert.match(pkgbuild, /^pkgver=0\.31\.0$/m);
      assert.match(pkgbuild, new RegExp(`^depends=\\('${renamed}'\\)$`, 'm'));
      assert.doesNotMatch(pkgbuild, /^source=/m);
    }
    // A version the renamed packages conflict with would not install beside them.
    for (const version of ['0.30.2', '0.1.0.dev.202611191046.abcdef0'])
      await assert.rejects(renderAur({ out, version, transitional: true }), /would conflict/);
  });
});

test('versions compare as pacman compares them', () => {
  assert.ok(olderThan('0.30.2', '0.31'));
  assert.ok(olderThan('0.9', '0.31'));
  assert.ok(!olderThan('0.31', '0.31'));
  assert.ok(!olderThan('0.31.0', '0.31'));
  assert.ok(!olderThan('1.0.0', '0.31'));
  assert.ok(olderThan('0.31.0.rc.1', '0.31.0'));
});
