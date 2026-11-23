import WebSocket from 'ws';
import { normalizeTickerRecord, toNullableNumber } from './deltaClient.ts';
import type {
  CandlePriceBasis,
  CandleResolution,
  DeltaStreamEvent,
  DeltaWsConnectionState,
} from '../src/contracts/delta.ts';

export const DELTA_WS_URL = 'wss://socket.india.delta.exchange';

interface StreamSubscriber {
  id: string;
  symbol: string;
  resolution: CandleResolution;
  basis: CandlePriceBasis;
  querySymbol: string;
  send: (event: DeltaStreamEvent) => void;
}

class DeltaStreamManager {
  private ws: WebSocket | null = null;
  private state: DeltaWsConnectionState = 'disconnected';
  private subscribers = new Map<string, StreamSubscriber>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private lastWsMessageAt: string | null = null;
  private lastWsError: string | null = null;
  private loggedWsTypes = new Set<string>();
  private activeTickerSymbols = new Set<string>();
  private activeCandleSubscriptions = new Set<string>(); // `${resolution}|${querySymbol}`

  addSubscriber(sub: StreamSubscriber): () => void {
    this.subscribers.set(sub.id, sub);
    this.ensureConnected();
    this.syncSubscriptions();

    sub.send({
      type: 'health',
      wsState: this.state,
      timestamp: new Date().toISOString(),
    });

    return () => {
      this.subscribers.delete(sub.id);
      this.syncSubscriptions();
      if (this.subscribers.size === 0) {
        this.teardown();
      }
    };
  }

  getTelemetry() {
    return {
      wsState: this.state,
      lastWsMessageAt: this.lastWsMessageAt,
      lastWsError: this.lastWsError,
      activeSubscribers: this.subscribers.size,
    };
  }

  private setState(next: DeltaWsConnectionState, message?: string): void {
    this.state = next;
    const event: DeltaStreamEvent = {
      type: 'health',
      wsState: next,
      message,
      timestamp: new Date().toISOString(),
    };
    for (const sub of this.subscribers.values()) {
      sub.send(event);
    }
  }

  private ensureConnected(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(DELTA_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastWsError = null;
      this.activeTickerSymbols.clear();
      this.activeCandleSubscriptions.clear();
      this.setState('connected');
      this.syncSubscriptions();
      this.startHeartbeat();
    });

    ws.on('message', (data) => {
      this.lastWsMessageAt = new Date().toISOString();
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(parsed);
      } catch {
        // Ignore malformed frame
      }
    });

    ws.on('error', (err) => {
      this.lastWsError = err.message || 'Delta WebSocket error';
      this.setState('error', this.lastWsError);
    });

    ws.on('close', () => {
      this.stopHeartbeat();
      this.ws = null;
      this.activeTickerSymbols.clear();
      this.activeCandleSubscriptions.clear();
      if (this.subscribers.size > 0) {
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.subscribers.size === 0) {
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000);
    this.setState('reconnecting', `Reconnecting in ${Math.round(delayMs / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0) {
        this.ensureConnected();
      }
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.activeTickerSymbols.clear();
    this.activeCandleSubscriptions.clear();
    this.state = 'disconnected';
  }

  private syncSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const desiredTickers = new Set<string>();
    const desiredCandles = new Set<string>();

    for (const sub of this.subscribers.values()) {
      desiredTickers.add(sub.symbol);
      desiredCandles.add(`${sub.resolution}|${sub.querySymbol}`);
    }

    const toSubscribe: Array<{ name: string; symbols: string[] }> = [];
    const toUnsubscribe: Array<{ name: string; symbols: string[] }> = [];

    const addedTickers = Array.from(desiredTickers).filter((s) => !this.activeTickerSymbols.has(s));
    const removedTickers = Array.from(this.activeTickerSymbols).filter((s) => !desiredTickers.has(s));

    if (addedTickers.length > 0) {
      toSubscribe.push({ name: 'v2/ticker', symbols: addedTickers });
      addedTickers.forEach((s) => this.activeTickerSymbols.add(s));
    }
    if (removedTickers.length > 0) {
      toUnsubscribe.push({ name: 'v2/ticker', symbols: removedTickers });
      removedTickers.forEach((s) => this.activeTickerSymbols.delete(s));
    }

    const addedCandles = Array.from(desiredCandles).filter(
      (k) => !this.activeCandleSubscriptions.has(k),
    );
    const removedCandles = Array.from(this.activeCandleSubscriptions).filter(
      (k) => !desiredCandles.has(k),
    );

    const groupByRes = (keys: string[]) => {
      const grouped = new Map<string, string[]>();
      for (const key of keys) {
        const [res, sym] = key.split('|');
        const list = grouped.get(res) || [];
        list.push(sym);
        grouped.set(res, list);
      }
      return grouped;
    };

    for (const [res, syms] of groupByRes(addedCandles).entries()) {
      toSubscribe.push({ name: `candlestick_${res}`, symbols: syms });
    }
    addedCandles.forEach((k) => this.activeCandleSubscriptions.add(k));

    for (const [res, syms] of groupByRes(removedCandles).entries()) {
      toUnsubscribe.push({ name: `candlestick_${res}`, symbols: syms });
    }
    removedCandles.forEach((k) => this.activeCandleSubscriptions.delete(k));

    if (toUnsubscribe.length > 0) {
      this.ws.send(
        JSON.stringify({
          type: 'unsubscribe',
          payload: { channels: toUnsubscribe },
        }),
      );
    }

    if (toSubscribe.length > 0) {
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: { channels: toSubscribe },
        }),
      );
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const msgType = typeof msg.type === 'string' ? msg.type : '';
    if (!msgType || msgType === 'pong' || msgType === 'subscriptions') {
      return;
    }

    if (!this.loggedWsTypes.has(msgType)) {
      this.loggedWsTypes.add(msgType);
      console.log(`[DeltaStream] Inspected WS ${msgType} keys:`, Object.keys(msg));
    }

    if (msgType === 'v2/ticker') {
      const symbol = typeof msg.symbol === 'string' ? msg.symbol : '';
      if (!symbol) return;
      const ticker = normalizeTickerRecord(msg, symbol);
      const event: DeltaStreamEvent = {
        type: 'ticker',
        symbol,
        ticker,
        source: 'Delta Exchange WS v2/ticker',
        timestamp: new Date().toISOString(),
      };
      for (const sub of this.subscribers.values()) {
        if (sub.symbol === symbol) {
          sub.send(event);
        }
      }
      return;
    }

    if (msgType.startsWith('candlestick_')) {
      const resolution = msgType.replace('candlestick_', '') as CandleResolution;
      const querySymbol = typeof msg.symbol === 'string' ? msg.symbol : '';
      const candleStartUs = toNullableNumber(msg.candle_start_time);
      const open = toNullableNumber(msg.open);
      const high = toNullableNumber(msg.high);
      const low = toNullableNumber(msg.low);
      const close = toNullableNumber(msg.close);
      const volume = toNullableNumber(msg.volume) ?? 0;

      if (
        !querySymbol ||
        candleStartUs === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null
      ) {
        return;
      }

      const timeSeconds = Math.floor(candleStartUs / 1_000_000);
      const candle = { time: timeSeconds, open, high, low, close, volume };

      for (const sub of this.subscribers.values()) {
        if (sub.resolution === resolution && sub.querySymbol === querySymbol) {
          sub.send({
            type: 'candle',
            symbol: sub.symbol,
            querySymbol,
            resolution,
            basis: sub.basis,
            candle,
            source: `Delta Exchange WS ${msgType}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }
}

export const deltaStreamManager = new DeltaStreamManager();
