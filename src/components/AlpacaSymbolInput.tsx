import { useState, type FormEvent } from 'react';
import { AlertCircle, RefreshCw, Search } from 'lucide-react';
import { ProxyRequestError, validateAlpacaSymbol } from '../api/alpacaApi';
import { formatTimestamp } from '../utils/format';

const SYMBOL_REGEX = /^[A-Z]{1,10}$/;
const NOT_CONFIGURED_MESSAGE =
  'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment';

interface AlpacaSymbolInputProps {
  selectedSymbol: string | null;
  recentSymbols: string[];
  configured: boolean | null;
  onSelectSymbol: (symbol: string) => void;
  onAfterValidate?: () => void;
}

export function AlpacaSymbolInput({
  selectedSymbol,
  recentSymbols,
  configured,
  onSelectSymbol,
  onAfterValidate,
}: AlpacaSymbolInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState<{
    message: string;
    timestamp: string;
  } | null>(null);

  const isDisabled = configured === false || isValidating;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (configured === false || isValidating) return;

    const candidate = inputValue.trim().toUpperCase();
    if (!SYMBOL_REGEX.test(candidate)) {
      setValidationError({
        message: 'Enter a valid US equity ticker (1–10 uppercase letters A–Z).',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    setIsValidating(true);
    setValidationError(null);

    try {
      const res = await validateAlpacaSymbol(candidate);
      onAfterValidate?.();
      if (res.data.valid) {
        onSelectSymbol(res.data.symbol);
        setInputValue(res.data.symbol);
      }
    } catch (err) {
      onAfterValidate?.();
      if (err instanceof ProxyRequestError) {
        setValidationError({
          message: err.message,
          timestamp: err.timestamp,
        });
      } else {
        setValidationError({
          message: err instanceof Error ? err.message : 'Symbol validation failed',
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      setIsValidating(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col justify-between">
      <div className="space-y-4 p-4">
        {configured === false && (
          <div
            role="status"
            className="rounded-md border border-slate-700/80 bg-[#0B1120] p-3 text-xs text-slate-300"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span>{NOT_CONFIGURED_MESSAGE}</span>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-2.5">
          <label
            htmlFor="alpaca-symbol-input"
            className="block text-xs font-medium text-slate-300"
          >
            US Equity Ticker
          </label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                id="alpaca-symbol-input"
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value.toUpperCase())}
                placeholder="Type ticker (A–Z)"
                maxLength={10}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                disabled={isDisabled}
                aria-label="Alpaca US equity ticker symbol"
                className="w-full rounded-md border border-slate-800 bg-[#0B1120] py-1.5 pl-8 pr-2.5 font-mono text-xs uppercase text-slate-100 placeholder:normal-case placeholder:font-sans placeholder:text-slate-500 focus:border-sky-500/70 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <button
              type="submit"
              disabled={isDisabled}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-700 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isValidating && (
                <RefreshCw className="h-3 w-3 animate-spin text-sky-400" aria-hidden="true" />
              )}
              <span>Load</span>
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Validated live via Alpaca latest trade lookup before loading charts.
          </p>
        </form>

        {validationError && (
          <div
            role="alert"
            className="rounded-md border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-200"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-rose-100">Symbol validation failed</p>
                <p className="break-words text-rose-300/90">{validationError.message}</p>
                <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                  At {formatTimestamp(validationError.timestamp)}
                </p>
              </div>
            </div>
          </div>
        )}

        {recentSymbols.length > 0 && (
          <div className="space-y-2 border-t border-slate-800/70 pt-3">
            <div className="text-[11px] font-medium text-slate-400">
              Loaded this session
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recentSymbols.map((sym) => {
                const active = sym === selectedSymbol;
                return (
                  <button
                    key={sym}
                    type="button"
                    disabled={configured === false}
                    onClick={() => {
                      setInputValue(sym);
                      setValidationError(null);
                      onSelectSymbol(sym);
                    }}
                    className={`rounded-md border px-2.5 py-1 font-mono text-xs font-medium whitespace-nowrap transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? 'border-sky-500/50 bg-sky-950/50 text-sky-200'
                        : 'border-slate-800 bg-[#0B1120] text-slate-300 hover:border-slate-700 hover:text-slate-100'
                    }`}
                  >
                    {sym}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
