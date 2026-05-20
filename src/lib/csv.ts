/**
 * Tiny CSV builder + browser download trigger.
 *
 * Why CSV vs xlsx:
 *   CSV opens cleanly in Excel, Numbers, Google Sheets, and any text editor.
 *   No third-party dependency, no build-size hit, and easy to email forward.
 *   We prepend a UTF-8 BOM so Excel renders accented characters correctly.
 *
 * Sections:
 *   downloadCsv(filename, rows)        — single-table dump
 *   downloadCsvSections(filename, [..])— multi-section "report" with titles
 */

export type CsvCell = string | number | null | undefined;
export type CsvRow = CsvCell[];

export interface CsvSection {
  /** Section heading, written as a single cell in row 1 */
  title?: string;
  /** Optional subheading written in row 2 */
  subtitle?: string;
  /** Header row */
  headers?: string[];
  /** Body rows */
  rows: CsvRow[];
}

function escapeCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  // Quote if contains comma, quote, newline, or leading/trailing whitespace
  if (/[",\r\n]|^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToLine(row: CsvRow): string {
  return row.map(escapeCell).join(',');
}

export function buildCsv(headers: string[], rows: CsvRow[]): string {
  const out: string[] = [];
  if (headers.length) out.push(rowToLine(headers));
  for (const r of rows) out.push(rowToLine(r));
  return out.join('\r\n');
}

export function buildCsvSections(sections: CsvSection[]): string {
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    if (i > 0) out.push(''); // blank line between sections
    if (s.title) out.push(rowToLine([s.title]));
    if (s.subtitle) out.push(rowToLine([s.subtitle]));
    if (s.headers && s.headers.length) out.push(rowToLine(s.headers));
    for (const r of s.rows) out.push(rowToLine(r));
  }
  return out.join('\r\n');
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari can complete the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const UTF8_BOM = '\uFEFF';

export function downloadCsv(filename: string, headers: string[], rows: CsvRow[]) {
  const csv = UTF8_BOM + buildCsv(headers, rows);
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

export function downloadCsvSections(filename: string, sections: CsvSection[]) {
  const csv = UTF8_BOM + buildCsvSections(sections);
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

/** Build a date-stamped filename like `salesrev_overview_2026-05-19.csv` */
export function stampedName(slug: string): string {
  const now = new Date();
  const cst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // YYYY-MM-DD
  return `${slug}_${cst}.csv`;
}

/** Format a number for CSV output — no thousands separators, fixed decimals. */
export function csvNum(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n.toFixed(decimals);
}
