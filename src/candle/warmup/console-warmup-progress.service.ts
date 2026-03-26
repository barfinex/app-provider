import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { TimeFrame } from '@barfinex/types';

const PROGRESS_BAR_LEN = 20;
const FILL_CHAR = '█';
const EMPTY_CHAR = '░';
const TICK_MS = 100;

interface InstrumentProgress {
  symbol: string;
  interval: TimeFrame | string;
  total: number;
  written: number;
  startTime: number;
}

function progressKey(symbol: string, interval: TimeFrame | string): string {
  return `${symbol}|${String(interval)}`;
}

function formatRowsPerSec(rowsPerSec: number): string {
  if (rowsPerSec >= 1_000_000)
    return `${(rowsPerSec / 1_000_000).toFixed(1)}M/s`;
  if (rowsPerSec >= 1_000) return `${(rowsPerSec / 1_000).toFixed(0)}k/s`;
  if (rowsPerSec >= 1) return `${Math.round(rowsPerSec)}/s`;
  return '<1/s';
}

function progressBar(written: number, total: number): string {
  if (total <= 0) return EMPTY_CHAR.repeat(PROGRESS_BAR_LEN);
  const ratio = Math.min(1, written / total);
  const filled = Math.round(ratio * PROGRESS_BAR_LEN);
  return (
    FILL_CHAR.repeat(filled) + EMPTY_CHAR.repeat(PROGRESS_BAR_LEN - filled)
  );
}

@Injectable()
export class ConsoleWarmupProgressService implements OnModuleDestroy {
  private readonly instruments = new Map<string, InstrumentProgress>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tickTimer: any = null;
  private lastRenderedWidth = 0;
  private lastProgressSignature = '';
  private readonly isTty: boolean;

  constructor() {
    this.isTty =
      typeof process !== 'undefined' &&
      process.stdout != null &&
      Boolean(
        (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY,
      );
    this.patchStdoutForLiveProgress();
  }

  /** Register an instrument for warmup; total = total rows to write. */
  register(symbol: string, interval: TimeFrame | string, total: number): void {
    if (total <= 0) return;
    const key = progressKey(symbol, interval);
    this.instruments.set(key, {
      symbol,
      interval,
      total,
      written: 0,
      startTime: Date.now(),
    });
    if (!this.isTty) {
      (process.stdout as NodeJS.WriteStream).write(
        `[Warmup] ${symbol} ${String(interval)}: 0 / ${total} rows\n`,
      );
    }
    this.ensureTickerRunning();
  }

  /** Increment written rows for an instrument (call after each batch). */
  increment(symbol: string, interval: TimeFrame | string, delta: number): void {
    const key = progressKey(symbol, interval);
    const p = this.instruments.get(key);
    if (p) p.written = Math.min(p.total, p.written + delta);
  }

  /** Stop tracking this instrument (call when warmup for it finishes). */
  stop(symbol: string, interval: TimeFrame | string): void {
    const key = progressKey(symbol, interval);
    const p = this.instruments.get(key);
    this.instruments.delete(key);
    if (this.isTty && p != null) {
      this.writeLiveLine(this.formatInstrumentLine(p), true);
    }
    if (!this.isTty && p != null) {
      (process.stdout as NodeJS.WriteStream).write(
        `[Warmup] ${symbol} ${String(interval)}: ${p.written} / ${
          p.total
        } rows done\n`,
      );
    }
    if (this.instruments.size === 0) this.stopTicker();
  }

  private ensureTickerRunning(): void {
    if (this.tickTimer != null || !this.isTty) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  private stopTicker(): void {
    if (this.tickTimer != null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.lastProgressSignature = '';
    if (this.isTty && this.lastRenderedWidth > 0) {
      this.writeLiveLine('', true);
    }
  }

  private writeLiveLine(line: string, withNewLine = false): void {
    const stdout = process.stdout as NodeJS.WriteStream;
    const padLen = Math.max(0, this.lastRenderedWidth - line.length);
    const pad = padLen > 0 ? ' '.repeat(padLen) : '';
    stdout.write(`\r${line}${pad}${withNewLine ? '\n' : ''}`);
    this.lastRenderedWidth = withNewLine ? 0 : line.length;
  }

  /**
   * If a non-progress log arrives while live progress is on the line,
   * force a newline first so logs do not glue to the progress text.
   */
  private patchStdoutForLiveProgress(): void {
    if (!this.isTty) return;
    const stdout = process.stdout as NodeJS.WriteStream & {
      __warmupProgressPatched?: boolean;
      __warmupProgressOriginalWrite?: NodeJS.WriteStream['write'];
      write: NodeJS.WriteStream['write'];
    };
    if (stdout.__warmupProgressPatched) return;

    const originalWrite = stdout.write.bind(stdout);
    stdout.__warmupProgressOriginalWrite = originalWrite;
    stdout.write = ((chunk: unknown, ...args: unknown[]) => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
          ? (chunk as Buffer).toString()
          : '';
      if (
        this.lastRenderedWidth > 0 &&
        text.length > 0 &&
        !text.startsWith('\r')
      ) {
        originalWrite('\n');
        this.lastRenderedWidth = 0;
      }
      return (originalWrite as (...inner: unknown[]) => unknown)(
        chunk,
        ...args,
      );
    }) as NodeJS.WriteStream['write'];

    stdout.__warmupProgressPatched = true;
  }

  private formatInstrumentLine(p: InstrumentProgress): string {
    const elapsedSec = (Date.now() - p.startTime) / 1000;
    const rowsPerSec = elapsedSec > 0 ? p.written / elapsedSec : 0;
    const remaining = Math.max(0, p.total - p.written);
    const etaSec = rowsPerSec > 0 ? remaining / rowsPerSec : 0;
    const etaStr = etaSec >= 0.1 ? ` ETA ${etaSec.toFixed(1)}s` : '';
    const bar = progressBar(p.written, p.total);
    const rpsStr = formatRowsPerSec(rowsPerSec);
    return `${p.symbol.padEnd(10)} ${String(p.interval).padEnd(
      5,
    )} ${bar}  ${String(p.written).padStart(6)} / ${p.total}  ${rpsStr.padStart(
      6,
    )}${etaStr}`.trimEnd();
  }

  private tick(): void {
    if (this.instruments.size === 0) return;
    if (!this.isTty) return;

    let totalWritten = 0;
    let totalTotal = 0;
    let firstInstrument: InstrumentProgress | null = null;
    const signatureParts: string[] = [];

    for (const p of this.instruments.values()) {
      if (firstInstrument == null) firstInstrument = p;
      totalWritten += p.written;
      totalTotal += p.total;
      signatureParts.push(
        `${p.symbol}|${String(p.interval)}:${p.written}/${p.total}`,
      );
    }
    if (firstInstrument == null) return;
    const signature = signatureParts.join(';');
    if (signature === this.lastProgressSignature) return;
    this.lastProgressSignature = signature;

    const base = this.formatInstrumentLine(firstInstrument);
    const suffix =
      this.instruments.size > 1
        ? ` | total ${totalWritten}/${totalTotal} | active ${this.instruments.size}`
        : '';
    this.writeLiveLine(base + suffix);
  }

  onModuleDestroy(): void {
    this.stopTicker();
    this.instruments.clear();
  }
}
