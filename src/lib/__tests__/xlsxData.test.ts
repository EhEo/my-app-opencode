import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { workbookToXSpreadsheet } from "../xlsxData";

describe("workbookToXSpreadsheet", () => {
  it("maps cells to x-spreadsheet rows with display text", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Name", "Qty"],
      ["Apple", 3],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1");

    const sheets = workbookToXSpreadsheet(wb);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("S1");
    expect(sheets[0].rows[0].cells[0].text).toBe("Name");
    expect(sheets[0].rows[0].cells[1].text).toBe("Qty");
    expect(sheets[0].rows[1].cells[0].text).toBe("Apple");
    expect(sheets[0].rows[1].cells[1].text).toBe("3");
  });

  it("handles an empty sheet", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const sheets = workbookToXSpreadsheet(wb);
    expect(sheets[0].name).toBe("Empty");
    expect(Object.keys(sheets[0].rows)).toHaveLength(0);
  });

  it("converts merges, column widths and row heights", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Header", "", "X"],
      ["A", "B", "C"],
    ]);
    // A1:B1 merged; column widths; row heights.
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
    ];
    ws["!cols"] = [{ wpx: 120 }, undefined as unknown as XLSX.ColInfo, { wch: 10 }];
    ws["!rows"] = [{ hpx: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1");

    const sheets = workbookToXSpreadsheet(wb);
    const s = sheets[0];
    expect(s.merges).toEqual(["A1:B1"]);
    expect(s.rows[0].cells[0].merge).toEqual([0, 1]);
    expect(s.cols?.[0]).toEqual({ width: 120 });
    expect(s.cols?.[2]).toEqual({ width: 75 }); // wch 10 → 10*7+5
    expect(s.rows[0].height).toBe(40);
  });
});
