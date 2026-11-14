export interface CsvParseResult<T = Record<string, string>> {
  headers: string[];
  rows: T[];
  errors: Array<{ rowNumber: number; message: string }>;
}

export const CSV_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB limit
export const CSV_MAX_ROW_COUNT = 5000; // 5,000 rows limit

/**
 * Escapes a cell value against CSV formula injection (CSV Injection / DDE attack).
 * If a cell begins with '=', '+', '-', or '@', prepend a single quote `'`.
 */
export function sanitizeCsvFormula(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Generates an RFC-4180 compliant CSV string with formula injection protection
 * and UTF-8 Byte Order Mark (BOM) for seamless Excel compatibility.
 */
export function generateCsv(headers: { key: string; label: string }[], rows: Record<string, any>[]): string {
  // UTF-8 BOM
  let output = '\uFEFF';

  // Header line
  output += headers.map((h) => escapeCsvCell(h.label)).join(',') + '\r\n';

  // Rows
  for (const row of rows) {
    const line = headers.map((h) => {
      const rawVal = row[h.key];
      const sanitized = sanitizeCsvFormula(rawVal);
      return escapeCsvCell(sanitized);
    });
    output += line.join(',') + '\r\n';
  }

  return output;
}

function escapeCsvCell(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Robust CSV parser supporting quotes, commas within quotes, CRLF,
 * UTF-8 BOM stripping, and full Unicode (Sinhala, Tamil, etc.).
 */
export function parseCsv(rawCsvText: string): CsvParseResult {
  // Strip UTF-8 BOM if present
  let csvText = rawCsvText;
  if (csvText.charCodeAt(0) === 0xFEFF) {
    csvText = csvText.slice(1);
  }

  const lines: string[] = [];
  let currentLine = '';
  let insideQuote = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentLine += '"';
        i++; // Skip escaped quote
      } else {
        insideQuote = !insideQuote;
      }
    } else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (currentLine.trim().length > 0) {
        lines.push(currentLine);
      }
      currentLine = '';
      if (char === '\r' && nextChar === '\n') {
        i++; // Skip CRLF
      }
    } else {
      currentLine += char;
    }
  }

  if (currentLine.trim().length > 0) {
    lines.push(currentLine);
  }

  if (lines.length === 0) {
    return { headers: [], rows: [], errors: [{ rowNumber: 0, message: 'CSV file is empty' }] };
  }

  // Parse header
  const rawHeaders = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const normHeaders = rawHeaders.map((h) => h.replace(/[\s\-]+/g, '_'));
  const rows: Record<string, string>[] = [];
  const errors: Array<{ rowNumber: number; message: string }> = [];

  for (let r = 1; r < lines.length; r++) {
    if (rows.length >= CSV_MAX_ROW_COUNT) {
      errors.push({
        rowNumber: r + 1,
        message: `Maximum row limit exceeded (${CSV_MAX_ROW_COUNT} rows allowed)`
      });
      break;
    }

    const line = lines[r];
    if (!line.trim()) continue;

    const values = splitCsvLine(line);
    if (values.length !== rawHeaders.length) {
      errors.push({
        rowNumber: r + 1,
        message: `Column count mismatch: expected ${rawHeaders.length} columns but found ${values.length}`
      });
      continue;
    }

    const rowObj: Record<string, string> = {};
    for (let c = 0; c < rawHeaders.length; c++) {
      const val = values[c].trim();
      rowObj[rawHeaders[c]] = val;
      rowObj[normHeaders[c]] = val;
    }
    rows.push(rowObj);
  }

  return { headers: normHeaders, rows, errors };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuote && next === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (char === ',' && !inQuote) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
