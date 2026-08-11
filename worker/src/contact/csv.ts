/**
 * CSV, to RFC 4180, because the records these files hold are written by
 * strangers.
 *
 * A contact message contains commas and quotation marks as a matter of course
 * and newlines whenever somebody presses Enter, so "join with commas" would
 * produce a file that cannot be read back — and, worse, one where a visitor
 * could choose how many columns their own row appears to have. Quoting is not a
 * nicety here; it is the boundary between a record and an injection.
 *
 * Deliberately small: no streaming, no type coercion, no header handling. These
 * files are read whole, changed, and written whole, which is what conditional
 * writes on R2 can be made safe.
 */

/** Quoted when it has to be, bare when it does not, and never ambiguous either way. */
function encodeField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/** One row, terminated. CRLF is what the RFC says, and what a spreadsheet expects. */
export function csvRow(fields: readonly string[]): string {
  return `${fields.map(encodeField).join(",")}\r\n`;
}

export function csvText(rows: readonly (readonly string[])[]): string {
  return rows.map(csvRow).join("");
}

/**
 * Rows, in the order they were written.
 *
 * A trailing newline does not produce a final empty row, and neither does a file
 * that is entirely empty. Anything malformed — an unterminated quote at the end
 * of the file — yields what was parsed up to that point rather than throwing:
 * one corrupt tail must not make the whole record unreadable.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // A doubled quote is an escaped one; a lone quote closes the field.
      if (text[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      started = true;
      continue;
    }

    if (char === "\n" || char === "\r") {
      // \r\n is one terminator, not two.
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (started || field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      started = false;
      continue;
    }

    field += char;
    started = true;
  }

  if (started || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
