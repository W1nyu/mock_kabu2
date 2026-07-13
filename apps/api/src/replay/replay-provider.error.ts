/**
 * Errors from an isolated replay-data adapter. The explicit fallback flag
 * prevents malformed user files or local programming errors from being
 * silently presented as a successful bundled fixture.
 */
export class ReplayProviderError extends Error {
  constructor(
    message: string,
    readonly options: { cause?: unknown; allowFixtureFallback?: boolean } = {},
  ) {
    super(message);
    this.name = "ReplayProviderError";
  }

  get allowFixtureFallback(): boolean {
    return this.options.allowFixtureFallback === true;
  }
}
