import { Symbol } from '@barfinex/types';

const VALID_QUOTE_SUFFIX_REGEX = /(USDT|BUSD|FDUSD|USDC)$/;
const VALID_TRADING_PAIR_REGEX = /^[A-Z0-9]+(USDT|BUSD|FDUSD|USDC)$/;
const INVALID_CORRUPTED_USDT_SUFFIX_REGEX = /USDUSDT$/;
const STANDALONE_ASSETS = new Set(['USDT', 'BTC', 'ETH', 'BNB']);
const MIN_SYMBOL_LENGTH = 6;

export interface SymbolSanitizerResult {
    validSymbols: string[];
    removedSymbols: string[];
}

export function normalizeTradingSymbol(symbol: string | null | undefined): string {
    return String(symbol ?? '').trim().toUpperCase();
}

export function isValidTradingSymbol(symbol: string | null | undefined): boolean {
    const normalized = normalizeTradingSymbol(symbol);
    if (!normalized) return false;
    if (normalized.length < MIN_SYMBOL_LENGTH) return false;
    if (STANDALONE_ASSETS.has(normalized)) return false;
    if (INVALID_CORRUPTED_USDT_SUFFIX_REGEX.test(normalized)) return false;
    if (!VALID_QUOTE_SUFFIX_REGEX.test(normalized)) return false;
    return VALID_TRADING_PAIR_REGEX.test(normalized);
}

export function sanitizeTradingSymbols(symbols: string[]): SymbolSanitizerResult {
    const validSymbols: string[] = [];
    const removedSymbols: string[] = [];
    const seenValid = new Set<string>();
    const seenRemoved = new Set<string>();

    for (const raw of symbols) {
        const normalized = normalizeTradingSymbol(raw);
        if (!normalized) continue;

        if (isValidTradingSymbol(normalized)) {
            if (!seenValid.has(normalized)) {
                seenValid.add(normalized);
                validSymbols.push(normalized);
            }
            continue;
        }

        if (!seenRemoved.has(normalized)) {
            seenRemoved.add(normalized);
            removedSymbols.push(normalized);
        }
    }

    return { validSymbols, removedSymbols };
}

export function sanitizeTradingSymbolObjects(symbols: Symbol[]): {
    validSymbols: Symbol[];
    removedSymbols: string[];
} {
    const names = symbols.map((s) => s?.name ?? '');
    const { validSymbols, removedSymbols } = sanitizeTradingSymbols(names);
    const validSet = new Set(validSymbols);

    return {
        validSymbols: symbols.filter((s) => validSet.has(normalizeTradingSymbol(s?.name))),
        removedSymbols,
    };
}
