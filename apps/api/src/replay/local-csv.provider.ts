import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ReplayProviderError } from "./replay-provider.error";
import { selectReplayRange } from "./replay-range";
import type { ReplayCandle, ReplayDataset, ReplayHistoricalSourceResult, ReplayRange } from "./replay.types";

const MAX_CSV_BYTES = 20 * 1024 * 1024;

/**
 * Explicit opt-in adapter for data the user has already obtained with the
 * necessary rights. It never accepts a file path from HTTP input.
 */
export class LocalCsvReplayProvider {
  private readonly directory: string | undefined;

  constructor(directory: string | undefined) {
    this.directory = directory?.trim() || undefined;
  }

  isConfigured(): boolean {
    return this.directory !== undefined;
  }

  /** Returns null only when a configured directory has no file for this dataset. */
  async dailyIfPresent(dataset: ReplayDataset, range: ReplayRange): Promise<ReplayHistoricalSourceResult | null> {
    if (!this.directory) return null;

    const root = await this.resolvedRoot();
    const filename = datasetCsvFilename(dataset);
    const requestedPath = resolve(root, filename);
    assertInside(root, requestedPath);

    let actualPath: string;
    try {
      actualPath = await realpath(requestedPath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw localError("리플레이 CSV 파일을 확인하지 못했습니다.", error);
    }
    // A symlink must not be able to escape the user-selected source directory.
    assertInside(root, actualPath);

    try {
      const info = await stat(actualPath);
      if (!info.isFile()) throw localError("리플레이 CSV 경로가 일반 파일이 아닙니다.");
      if (info.size > MAX_CSV_BYTES) {
        throw localError(`리플레이 CSV는 ${MAX_CSV_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
      }
      const candles = selectReplayRange(parseLocalReplayCsv(await readFile(actualPath, "utf8")), range);
      if (candles.length === 0) throw localError("선택한 기간에 사용할 수 있는 로컬 CSV 일봉이 없습니다.");
      return {
        provider: "local-csv",
        label: "사용자 제공 로컬 CSV 일봉",
        // Do not disclose an absolute local path to the browser.
        sourceUrl: `local://replay-csv/${encodeURIComponent(filename)}`,
        termsUrl: null,
        notice:
          "REPLAY_HISTORICAL_CSV_DIR에서 읽은 사용자 제공 데이터입니다. 파일의 취득·보관·재배포 권한은 사용자가 확인해야 합니다.",
        currency: dataset.currency,
        candles,
      };
    } catch (error) {
      if (error instanceof ReplayProviderError) throw error;
      throw localError("리플레이 CSV를 읽지 못했습니다.", error);
    }
  }

  private async resolvedRoot(): Promise<string> {
    try {
      const root = await realpath(resolve(this.directory!));
      const info = await stat(root);
      if (!info.isDirectory()) throw localError("REPLAY_HISTORICAL_CSV_DIR는 디렉터리여야 합니다.");
      return root;
    } catch (error) {
      if (error instanceof ReplayProviderError) throw error;
      throw localError("REPLAY_HISTORICAL_CSV_DIR를 확인하지 못했습니다.", error);
    }
  }
}

/** Dataset ids are catalog-owned, but retain a strict filename allow-list anyway. */
export function datasetCsvFilename(dataset: ReplayDataset): string {
  if (!/^[a-z0-9-]+$/.test(dataset.id)) {
    throw localError("안전하지 않은 리플레이 dataset id입니다.");
  }
  return `${dataset.id}.csv`;
}

/**
 * Required CSV header: date (or timestamp), open, high, low, close.
 * `volume` is optional. Prices are decimal USD and become integer cents.
 */
export function parseLocalReplayCsv(source: string): ReplayCandle[] {
  const rows = parseCsv(source);
  if (rows.length < 2) throw localError("리플레이 CSV에는 헤더와 하나 이상의 데이터 행이 필요합니다.");

  const header = rows[0]!.map(normalizeHeader);
  const dateIndex = findHeader(header, ["date", "timestamp", "ts", "datetime"]);
  const openIndex = findHeader(header, ["open"]);
  const highIndex = findHeader(header, ["high"]);
  const lowIndex = findHeader(header, ["low"]);
  const closeIndex = findHeader(header, ["close"]);
  const volumeIndex = findHeader(header, ["volume"]);
  if ([dateIndex, openIndex, highIndex, lowIndex, closeIndex].some((index) => index === undefined)) {
    throw localError("리플레이 CSV 헤더에는 date/timestamp, open, high, low, close가 모두 필요합니다.");
  }

  const candles = new Map<number, ReplayCandle>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const ts = csvTimestamp(row[dateIndex!]);
    const open = csvMinor(row[openIndex!]);
    const high = csvMinor(row[highIndex!]);
    const low = csvMinor(row[lowIndex!]);
    const close = csvMinor(row[closeIndex!]);
    if (!ts || !open || !high || !low || !close) {
      throw localError(`리플레이 CSV ${rowIndex + 1}행의 날짜 또는 OHLC 값이 유효하지 않습니다.`);
    }
    if (low > Math.min(open, close) || high < Math.max(open, close)) {
      throw localError(`리플레이 CSV ${rowIndex + 1}행의 OHLC 관계가 올바르지 않습니다.`);
    }
    if (candles.has(ts)) throw localError(`리플레이 CSV에 중복 날짜가 있습니다 (${row[dateIndex!] ?? ""}).`);
    candles.set(ts, {
      ts,
      open,
      high,
      low,
      close,
      volume: volumeIndex === undefined ? 0 : csvVolume(row[volumeIndex]),
    });
  }

  const normalized = [...candles.values()].sort((a, b) => a.ts - b.ts);
  if (normalized.length === 0) throw localError("리플레이 CSV에 유효한 일봉이 없습니다.");
  return normalized;
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (quoted) throw localError("리플레이 CSV의 따옴표가 닫히지 않았습니다.");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[ _-]/g, "");
}

function findHeader(header: readonly string[], aliases: readonly string[]): number | undefined {
  const index = header.findIndex((value) => aliases.includes(value));
  return index >= 0 ? index : undefined;
}

function csvTimestamp(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d{13}$/.test(trimmed)) return safeTimestamp(Number(trimmed));
  if (/^\d{10}$/.test(trimmed)) return safeTimestamp(Number(trimmed) * 1_000);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const ts = Date.UTC(year, month - 1, day);
    const parsed = new Date(ts);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
      ? ts
      : undefined;
  }
  return safeTimestamp(Date.parse(trimmed));
}

function csvMinor(value: string | undefined): number | undefined {
  const numeric = csvNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const cents = Math.round(numeric * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : undefined;
}

function csvVolume(value: string | undefined): number {
  const numeric = csvNumber(value);
  if (numeric === undefined || numeric <= 0) return 0;
  return Math.min(Math.trunc(numeric), Number.MAX_SAFE_INTEGER);
}

function csvNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/,/g, "");
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function safeTimestamp(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function assertInside(root: string, candidate: string): void {
  const pathToCandidate = relative(root, candidate);
  if (!pathToCandidate || pathToCandidate.startsWith("..") || isAbsolute(pathToCandidate)) {
    throw localError("리플레이 CSV 경로가 설정된 디렉터리 밖을 가리킵니다.");
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function localError(message: string, cause?: unknown): ReplayProviderError {
  return new ReplayProviderError(message, { cause, allowFixtureFallback: false });
}
