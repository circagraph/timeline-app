// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Configuration files (server/env-file.mjs) read as systemd reads them, without overriding what
// the environment already sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvFile,
  loadEnvFile,
  loadConfiguration,
  renamedSettings,
} from '../server/env-file.mjs';

test('configuration files read as systemd reads them: a # inside a value is part of it', () => {
  const settings = parseEnvFile(
    [
      '# A comment',
      '; another',
      '   # an indented comment',
      'ADMIN_INITIAL_PASSWORD=abc!def#ghi@jkl',
      'SPACED = value with spaces  ',
      'HASH_AFTER_SPACE=abc #def',
      'EMPTY=',
      'DOUBLE="quoted # value with \\"escapes\\" and \\\\"',
      "SINGLE='kept \\n as written'",
      'export EXPORTED=yes',
      'CONTINUED=first \\',
      'second',
      'URL=postgresql:///openchronology?host=/var/run/postgresql&port=5433',
      'not a setting',
      '1BAD=no',
      'EQUALS=a=b=c',
    ].join('\r\n'),
  );
  assert.deepEqual(settings, {
    ADMIN_INITIAL_PASSWORD: 'abc!def#ghi@jkl',
    SPACED: 'value with spaces',
    HASH_AFTER_SPACE: 'abc #def',
    EMPTY: '',
    DOUBLE: 'quoted # value with "escapes" and \\',
    SINGLE: 'kept \\n as written',
    EXPORTED: 'yes',
    CONTINUED: 'first second',
    URL: 'postgresql:///openchronology?host=/var/run/postgresql&port=5433',
    EQUALS: 'a=b=c',
  });
});

test('loading a configuration keeps what the environment already sets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'och-env-'));
  try {
    const file = join(dir, 'openchronology.env');
    await writeFile(file, 'A=from file\nB=from file#too\n');
    const env = { A: 'already set' };
    assert.equal(loadEnvFile(file, env), true);
    assert.deepEqual(env, { A: 'already set', B: 'from file#too' });
    assert.equal(loadEnvFile(join(dir, 'missing.env'), {}), false);
    const named = { OCH_CONFIG: file };
    loadConfiguration(named);
    assert.equal(named.B, 'from file#too');
    assert.throws(
      () => loadConfiguration({ OCH_CONFIG: join(dir, 'missing.env') }),
      /does not exist/,
    );
    // Without OCH_CONFIG, nothing is read.
    const none = {};
    loadConfiguration(none);
    assert.deepEqual(none, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('settings under their Circagraph names are read as the old OCH_ names', async () => {
  const env = { CIRCAGRAPH_API_KEY: 'new', OCH_API_KEY: 'old', OCH_API_URL: 'kept' };
  renamedSettings(env);
  assert.equal(env.OCH_API_KEY, 'new', 'the new name wins');
  assert.equal(env.OCH_API_URL, 'kept', 'an old name alone keeps working');
  renamedSettings({ CIRCAGRAPH_: 'nothing' });
  const dir = await mkdtemp(join(tmpdir(), 'och-env-'));
  try {
    // CIRCAGRAPH_CONFIG names the file, and the file may use the new names too.
    const file = join(dir, 'circagraph.env');
    await writeFile(file, 'CIRCAGRAPH_API_URL=https://circagraph.com\nB=b\n');
    const named = { CIRCAGRAPH_CONFIG: file };
    loadConfiguration(named);
    assert.equal(named.OCH_CONFIG, file);
    assert.equal(named.OCH_API_URL, 'https://circagraph.com');
    assert.equal(named.B, 'b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
