/**
 * 행 배열을 CSV 문자열로. 쉼표·따옴표·줄바꿈이 든 값은 따옴표로 감싸고 내부 따옴표는 두 번 쓴다.
 * Excel이 한글을 깨뜨리지 않도록 UTF-8 BOM으로 시작한다.
 */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined) => {
    if (value == null) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "\uFEFF" + [header, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}
