import * as XLSX from "xlsx";

export interface XCell {
  text: string;
  merge?: [number, number];
}
export interface XRow {
  cells: Record<number, XCell>;
  height?: number;
}
export interface XSheet {
  name: string;
  rows: Record<number, XRow>;
  merges?: string[];
  cols?: Record<number, { width: number }>;
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

export function parseXlsx(bytes: Uint8Array): XSheet[] {
  // cellStyles is what makes SheetJS populate !cols / !rows on read.
  const wb = XLSX.read(bytes, { type: "array", cellStyles: true });
  return workbookToXSpreadsheet(wb);
}
