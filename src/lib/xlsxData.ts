import * as XLSX from "xlsx";

export interface XCell {
  text: string;
  merge?: [number, number];
  style?: number;
}
export interface XRow {
  cells: Record<number, XCell>;
  height?: number;
}
// x-data-spreadsheet cell style (the subset derivable from xlsx styles).
export interface XStyle {
  bgcolor?: string;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  textwrap?: boolean;
  strike?: boolean;
  underline?: boolean;
  font?: { name?: string; size?: number; bold?: boolean; italic?: boolean };
  border?: Partial<
    Record<"top" | "right" | "bottom" | "left", [string, string]>
  >;
}
export interface XSheet {
  name: string;
  rows: Record<number, XRow>;
  merges?: string[];
  cols?: Record<number, { width: number }>;
  styles?: XStyle[];
}

export function workbookToXSpreadsheet(wb: XLSX.WorkBook): XSheet[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows: Record<number, XRow> = {};
    const ref = ws["!ref"];
    let offR = 0;
    let offC = 0;
    if (ref !== undefined) {
      const range = XLSX.utils.decode_range(ref);
      offR = range.s.r;
      offC = range.s.c;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: Record<number, XCell> = {};
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] as XLSX.CellObject | undefined;
          if (cell === undefined || (cell.v === undefined && cell.w === undefined)) continue;
          const text = cell.w ?? (cell.v === undefined ? "" : String(cell.v));
          cells[c - offC] = { text };
        }
        if (Object.keys(cells).length > 0) {
          rows[r - offR] = { cells };
        }
      }
    }

    const sheet: XSheet = { name, rows };

    // Merged ranges: x-data-spreadsheet wants both the merges list ("A1:B2")
    // and merge:[extraRows, extraCols] on the top-left cell of each range.
    const merges = ws["!merges"];
    if (merges !== undefined && merges.length > 0) {
      sheet.merges = [];
      for (const m of merges) {
        const s = { r: m.s.r - offR, c: m.s.c - offC };
        const e = { r: m.e.r - offR, c: m.e.c - offC };
        sheet.merges.push(XLSX.utils.encode_range({ s, e }));
        const row = (rows[s.r] ??= { cells: {} });
        const cell = (row.cells[s.c] ??= { text: "" });
        cell.merge = [e.r - s.r, e.c - s.c];
      }
    }

    // Column widths (px preferred; fall back to char-count approximation).
    const wsCols = ws["!cols"];
    if (wsCols !== undefined) {
      const cols: Record<number, { width: number }> = {};
      wsCols.forEach((info, i) => {
        if (info === undefined || i - offC < 0) return;
        const px =
          info.wpx ?? (info.wch !== undefined ? Math.round(info.wch * 7 + 5) : undefined);
        if (px !== undefined) cols[i - offC] = { width: px };
      });
      if (Object.keys(cols).length > 0) sheet.cols = cols;
    }

    // Row heights.
    const wsRows = ws["!rows"];
    if (wsRows !== undefined) {
      wsRows.forEach((info, i) => {
        if (info?.hpx === undefined || i - offR < 0) return;
        const row = (rows[i - offR] ??= { cells: {} });
        row.height = Math.round(info.hpx);
      });
    }

    return sheet;
  });
}

// ── Style overlay (exceljs) ─────────────────────────────────────────────────
// SheetJS CE gives values/formatted text/shape but not colors; exceljs parses
// fills/fonts/borders. We keep SheetJS as the data source and overlay styles.
// Structural types so exceljs stays a dynamic import (own lazy chunk).

interface EColor {
  argb?: string;
}
interface EBorderEdge {
  style?: string;
  color?: EColor;
}
export interface ECellStyle {
  font?: {
    name?: string;
    size?: number;
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    underline?: boolean | string;
    color?: EColor;
  };
  fill?: { type?: string; pattern?: string; fgColor?: EColor };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  border?: {
    top?: EBorderEdge;
    right?: EBorderEdge;
    bottom?: EBorderEdge;
    left?: EBorderEdge;
  };
}
interface ECell {
  style?: ECellStyle;
}
interface ERow {
  eachCell: (
    opts: { includeEmpty: boolean },
    cb: (cell: ECell, colNumber: number) => void,
  ) => void;
}
interface EWorksheet {
  eachRow: (
    opts: { includeEmpty: boolean },
    cb: (row: ERow, rowNumber: number) => void,
  ) => void;
}
interface EWorkbook {
  xlsx: { load: (data: ArrayBuffer) => Promise<unknown> };
  getWorksheet: (name: string) => EWorksheet | undefined;
}

function argbToHex(argb: string | undefined): string | undefined {
  if (argb === undefined || argb.length < 6) return undefined;
  return "#" + argb.slice(-6);
}

const BORDER_STYLE: Record<string, string> = {
  thin: "thin",
  hair: "thin",
  medium: "medium",
  double: "medium",
  thick: "thick",
  dotted: "dotted",
  dashed: "dashed",
  dashDot: "dashed",
  dashDotDot: "dashed",
  mediumDashed: "dashed",
  mediumDashDot: "dashed",
  mediumDashDotDot: "dashed",
  slantDashDot: "dashed",
};

const H_ALIGN: Record<string, XStyle["align"]> = {
  left: "left",
  center: "center",
  centerContinuous: "center",
  right: "right",
  justify: "left",
};
const V_ALIGN: Record<string, XStyle["valign"]> = {
  top: "top",
  middle: "middle",
  bottom: "bottom",
};

/** Convert an exceljs cell style to an x-data-spreadsheet style; null if it
 *  carries nothing we can render. Theme-indexed colors (no argb) are skipped. */
export function excelStyleToXStyle(s: ECellStyle): XStyle | null {
  const out: XStyle = {};
  if (s.fill?.type === "pattern" && s.fill.pattern === "solid") {
    const bg = argbToHex(s.fill.fgColor?.argb);
    if (bg !== undefined) out.bgcolor = bg;
  }
  const f = s.font;
  if (f !== undefined) {
    const color = argbToHex(f.color?.argb);
    if (color !== undefined) out.color = color;
    const font: NonNullable<XStyle["font"]> = {};
    if (f.name !== undefined) font.name = f.name;
    if (f.size !== undefined) font.size = f.size;
    if (f.bold === true) font.bold = true;
    if (f.italic === true) font.italic = true;
    if (Object.keys(font).length > 0) out.font = font;
    if (f.strike === true) out.strike = true;
    if (f.underline === true || typeof f.underline === "string")
      out.underline = true;
  }
  const al = s.alignment;
  if (al !== undefined) {
    const h = al.horizontal !== undefined ? H_ALIGN[al.horizontal] : undefined;
    if (h !== undefined) out.align = h;
    const v = al.vertical !== undefined ? V_ALIGN[al.vertical] : undefined;
    if (v !== undefined) out.valign = v;
    if (al.wrapText === true) out.textwrap = true;
  }
  if (s.border !== undefined) {
    const border: NonNullable<XStyle["border"]> = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const edge = s.border[side];
      if (edge?.style === undefined) continue;
      const style = BORDER_STYLE[edge.style];
      if (style === undefined) continue;
      border[side] = [style, argbToHex(edge.color?.argb) ?? "#000000"];
    }
    if (Object.keys(border).length > 0) out.border = border;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Overlay per-cell styles from exceljs onto the SheetJS-derived sheets.
 *  Best-effort: any failure leaves the unstyled sheets intact. */
async function overlayStyles(
  bytes: Uint8Array,
  wb: XLSX.WorkBook,
  sheets: XSheet[],
): Promise<void> {
  const mod = (await import("exceljs")) as unknown as {
    Workbook?: new () => EWorkbook;
    default?: { Workbook: new () => EWorkbook };
  };
  const Workbook = mod.Workbook ?? mod.default?.Workbook;
  if (Workbook === undefined) return;
  const ewb = new Workbook();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await ewb.xlsx.load(ab);

  for (const sheet of sheets) {
    const ews = ewb.getWorksheet(sheet.name);
    if (ews === undefined) continue;
    const ref = wb.Sheets[sheet.name]?.["!ref"];
    const off = ref !== undefined ? XLSX.utils.decode_range(ref).s : { r: 0, c: 0 };
    const styles: XStyle[] = [];
    const seen = new Map<string, number>();
    ews.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.style === undefined) return;
        const xs = excelStyleToXStyle(cell.style);
        if (xs === null) return;
        const key = JSON.stringify(xs);
        let idx = seen.get(key);
        if (idx === undefined) {
          idx = styles.length;
          styles.push(xs);
          seen.set(key, idx);
        }
        const r = rowNumber - 1 - off.r;
        const c = colNumber - 1 - off.c;
        if (r < 0 || c < 0) return;
        const rowObj = (sheet.rows[r] ??= { cells: {} });
        const cellObj = (rowObj.cells[c] ??= { text: "" });
        cellObj.style = idx;
      });
    });
    if (styles.length > 0) sheet.styles = styles;
  }
}

export async function parseXlsx(bytes: Uint8Array): Promise<XSheet[]> {
  // cellStyles is what makes SheetJS populate !cols / !rows on read.
  const wb = XLSX.read(bytes, { type: "array", cellStyles: true });
  const sheets = workbookToXSpreadsheet(wb);
  try {
    await overlayStyles(bytes, wb, sheets);
  } catch {
    // styles are best-effort — values/shape still render without them
  }
  return sheets;
}
