import { Instrument } from '@barfinex/types';

const VALID_QUOTE_SUFFIX_REGEX = /(USDT|BUSD|FDUSD|USDC)$/;
const VALID_TRADING_PAIR_REGEX = /^[A-Z0-9]+(USDT|BUSD|FDUSD|USDC)$/;
const INVALID_CORRUPTED_USDT_SUFFIX_REGEX = /USDUSDT$/;
const STANDALONE_ASSETS = new Set(['USDT', 'BTC', 'ETH', 'BNB']);
const MIN_SYMBOL_LENGTH = 6;

export interface InstrumentSanitizerResult {
  validInstruments: string[];
  removedInstruments: string[];
}

export function normalizeInstrumentName(
  symbol: string | null | undefined,
): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase();
}

export function isValidInstrumentName(
  symbol: string | null | undefined,
): boolean {
  const normalized = normalizeInstrumentName(symbol);
  if (!normalized) return false;
  if (normalized.length < MIN_SYMBOL_LENGTH) return false;
  if (STANDALONE_ASSETS.has(normalized)) return false;
  if (INVALID_CORRUPTED_USDT_SUFFIX_REGEX.test(normalized)) return false;
  if (!VALID_QUOTE_SUFFIX_REGEX.test(normalized)) return false;
  return VALID_TRADING_PAIR_REGEX.test(normalized);
}

export function sanitizeInstrumentNames(
  symbols: string[],
): InstrumentSanitizerResult {
  const validInstruments: string[] = [];
  const removedInstruments: string[] = [];
  const seenValid = new Set<string>();
  const seenRemoved = new Set<string>();

  for (const raw of symbols) {
    const normalized = normalizeInstrumentName(raw);
    if (!normalized) continue;

    if (isValidInstrumentName(normalized)) {
      if (!seenValid.has(normalized)) {
        seenValid.add(normalized);
        validInstruments.push(normalized);
      }
      continue;
    }

    if (!seenRemoved.has(normalized)) {
      seenRemoved.add(normalized);
      removedInstruments.push(normalized);
    }
  }

  return { validInstruments, removedInstruments };
}

export function sanitizeInstruments(instruments: Instrument[]): {
  validInstruments: Instrument[];
  removedInstruments: string[];
} {
  const names = instruments.map((s) => s?.symbol ?? '');
  const { validInstruments, removedInstruments } = sanitizeInstrumentNames(names);
  const validSet = new Set(validInstruments);

  return {
    validInstruments: instruments.filter((s) =>
      validSet.has(normalizeInstrumentName(s?.symbol)),
    ),
    removedInstruments,
  };
}
