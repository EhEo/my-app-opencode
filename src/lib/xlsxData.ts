import * as XLSX from "xlsx";

export interface XCell {
  text: string;
}
export interface XRow {
  cells: Record<number, XCell>;
}
export interface XSheet {
  name: string;
  rows: Record<number, XRow>;
}

export function workbookToXSpreadsheet(wb: XLSX.WorkBook): XSheet[] {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows: Record<number, XRow> = {};
    const ref = ws["!ref"];
    if (ref !== undefined) {
      const range = XLSX.utils.decode_range(ref);
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: Record<number, XCell> = {};
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr] as XLSX.CellObject | undefined;
          if (cell === undefined || (cell.v === undefined && cell.w === undefined)) continue;
          const text = cell.w ?? (cell.v === undefined ? "" : String(cell.v));
          cells[c - range.s.c] = { text };
        }
        if (Object.keys(cells).length > 0) {
          rows[r - range.s.r] = { cells };
        }
      }
    }
    return { name, rows };
  });
}

export function parseXlsx(bytes: Uint8Array): XSheet[] {
  const wb = XLSX.read(bytes, { type: "array" });
  return workbookToXSpreadsheet(wb);
}
