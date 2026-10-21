export type Format = "table" | "json" | "csv";
export type Row = Record<string, unknown>;

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function render(rows: Row[], format: Format, columns?: string[]): string {
  if (format === "json") return JSON.stringify(rows, (_, value) => typeof value === "bigint" ? value.toString() : value, 2);
  const headers = columns ?? Object.keys(rows[0] ?? {});
  if (!headers.length) return format === "table" ? "No results." : "";
  const data = rows.map((row) => headers.map((header) => stringify(row[header])));
  if (format === "csv") {
    const escape = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    return [headers, ...data].map((line) => line.map(escape).join(",")).join("\n");
  }
  const widths = headers.map((header, index) => Math.max(header.length, ...data.map((row) => row[index]!.length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...data.map(line)].join("\n");
}
