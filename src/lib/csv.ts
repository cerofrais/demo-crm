/**
 * Minimal RFC4180-ish CSV parser — handles quoted fields (embedded commas,
 * newlines, escaped "" quotes). No dependency needed for a format this
 * simple. Returns one object per data row, keyed by the header row.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      const obj: Record<string, string> = {};
      header.forEach((key, i) => {
        obj[key.trim()] = (row[i] ?? "").trim();
      });
      return obj;
    });
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
