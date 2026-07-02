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
});
