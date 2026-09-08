import type { NewsItem, NewsSink } from "./types";

// KST, matching the UI. A VPS usually runs UTC, and an operator comparing this
// log against the news tab should not have to do the arithmetic.
const KST_HM = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

function timeLabel(ms: number): string {
  return KST_HM.format(ms);
}

/** Local visibility while the API/persistence path is not wired yet. */
export class ConsoleNewsSink implements NewsSink {
  publish(item: NewsItem): void {
    const scope = item.symbol ?? "MARKET";
    console.log(`[news] ${timeLabel(item.publishedAtMs)} ${scope} ${item.headline}`);
  }
}

/** Keeps the most recent items in memory for tests and manual inspection. */
export class RingBufferNewsSink implements NewsSink {
  private readonly items: NewsItem[] = [];

  constructor(private readonly capacity = 100) {}

  publish(item: NewsItem): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  list(): readonly NewsItem[] {
    return this.items;
  }
}

/** Fans one item out to several sinks; one failing sink must not stop the rest. */
export class CompositeNewsSink implements NewsSink {
  constructor(private readonly sinks: readonly NewsSink[]) {}

  publish(item: NewsItem): void {
    for (const sink of this.sinks) {
      try {
        void sink.publish(item);
      } catch (error) {
        console.error("[news] sink failed", error);
      }
    }
  }
}
