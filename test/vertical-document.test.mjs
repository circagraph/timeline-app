// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// A track as a vertical document (src/vertical-document.ts): page breaks, duration lanes and
// bars across pages, relationships as connectors or margin notes, and row order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lanes,
  noteTops,
  paginate,
  relationshipPlan,
  rowOrder,
  segments,
} from '../dist/vertical-document.mjs';

const row = (key, fragments, notes = 0, kind = 'moment') => ({ key, kind, fragments, notes });

test('rows fill pages, keep a heading with its first block and continue long content', () => {
  const geometry = { height: 100, gap: 0 };
  // Three rows of 40 fill two pages; the third starts the second.
  let p = paginate([row('m:a', [40]), row('m:b', [40]), row('m:c', [40])], geometry);
  assert.deepEqual(p.rowPage, [0, 0, 1]);
  assert.deepEqual(p.rowTop, [0, 40, 0]);
  // A heading (10) whose first block (30) does not fit below 70 moves with it to the next page.
  p = paginate([row('m:a', [70]), row('m:b', [10, 30, 30])], geometry);
  assert.deepEqual(p.rowPage, [0, 1]);
  // Content longer than the rest of the page continues on the next one, block by block.
  p = paginate([row('m:a', [20]), row('m:b', [10, 30, 30, 30, 30])], geometry);
  assert.deepEqual(p.rowPage, [0, 0]);
  assert.deepEqual(
    p.pages.map((page) => page.placed.map((x) => `${x.row}.${x.fragment}@${x.top}`)),
    [
      ['0.0@0', '1.0@20', '1.1@30', '1.2@60'],
      ['1.3@0', '1.4@30'],
    ],
  );
  // A block taller than a page stays with its heading and is cut at the page's foot.
  p = paginate([row('m:a', [20]), row('m:b', [10, 150])], geometry);
  const cut = p.pages[1].placed[1];
  assert.deepEqual([cut.top, cut.height, cut.clipped], [10, 90, true]);
  assert.equal(p.pages.length, 2);
});

test('margin notes, at their most, never run past the page', () => {
  // Small rows whose notes need 40 each: two fit beside the page's 100, the third moves on.
  const p = paginate([row('m:a', [10], 40), row('m:b', [10], 40), row('m:c', [10], 40)], {
    height: 100,
    gap: 5,
  });
  assert.deepEqual(p.rowPage, [0, 0, 1]);
  // Notes are pushed down below the one before, never overlapping it.
  assert.deepEqual(
    noteTops(
      [
        { top: 0, height: 40 },
        { top: 15, height: 40 },
        { top: 90, height: 5 },
      ],
      5,
    ),
    [0, 45, 90],
  );
});

test('durations take the lowest free lane and run across pages', () => {
  const spans = [
    { start: 0, end: 3 },
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 4, end: 5 },
    { start: 1, end: 5 },
  ];
  // The third starts where the first ends, so it takes the second's lane, free since row 2;
  // the fourth reuses the first's; the fifth finds no lane free of the two allowed.
  assert.deepEqual(lanes(spans, 2), [0, 1, 1, 0, null]);
  assert.deepEqual(lanes(spans, 3), [0, 1, 1, 0, 2]);
  const p = paginate(
    [0, 1, 2, 3, 4, 5].map((i) => row(`m:${i}`, [40])),
    { height: 100, gap: 0 },
  );
  // Rows 0-1 on page 0, 2-3 on page 1, 4-5 on page 2.
  const bars = segments([{ start: 1, end: 4 }], [0], p, 100, 8);
  assert.deepEqual(
    bars.map((s) => [s.page, s.top, s.bottom, s.begins, s.ends]),
    [
      [0, 48, 100, true, false],
      [1, 0, 100, false, false],
      [2, 0, 8, false, true],
    ],
  );
});

test('relationships on one page are connectors; others are notes naming the page', () => {
  const rows = ['m:a', 'm:b', 'm:c', 'm:d'].map((key) => row(key, [40]));
  const p = paginate(rows, { height: 100, gap: 0 });
  const rowOf = new Map(rows.map((r, i) => [r.key, i]));
  const links = [
    { a: 'm:a', b: 'm:b' }, // same page
    { a: 'm:a', b: 'm:c' }, // across pages
    { a: 'm:d', b: 'm:x' }, // the other end outside the document
    { a: 'm:a', b: 'm:b' }, // same page again: a second lane
    { a: 'm:a', b: 'm:b' }, // no lane left: notes on the same page
  ];
  const { connectors, notes } = relationshipPlan(links, rowOf, p, 2, 8);
  assert.deepEqual(
    connectors.map((c) => [c.link, c.page, c.lane, c.top, c.bottom]),
    [
      [0, 0, 0, 8, 48],
      [3, 0, 1, 8, 48],
    ],
  );
  assert.deepEqual(notes.get(0), [
    { link: 1, other: 'm:c', page: 1 },
    { link: 4, other: 'm:b', page: 0 },
  ]);
  assert.deepEqual(notes.get(2), [{ link: 1, other: 'm:a', page: 0 }]);
  assert.deepEqual(notes.get(3), [{ link: 2, other: 'm:x', page: null }]);
});

test('rows are in time order: starts, then moments, then ends at one time', () => {
  const rows = [
    { key: 'd:x', kind: 'end', t: 5 },
    { key: 'm:b', kind: 'moment', t: 5 },
    { key: 'd:y', kind: 'start', t: 5 },
    { key: 'm:a', kind: 'moment', t: 5 },
    { key: 'm:z', kind: 'moment', t: 1 },
  ];
  assert.deepEqual(
    rowOrder(
      rows,
      (r) => String(r.t),
      (a, b) => Number(a) - Number(b),
    ).map((r) => r.key),
    ['m:z', 'd:y', 'm:a', 'm:b', 'd:x'],
  );
});
