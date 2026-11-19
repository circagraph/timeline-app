// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// Printing a track as a vertical document (docs/printing.md): from the timeline's menu and from
// a separated track's, every moment and duration in order on Letter or A4 pages, durations as
// bars, relationships as connectors or margin notes naming the right page, never overlapping,
// with the plugins' headings, colors and notes; and a PDF of as many pages, where the browser
// makes one.
import assert from 'node:assert/strict';
import {
  validateDocument,
  MOMENT_COLORS,
  RICH_TEXT_NOTES,
  MOMENT_HEADINGS,
  RELATIONSHIP_ARROWS,
  TIMELINE_THEME,
} from '../dist/core.mjs';

const LOREM =
  'The archive records every change in exact rational time, and every reader may follow it. ';
function printDocumentFixture(separate, dark) {
  const events = Array.from({ length: 60 }, (_, i) => ({
    id: 'm' + i,
    time: `${i * 10}/1`,
    metadata: {
      title: i % 20 === 0 ? `Part ${i / 20 + 1}` : `Moment ${i}`,
      ...(i % 20 === 0 ? { headingLevel: 'h2' } : {}),
      ...(i % 3 === 0 ? { color: '#2471a3' } : {}),
      ...(i % 4 === 0 ? { description: `**Note ${i}.** ${LOREM.repeat(1 + (i % 6))}` } : {}),
      ...(i % 5 === 0 ? { tags: ['war'] } : {}),
      ...(i === 12 ? { arrows: [{ target: { moment: 'm41' }, arrow: 'to' }] } : {}),
    },
  }));
  const durations = Array.from({ length: 6 }, (_, i) => ({
    id: 'd' + i,
    start: `${i * 90}/1`,
    end: `${i * 90 + 80 + i * 20}/1`,
    metadata: { title: `Duration ${i}`, description: i % 2 ? LOREM : '' },
  }));
  const relationships = [
    { a: { moment: 'm1' }, b: { moment: 'm2' } },
    { a: { moment: 'm12' }, b: { moment: 'm41' } },
    { a: { moment: 'm3' }, b: { duration: 'd4' } },
    { a: { moment: 'm7' }, b: { moment: 'm5' } },
    { a: { moment: 'm33' }, b: { moment: 'm58' } },
  ];
  return validateDocument({
    format: 'openchronology',
    version: 1,
    title: 'Printed',
    description: '',
    plugins: [
      ...[MOMENT_COLORS, RICH_TEXT_NOTES, MOMENT_HEADINGS, RELATIONSHIP_ARROWS].map((manifest) => ({
        manifest,
        enabled: true,
      })),
      // A theme for a dark ground, which print leaves to the screen.
      ...(dark
        ? [
            {
              manifest: TIMELINE_THEME,
              enabled: true,
              settings: { backgroundColor: '#1b1b1f', textColor: '#f0f0f0', textSize: '120' },
            },
          ]
        : []),
    ],
    ...(separate ? { view: { separation: { tags: ['war'] } } } : {}),
    events,
    durations,
    relationships,
  });
}

/** Opens the print preview from the menu at a point and waits for its pages. */
async function printFrom(page, x, y, label) {
  await page.mouse.click(x, y, { button: 'right' });
  const item = page.locator('#timeline-menu button', { hasText: label });
  await item.waitFor();
  await item.click();
  await page.waitForFunction(
    () => /\d+ pages?$/.test(document.querySelector('#print-status')?.textContent ?? ''),
    null,
    { timeout: 30000 },
  );
}

/** What the preview's pages show, read back from them. */
function readPages(page) {
  return page.evaluate(() => {
    const pages = [...document.querySelectorAll('#print-pages .print-page')];
    return {
      size: pages.map((p) => [p.offsetWidth, p.offsetHeight]),
      // Each row's title and its page, in order.
      titles: pages.flatMap((p, i) =>
        [...p.querySelectorAll('.print-title, .print-heading')].map((t) => [t.textContent, i + 1]),
      ),
      notes: pages.flatMap((p, i) =>
        [...p.querySelectorAll('.print-note')].map((n) => [n.textContent, i + 1]),
      ),
      overlaps: pages.flatMap((p, i) => {
        const rects = [...p.querySelectorAll('.print-notes-row')].map((n) =>
          n.getBoundingClientRect(),
        );
        const page = p.getBoundingClientRect();
        const bad = [];
        rects.forEach((a, j) => {
          if (a.bottom > page.bottom - 40) bad.push(`page ${i + 1}: a note past the foot`);
          for (const b of rects.slice(j + 1))
            if (a.bottom > b.top + 0.5 && b.bottom > a.top + 0.5)
              bad.push(`page ${i + 1}: notes overlap`);
        });
        return bad;
      }),
      connectors: document.querySelectorAll('#print-pages .print-connector').length,
      bars: document.querySelectorAll('#print-pages .print-bar').length,
      headings: [...document.querySelectorAll('#print-pages h2.print-heading')].map(
        (h) => h.textContent,
      ),
      markdown: document.querySelectorAll('#print-pages .reader-notes strong').length,
      colored: [...document.querySelectorAll('#print-pages .print-marker')].filter(
        (m) => m.style.backgroundColor === 'rgb(36, 113, 163)',
      ).length,
    };
  });
}

export async function checkPrint(page, engine) {
  const load = async (separate, dark) => {
    const document = printDocumentFixture(separate, dark);
    await page.locator('#json-file').setInputFiles({
      name: 'printed.ochx',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(document)),
    });
    await page.waitForFunction(
      () => document.querySelector('#timeline-title')?.value === 'Printed',
    );
    await page.locator('#fit-button').click();
    // The import's toast covers the middle of the stage for a moment.
    await page
      .locator('#toast')
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
    return document;
  };
  const document = await load(false);
  const stage = await page.locator('#timeline-stage').boundingBox();
  await printFrom(page, stage.x + 120, stage.y + 60, 'Print as a document…');
  const letter = await readPages(page);
  assert.ok(letter.size.length >= 3, 'several pages');
  for (const size of letter.size) assert.deepEqual(size, [816, 1056]);
  // Every moment and duration, in time order: a duration at its start and again at its end.
  const titles = letter.titles.map(([t]) => t);
  for (const event of document.events) assert.ok(titles.includes(event.metadata.title));
  for (const d of document.durations) {
    assert.ok(titles.includes(d.metadata.title), d.metadata.title);
    assert.ok(titles.includes(`End of ${d.metadata.title}`), `End of ${d.metadata.title}`);
  }
  assert.ok(titles.indexOf('Moment 1') < titles.indexOf('Moment 2'));
  assert.ok(titles.indexOf('Duration 1') < titles.indexOf('End of Duration 1'));
  // Margin notes name the page the other end is on, and never overlap.
  const pageOf = new Map(letter.titles);
  assert.deepEqual(letter.overlaps, []);
  const note = letter.notes.find(([text]) => /Moment 41 \(p\. \d+\)/.test(text));
  assert.ok(note, 'a note for the relationship across pages');
  assert.match(note[0], /^→ /, 'the relationship-arrows plugin points it');
  assert.equal(Number(/p\. (\d+)/.exec(note[0])[1]), pageOf.get('Moment 41'));
  assert.ok(letter.connectors > 0, 'relationships on one page are connectors');
  assert.ok(letter.bars > 0, 'durations are bars');
  assert.deepEqual(letter.headings, ['Part 1', 'Part 2', 'Part 3']);
  assert.ok(letter.markdown > 0, 'notes as Markdown');
  assert.ok(letter.colored > 0, 'moment colors');
  // A4, remembered.
  await page.locator('#print-paper').selectOption('a4');
  await page.waitForFunction(
    () => document.querySelector('#print-pages .print-page')?.offsetHeight === 1123,
  );
  if (engine === 'chromium') {
    await page.evaluate(() => document.documentElement.classList.add('printing'));
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => document.documentElement.classList.remove('printing'));
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const a4 = await page.locator('#print-pages .print-page').count();
    assert.equal(pages, a4, 'one PDF page per page');
  }
  await page.locator('#print-close').click();
  assert.equal(await page.locator('#print-preview').isHidden(), true);

  // A separation: each track prints alone, named from where it was asked for.
  await load(true);
  const second = await page.locator('.comparison-axis-title').nth(1).boundingBox();
  const box = await page.locator('#timeline-stage').boundingBox();
  await printFrom(
    page,
    box.x + 120,
    Math.min(second.y + 40, box.y + box.height - 10),
    'Print “Everything else” as a document…',
  );
  const track = await readPages(page);
  const shown = track.titles.map(([t]) => t);
  assert.ok(!shown.includes('Moment 5'), 'tagged moments are the other track’s');
  assert.ok(shown.includes('Moment 7'));
  assert.ok(
    track.notes.some(([text]) => /Moment 5 \(.*not in this document\)/.test(text)),
    'a relationship into the other track names it as not in this document',
  );
  assert.equal(await page.locator('.print-cover-track').textContent(), 'Everything else');
  await page.locator('#print-close').click();
  // The paper chosen is remembered.
  assert.equal(await page.evaluate(() => localStorage.getItem('circagraph:print-paper')), 'a4');

  // Printed light on white paper, though the app is dark and the timeline's theme is for a dark
  // ground; the theme's text size still applies.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await load(false, true);
  await printFrom(page, stage.x + 120, stage.y + 60, 'Print as a document…');
  const look = await page.evaluate(() => {
    const p = document.querySelector('#print-pages .print-page');
    const title = p.querySelector('.print-title');
    const notes = p.querySelector('.reader-notes');
    return {
      paper: getComputedStyle(p).backgroundColor,
      title: getComputedStyle(title).color,
      notes: getComputedStyle(notes).color,
      scale: getComputedStyle(p).getPropertyValue('--timeline-text-scale').trim(),
    };
  });
  assert.equal(look.paper, 'rgb(255, 255, 255)');
  for (const color of [look.title, look.notes]) {
    const [r, g, b] = color.match(/\d+/g).map(Number);
    assert.ok(r + g + b < 3 * 110, `dark text on white, not ${color}`);
  }
  assert.equal(look.scale, '1.2');
  await page.locator('#print-close').click();
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}
