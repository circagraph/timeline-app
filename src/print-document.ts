// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// A track printed as a vertical document (docs/printing.md): every moment and duration in time
// order, not to scale, each with its content as the reader shows it; durations as bars in the
// left margin, relationships as connectors on a page or notes in the right margin naming the
// other end's page. Built as pages of a fixed paper size that the browser prints, or saves as
// PDF; vertical-document.ts decides the breaks and lanes from the heights measured here.
import { renderReader } from './event-reader.js';
import { imageSource } from './image-assets.js';
import type { Measures } from './measures.js';
import {
  arcArrowheads,
  pluginColor,
  pluginHeading,
  pluginMarker,
  pluginOutline,
  pluginShape,
  pluginSize,
  pluginTheme,
} from './plugins.js';
import type { InstalledPlugin } from './plugins.js';
import {
  renderPluginHeading,
  renderPluginMarker,
  renderPluginOutline,
  renderPluginShape,
} from './plugin-ui.js';
import { themeProperties } from './timeline-theme.js';
import {
  DocRow,
  PAPER,
  Paper,
  lanes,
  noteTops,
  paginate,
  relationshipPlan,
  rowOrder,
  segments,
} from './vertical-document.js';

export interface PrintEntity {
  /** "m:<id>" or "d:<id>". */
  key: string;
  kind: 'moment' | 'duration';
  metadata: Record<string, unknown>;
  /** A moment's time; a duration's earliest and latest times, and its ends as defined. */
  first: string;
  last?: string;
  start?: string;
  end?: string;
  ongoing?: boolean;
}
export interface PrintInput {
  /** The timeline's title, and the track's name when it is one of several. */
  title: string;
  track: string | null;
  /** The view's range, as printed: "From … to …". */
  scope: string;
  entities: PrintEntity[];
  /** Relationships touching them, by reference keys. */
  links: { a: string; b: string }[];
  /** Ends of those relationships the document leaves out: their names and first times. */
  others: Map<string, { title: string | null; first: string | null }>;
  /** Whether some relationships were left out (more than the server reads at once). */
  linksTruncated?: boolean;
  momentPlugins: readonly InstalledPlugin[];
  durationPlugins: readonly InstalledPlugin[];
  /** All the timeline's plugins, for its theme. */
  plugins: readonly InstalledPlugin[];
  markdown: boolean;
  measures?: Measures;
  /** A time as written on its own. */
  when(time: string): string;
  compare(a: string, b: string): number;
  paper: Paper;
}

/** Page margins and gutters, in CSS pixels. */
const MARGIN = { top: 64, bottom: 64, left: 40, right: 32 };
const DURATION_LANE = 9,
  DURATION_LANES = 8,
  CONNECTOR_LANE = 8,
  CONNECTOR_LANES = 4,
  NOTES_WIDTH = 150,
  GAP = 12,
  /** Where a row's marker is, below its top. */
  ANCHOR = 11;

type Row = DocRow & { entity?: PrintEntity; element?: HTMLElement[] };
const untitled = (entity: PrintEntity) =>
  entity.kind === 'moment' ? 'Untitled moment' : 'Untitled duration';
const titleOf = (entity: PrintEntity) =>
  (typeof entity.metadata.title === 'string' && entity.metadata.title.trim()) || untitled(entity);

function block(className: string, ...children: Node[]) {
  const div = document.createElement('div');
  div.className = className;
  div.append(...children);
  return div;
}
function textBlock(tag: string, className: string, text: string) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** A moment's marker, drawn as the timeline draws it: icon, shape, color, size and outline. */
function marker(plugins: readonly InstalledPlugin[], metadata: Record<string, unknown>) {
  const button = document.createElement('button');
  button.type = 'button';
  button.tabIndex = -1;
  button.className = 'event-marker print-marker';
  button.setAttribute('aria-hidden', 'true');
  renderPluginMarker(button, imageSource(pluginMarker(plugins, metadata)), 1n);
  button.style.backgroundColor = pluginColor(plugins, metadata) ?? '';
  button.dataset.size = pluginSize(plugins, metadata);
  renderPluginShape(button, pluginShape(plugins, metadata));
  renderPluginOutline(button, pluginOutline(plugins, metadata));
  return button;
}
function durationColor(input: PrintInput, entity: PrintEntity) {
  return pluginColor(input.durationPlugins, entity.metadata) ?? '';
}

/** A row's blocks: its heading, then its content as the reader shows it. */
function rowBlocks(input: PrintInput, row: Row): HTMLElement[] {
  const entity = row.entity!;
  const plugins = entity.kind === 'moment' ? input.momentPlugins : input.durationPlugins;
  const head = document.createElement('div');
  head.className = 'print-head';
  const time = (text: string) => textBlock('span', 'print-time', text);
  if (row.kind === 'end') {
    const swatch = textBlock('span', 'print-swatch print-swatch-end', '');
    swatch.style.backgroundColor = durationColor(input, entity);
    head.append(
      swatch,
      time(entity.ongoing ? 'Ongoing' : input.when(entity.end ?? entity.last!)),
      textBlock('span', 'print-title print-end-title', `End of ${titleOf(entity)}`),
    );
    return [block('print-fragment', head)];
  }
  const heading = entity.kind === 'moment' ? pluginHeading(plugins, entity.metadata) : null;
  if (heading) {
    // A heading moment (#110) is a heading here too, in its level and font.
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    renderPluginHeading(button, heading, titleOf(entity));
    const title = textBlock(heading.level, 'print-heading', button.textContent ?? '');
    title.style.fontFamily = heading.font;
    head.classList.add('print-head-heading');
    head.append(time(input.when(entity.first)), title);
  } else if (entity.kind === 'moment') {
    head.append(
      marker(plugins, entity.metadata),
      time(input.when(entity.first)),
      textBlock('span', 'print-title', titleOf(entity)),
    );
  } else {
    const swatch = textBlock('span', 'print-swatch', '');
    swatch.style.backgroundColor = durationColor(input, entity);
    if (pluginOutline(plugins, entity.metadata) === 'dashed') swatch.dataset.outline = 'dashed';
    head.append(
      swatch,
      time(
        `${input.when(entity.start ?? entity.first)} – ${
          entity.ongoing ? 'ongoing' : input.when(entity.end ?? entity.last!)
        }`,
      ),
      textBlock('span', 'print-title', titleOf(entity)),
    );
  }
  const reader = document.createElement('div');
  renderReader(reader, {
    kind: entity.kind,
    metadata: entity.metadata,
    plugins,
    when: '',
    markdown: input.markdown,
    measures: input.measures,
  });
  reader.querySelector('.reader-when')?.remove();
  // Each of the reader's blocks may start a page; notes break between their paragraphs.
  const blocks: HTMLElement[] = [block('print-fragment', head)];
  for (const child of [...reader.children] as HTMLElement[]) {
    if (child.classList.contains('reader-notes'))
      for (const part of [...child.children])
        blocks.push(block('print-fragment print-body', block('reader-notes', part)));
    else blocks.push(block('print-fragment print-body', child));
  }
  return blocks;
}

/** The document's first block: its title, the track, the range and what it holds. */
function titleBlock(input: PrintInput) {
  const moments = input.entities.filter((e) => e.kind === 'moment').length,
    durations = input.entities.length - moments;
  const count = (n: number, one: string, many: string) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const box = block(
    'print-fragment print-cover',
    textBlock('h1', 'print-cover-title', input.title || 'Untitled timeline'),
  );
  if (input.track) box.append(textBlock('p', 'print-cover-track', input.track));
  box.append(
    textBlock('p', 'print-cover-scope', input.scope),
    textBlock(
      'p',
      'print-cover-count',
      `${count(moments, 'moment', 'moments')}, ${count(durations, 'duration', 'durations')} and ${count(
        input.links.length,
        'relationship',
        'relationships',
      )}, in order of time and not to scale.` +
        (input.linksTruncated ? ' Some relationships are left out: there are too many.' : ''),
    ),
  );
  return box;
}

/** Waits for the images in `root` to load or fail, for at most `ms`. */
function imagesSettled(root: HTMLElement, ms = 8000) {
  const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete);
  return Promise.race([
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

export interface PrintResult {
  pages: number;
}
/**
 * Lays the document out in `host` as pages of `input.paper`, replacing what it held, and sets
 * the paper size for printing. Measures in `host`, so it must be in the page and shown.
 */
export async function printDocument(host: HTMLElement, input: PrintInput): Promise<PrintResult> {
  const paper = PAPER[input.paper];
  host.replaceChildren();
  host.className = 'print-document';
  for (const [name, value] of Object.entries(themeProperties(pluginTheme(input.plugins))))
    host.style.setProperty(name, value);
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${paper.css}; margin: 0; }`;
  host.append(pageStyle);

  // Rows in time order: a duration at its start and at its end.
  const entityRows: Row[] = [];
  for (const entity of input.entities) {
    if (entity.kind === 'moment') {
      entityRows.push({ key: entity.key, kind: 'moment', fragments: [], notes: 0, entity });
      continue;
    }
    entityRows.push({ key: entity.key, kind: 'start', fragments: [], notes: 0, entity });
    entityRows.push({ key: entity.key, kind: 'end', fragments: [], notes: 0, entity });
  }
  const at = (row: Row) =>
    row.kind === 'end' ? (row.entity!.last ?? row.entity!.first) : row.entity!.first;
  rowOrder(entityRows, at, input.compare);
  const rows: Row[] = [{ key: '', kind: 'moment', fragments: [], notes: 0 }, ...entityRows];
  // The row each entity's relationships attach to: a moment's, or a duration's start.
  const rowOf = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.entity && row.kind !== 'end') rowOf.set(row.key, i);
  });
  const endRow = new Map<string, number>();
  rows.forEach((row, i) => row.kind === 'end' && endRow.set(row.key, i));
  const durations = [...endRow.keys()];
  const spans = durations.map((key) => ({ start: rowOf.get(key)!, end: endRow.get(key)! }));
  const laned = lanes(spans, DURATION_LANES);
  const usedLanes = Math.max(0, ...laned.map((l) => (l == null ? 0 : l + 1)));
  const left = MARGIN.left + usedLanes * DURATION_LANE + (usedLanes ? 10 : 0);
  const columnWidth =
    paper.width - left - CONNECTOR_LANES * CONNECTOR_LANE - 14 - NOTES_WIDTH - MARGIN.right;
  const height = paper.height - MARGIN.top - MARGIN.bottom;
  const byKey = new Map(input.entities.map((e) => [e.key, e]));

  // Measure every row at the column's width.
  const measure = block('print-measure');
  measure.style.width = `${columnWidth}px`;
  host.append(measure);
  rows.forEach((row) => {
    row.element = row.entity ? rowBlocks(input, row) : [titleBlock(input)];
    measure.append(...row.element);
  });
  await imagesSettled(measure);
  await nextFrame();
  for (const row of rows)
    row.fragments = row.element!.map((part) => part.getBoundingClientRect().height);

  // Margin notes: what each row says of relationships and durations on other pages.
  const linkIndex = new Map<string, number[]>();
  input.links.forEach(({ a, b }, i) => {
    for (const key of [a, b]) {
      if (!rowOf.has(key)) continue;
      const list = linkIndex.get(key);
      if (list) list.push(i);
      else linkIndex.set(key, [i]);
    }
  });
  const name = (key: string) => {
    const entity = byKey.get(key);
    if (entity) return titleOf(entity);
    const other = input.others.get(key);
    return other?.title?.trim() || (key.startsWith('m:') ? 'Untitled moment' : 'Untitled duration');
  };
  const arrows = (link: { a: string; b: string }, from: string) => {
    const end = (key: string) => {
      const entity = byKey.get(key);
      return {
        key,
        plugins: key.startsWith('m:') ? input.momentPlugins : input.durationPlugins,
        metadata: entity?.metadata ?? null,
      };
    };
    const heads = arcArrowheads(end(link.a), end(link.b));
    const toOther = link.a === from ? heads.b : heads.a,
      toSelf = link.a === from ? heads.a : heads.b;
    return toOther && toSelf ? '↔' : toOther ? '→' : toSelf ? '←' : '—';
  };
  type NoteLine = { text: string };
  const noteLines = (
    r: number,
    pageOf: (key: string) => number | null | 'same',
    durationPage: (r: number) => string | null,
  ): NoteLine[] => {
    const row = rows[r];
    const lines: NoteLine[] = [];
    const ends = durationPage(r);
    if (ends) lines.push({ text: ends });
    if (row.kind === 'end' || !row.entity) return lines;
    for (const i of linkIndex.get(row.key) ?? []) {
      const link = input.links[i];
      const other = link.a === row.key ? link.b : link.a;
      if (other === row.key) continue;
      const page = pageOf(other);
      if (page === 'same') continue;
      const where =
        page === null
          ? `${input.others.get(other)?.first ? input.when(input.others.get(other)!.first!) + ', ' : ''}not in this document`
          : `p. ${page}`;
      lines.push({ text: `${arrows(link, row.key)} ${name(other)} (${where})` });
    }
    return lines;
  };
  const notesBlock = (lines: NoteLine[]) => {
    const box = block('print-notes-row');
    for (const line of lines) box.append(textBlock('p', 'print-note', line.text));
    return box;
  };
  // At their most: every relationship on another page, with the widest page number.
  const notesMeasure = block('print-measure');
  notesMeasure.style.width = `${NOTES_WIDTH}px`;
  host.append(notesMeasure);
  const widest = (r: number) =>
    rows[r].kind === 'start' || rows[r].kind === 'end' ? 'Continues to p. 8888' : null;
  rows.forEach((row, r) => {
    const lines = noteLines(
      r,
      (key) => (rowOf.has(key) ? 8888 : null),
      (i) => widest(i),
    );
    if (!lines.length) return;
    const box = notesBlock(lines);
    notesMeasure.append(box);
    row.notes = box.getBoundingClientRect().height;
  });
  measure.remove();
  notesMeasure.remove();

  const pagination = paginate(rows, { height, gap: GAP });
  const { rowPage, rowTop } = pagination;
  const plan = relationshipPlan(
    input.links.filter(({ a, b }) => a !== b),
    rowOf,
    pagination,
    CONNECTOR_LANES,
    ANCHOR,
  );
  const links = input.links.filter(({ a, b }) => a !== b);
  const bars = segments(spans, laned, pagination, height, ANCHOR);
  const total = pagination.pages.length;

  // The notes each row carries, now that pages are known.
  const notesOf = new Map<number, NoteLine[]>();
  rows.forEach((row, r) => {
    const lines: NoteLine[] = [];
    if (row.kind === 'start' || row.kind === 'end') {
      const d = durations.indexOf(row.key);
      const other = row.kind === 'start' ? endRow.get(row.key)! : rowOf.get(row.key)!;
      if (rowPage[other] !== rowPage[r] || laned[d] == null)
        lines.push({
          text:
            rowPage[other] === rowPage[r]
              ? row.kind === 'start'
                ? 'Ends further down this page'
                : 'Began further up this page'
              : row.kind === 'start'
                ? `Continues to p. ${rowPage[other] + 1}`
                : `Began on p. ${rowPage[other] + 1}`,
        });
    }
    for (const note of plan.notes.get(r) ?? []) {
      const link = links[note.link];
      const where =
        note.page === null
          ? `${input.others.get(note.other)?.first ? input.when(input.others.get(note.other)!.first!) + ', ' : ''}not in this document`
          : note.page === rowPage[r]
            ? 'this page'
            : `p. ${note.page + 1}`;
      lines.push({ text: `${arrows(link, row.key)} ${name(note.other)} (${where})` });
    }
    if (lines.length) notesOf.set(r, lines);
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const line = (
    svg: SVGSVGElement,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    cls: string,
  ) => {
    const l = document.createElementNS(svgNS, 'line');
    l.setAttribute('x1', String(x1));
    l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2));
    l.setAttribute('y2', String(y2));
    l.setAttribute('class', cls);
    svg.append(l);
    return l;
  };
  const arrowhead = (svg: SVGSVGElement, x: number, y: number) => {
    const p = document.createElementNS(svgNS, 'polygon');
    p.setAttribute('points', `${x},${y} ${x + 6},${y - 3.5} ${x + 6},${y + 3.5}`);
    p.setAttribute('class', 'print-arrowhead');
    svg.append(p);
  };
  const columnRight = left + columnWidth;
  const notesLeft = columnRight + CONNECTOR_LANES * CONNECTOR_LANE + 14;

  pagination.pages.forEach((page, p) => {
    const sheet = block('print-page');
    sheet.style.width = `${paper.width}px`;
    sheet.style.height = `${paper.height}px`;
    const head = block(
      'print-running-head',
      textBlock('span', '', input.title + (input.track ? ` — ${input.track}` : '')),
    );
    const foot = block('print-running-foot', textBlock('span', '', `${p + 1} of ${total}`));
    const column = block('print-column');
    Object.assign(column.style, {
      left: `${left}px`,
      top: `${MARGIN.top}px`,
      width: `${columnWidth}px`,
      height: `${height}px`,
    });
    for (const placed of page.placed) {
      const part = rows[placed.row].element![placed.fragment];
      const slot = block('print-slot', part);
      slot.style.top = `${placed.top}px`;
      if (placed.clipped) {
        slot.style.height = `${placed.height}px`;
        slot.classList.add('print-clipped');
      }
      column.append(slot);
    }
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'print-lines');
    svg.setAttribute('width', String(paper.width));
    svg.setAttribute('height', String(paper.height));
    svg.setAttribute('aria-hidden', 'true');
    const y = (v: number) => MARGIN.top + v;
    for (const bar of bars.filter((b) => b.page === p)) {
      const x = MARGIN.left + bar.lane * DURATION_LANE + 3;
      const entity = byKey.get(durations[bar.span])!;
      const color = durationColor(input, entity);
      const stroke = line(svg, x, y(bar.top), x, y(bar.bottom), 'print-bar');
      if (color) stroke.style.stroke = color;
      if (pluginOutline(input.durationPlugins, entity.metadata) === 'dashed')
        stroke.classList.add('print-dashed');
      if (!bar.begins) stroke.classList.add('print-continued-top');
      if (!bar.ends) stroke.classList.add('print-continued-bottom');
      for (const [edge, here] of [
        [bar.top, bar.begins],
        [bar.bottom, bar.ends],
      ] as const)
        if (here) {
          const tick = line(svg, x, y(edge), left - 4, y(edge), 'print-bar-tick');
          if (color) tick.style.stroke = color;
        }
    }
    for (const c of plan.connectors.filter((c) => c.page === p)) {
      const x = columnRight + 8 + c.lane * CONNECTOR_LANE;
      line(svg, x, y(c.top), x, y(c.bottom), 'print-connector');
      line(svg, columnRight + 2, y(c.top), x, y(c.top), 'print-connector');
      line(svg, columnRight + 2, y(c.bottom), x, y(c.bottom), 'print-connector');
      // Arrowheads at the ends the relationship points to.
      const link = links[c.link];
      const ra = rowOf.get(link.a)!,
        rb = rowOf.get(link.b)!;
      const heads = arcArrowheads(
        {
          key: link.a,
          plugins: link.a.startsWith('m:') ? input.momentPlugins : input.durationPlugins,
          metadata: byKey.get(link.a)?.metadata ?? null,
        },
        {
          key: link.b,
          plugins: link.b.startsWith('m:') ? input.momentPlugins : input.durationPlugins,
          metadata: byKey.get(link.b)?.metadata ?? null,
        },
      );
      if (heads.a) arrowhead(svg, columnRight + 2, y(rowTop[ra] + ANCHOR));
      if (heads.b) arrowhead(svg, columnRight + 2, y(rowTop[rb] + ANCHOR));
    }
    const notes = block('print-notes');
    Object.assign(notes.style, {
      left: `${notesLeft}px`,
      top: `${MARGIN.top}px`,
      width: `${NOTES_WIDTH}px`,
      height: `${height}px`,
    });
    sheet.append(head, svg, column, notes, foot);
    host.append(sheet);
    // Each row's notes at its top, pushed below the ones above: measured as placed.
    const rowsWithNotes = [...new Set(page.placed.map((x) => x.row))].filter(
      (r) => rowPage[r] === p && notesOf.has(r),
    );
    const boxes = rowsWithNotes.map((r) => {
      const box = notesBlock(notesOf.get(r)!);
      notes.append(box);
      return box;
    });
    const tops = noteTops(
      rowsWithNotes.map((r, i) => ({
        top: rowTop[r],
        height: boxes[i].getBoundingClientRect().height,
      })),
      4,
    );
    boxes.forEach((box, i) => (box.style.top = `${tops[i]}px`));
  });
  return { pages: total };
}
