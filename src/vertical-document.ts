// Copyright (c) 2026 Athan Clark. SPDX-License-Identifier: GPL-3.0-only
// A track as a vertical document, for print (docs/printing.md): its rows in time order, broken
// into pages, its durations as bars beside them and its relationships as connectors on a page
// or margin notes naming another page. Pure: print-document.ts measures each row and draws
// what this decides.

/** What a row stands for: a duration's start, a moment, or a duration's end. */
export type RowKind = 'start' | 'moment' | 'end';
export interface DocRow {
  /** Its entity's reference key ("m:<id>" or "d:<id>"). */
  key: string;
  kind: RowKind;
  /**
   * The heights of its blocks, in order: its heading (marker, time and title) first, then its
   * content's blocks (images, notes' paragraphs, fields). A page may break between blocks.
   */
  fragments: number[];
  /**
   * The most room its margin notes could need: their height were every one of its
   * relationships to end on another page. Reserving that much keeps the notes from
   * overlapping whatever pages they end up naming.
   */
  notes: number;
}
export interface Geometry {
  /** The height of a page's content area. */
  height: number;
  /** The room between rows, and between margin notes. */
  gap: number;
}
export interface Placed {
  row: number;
  fragment: number;
  top: number;
  height: number;
  /** Taller than a whole page, so cut at its foot. */
  clipped: boolean;
}
export interface Pagination {
  pages: { placed: Placed[] }[];
  /** The page (from 0) and top of each row's heading. */
  rowPage: number[];
  rowTop: number[];
}

/**
 * Breaks rows into pages. A row's heading stays with its first block of content; a row's
 * blocks may continue on the next page. A row begins on a new page when its heading would not
 * fit, or when its margin notes (at their most) would run past the page's foot, given the
 * notes above it, which are pushed down rather than overlapped. A block taller than a whole
 * page stays where it falls and is cut at the page's foot.
 */
export function paginate(rows: readonly DocRow[], geometry: Geometry): Pagination {
  const { height, gap } = geometry;
  const pages: { placed: Placed[] }[] = [{ placed: [] }];
  const rowPage: number[] = [],
    rowTop: number[] = [];
  let y = 0,
    notesY = 0;
  const newPage = () => {
    pages.push({ placed: [] });
    y = 0;
    notesY = 0;
  };
  const empty = () => pages[pages.length - 1].placed.length === 0;
  rows.forEach((row, r) => {
    const fragments = row.fragments.length ? row.fragments : [0];
    const first = fragments[0] + (fragments.length > 1 ? fragments[1] : 0);
    const notesEnd = row.notes > 0 ? Math.max(y, notesY) + row.notes : 0;
    if (!empty() && (y + first > height || notesEnd > height)) newPage();
    rowPage[r] = pages.length - 1;
    rowTop[r] = y;
    if (row.notes > 0) notesY = Math.max(y, notesY) + row.notes + gap;
    fragments.forEach((h, f) => {
      // A block taller than any page stays with what comes before it, cut at the foot.
      if (f > 0 && y + h > height && h <= height && !empty()) newPage();
      const room = height - y;
      pages[pages.length - 1].placed.push({
        row: r,
        fragment: f,
        top: y,
        height: Math.min(h, room),
        clipped: h > room,
      });
      y += Math.min(h, room);
    });
    y += gap;
  });
  return { pages, rowPage, rowTop };
}

/**
 * Lanes for intervals of rows (a duration from its start row to its end row), in the order
 * given: each takes the lowest lane free since the last interval in it ended, up to `max`
 * lanes; one that finds none gets null.
 */
export function lanes(spans: readonly { start: number; end: number }[], max: number) {
  const ends: number[] = [];
  return spans.map(({ start, end }) => {
    let lane = ends.findIndex((last) => last < start);
    if (lane < 0 && ends.length < max) lane = ends.length;
    if (lane < 0) return null;
    ends[lane] = end;
    return lane;
  });
}

export interface Segment {
  /** Its index in the spans given. */
  span: number;
  lane: number;
  page: number;
  top: number;
  bottom: number;
  /** Whether it begins (or ends) on this page, rather than continuing from (or onto) another. */
  begins: boolean;
  ends: boolean;
}
/**
 * Each laned duration's bar, page by page: from its start row's marker (`anchor` below the
 * row's top) to its end row's, continuing through the pages between.
 */
export function segments(
  spans: readonly { start: number; end: number }[],
  laned: readonly (number | null)[],
  pagination: Pagination,
  pageHeight: number,
  anchor: number,
): Segment[] {
  const { rowPage, rowTop } = pagination;
  const result: Segment[] = [];
  spans.forEach(({ start, end }, span) => {
    const lane = laned[span];
    if (lane == null) return;
    for (let page = rowPage[start]; page <= rowPage[end]; page++)
      result.push({
        span,
        lane,
        page,
        top: page === rowPage[start] ? rowTop[start] + anchor : 0,
        bottom: page === rowPage[end] ? rowTop[end] + anchor : pageHeight,
        begins: page === rowPage[start],
        ends: page === rowPage[end],
      });
  });
  return result;
}

export interface Connector {
  /** Its index in the links given. */
  link: number;
  page: number;
  lane: number;
  top: number;
  bottom: number;
}
export interface Note {
  /** Its index in the links given. */
  link: number;
  /** The other end's reference key. */
  other: string;
  /** The page the other end's row is on, or null when the document doesn't include it. */
  page: number | null;
}
/**
 * How each relationship is shown. Both ends on one page: a connector between their markers,
 * in the lowest of `maxLanes` lanes free along its length, or, where none is, a note at each
 * end. Ends on different pages, or one outside the document: a note at each end it includes,
 * naming the other's page.
 */
export function relationshipPlan(
  links: readonly { a: string; b: string }[],
  rowOf: ReadonlyMap<string, number>,
  pagination: Pagination,
  maxLanes: number,
  anchor: number,
) {
  const { rowPage, rowTop } = pagination;
  const connectors: Connector[] = [];
  const notes = new Map<number, Note[]>();
  const note = (row: number, entry: Note) => {
    const list = notes.get(row);
    if (list) list.push(entry);
    else notes.set(row, [entry]);
  };
  const samePage: { link: number; page: number; top: number; bottom: number }[] = [];
  links.forEach(({ a, b }, link) => {
    const ra = rowOf.get(a),
      rb = rowOf.get(b);
    if (ra === undefined && rb === undefined) return;
    if (ra !== undefined && rb !== undefined && rowPage[ra] === rowPage[rb]) {
      const ya = rowTop[ra] + anchor,
        yb = rowTop[rb] + anchor;
      samePage.push({
        link,
        page: rowPage[ra],
        top: Math.min(ya, yb),
        bottom: Math.max(ya, yb),
      });
      return;
    }
    if (ra !== undefined) note(ra, { link, other: b, page: rb === undefined ? null : rowPage[rb] });
    if (rb !== undefined) note(rb, { link, other: a, page: ra === undefined ? null : rowPage[ra] });
  });
  samePage.sort((x, y) => x.page - y.page || x.top - y.top || x.bottom - y.bottom);
  let page = -1,
    ends: number[] = [];
  for (const s of samePage) {
    if (s.page !== page) {
      page = s.page;
      ends = [];
    }
    let lane = ends.findIndex((bottom) => bottom < s.top);
    if (lane < 0 && ends.length < maxLanes) lane = ends.length;
    if (lane >= 0) {
      ends[lane] = s.bottom;
      connectors.push({ link: s.link, page: s.page, lane, top: s.top, bottom: s.bottom });
    } else {
      const { a, b } = links[s.link];
      note(rowOf.get(a)!, { link: s.link, other: b, page: s.page });
      note(rowOf.get(b)!, { link: s.link, other: a, page: s.page });
    }
  }
  return { connectors, notes };
}

/**
 * Margin notes' tops on one page: each at its row's top, pushed below the one before it.
 * `rows` are the page's rows with notes, in order, and their notes' heights.
 */
export function noteTops(rows: readonly { top: number; height: number }[], gap: number) {
  let y = 0;
  return rows.map(({ top, height }) => {
    const at = Math.max(top, y);
    y = at + height + gap;
    return at;
  });
}

/** Paper sizes, in CSS pixels (96 to the inch). */
export const PAPER = {
  letter: { label: 'Letter (8.5 × 11 in)', width: 816, height: 1056, css: 'letter' },
  a4: { label: 'A4 (210 × 297 mm)', width: 794, height: 1123, css: 'A4' },
} as const;
export type Paper = keyof typeof PAPER;
/** The most moments and durations one document holds. */
export const DOCUMENT_LIMIT = 2000;
/** Rows: a duration's start before moments at one time, its end after them. */
const KIND_ORDER: Record<RowKind, number> = { start: 0, moment: 1, end: 2 };
/** Orders rows by time (compared by `compare`), then start, moment, end, then by key. */
export function rowOrder<T extends { kind: RowKind; key: string }>(
  rows: T[],
  time: (row: T) => string,
  compare: (a: string, b: string) => number,
): T[] {
  return rows.sort(
    (a, b) =>
      compare(time(a), time(b)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
