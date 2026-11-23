import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AlpacaBar } from '../src/contracts/alpaca.ts';
import { normalizeAlpacaBars } from '../src/utils/normalizeAlpacaBars.ts';

describe('normalizeAlpacaBars', () => {
  it('converts 3 ascending bars into NormalizedCandle objects', () => {
    const input: AlpacaBar[] = [
      {
        t: '2024-01-02T14:30:00Z',
        o: 185.5,
        h: 186.25,
        l: 185.1,
        c: 185.9,
        v: 1200,
        n: 45,
        vw: 185.75,
      },
      {
        t: '2024-01-02T14:31:00Z',
        o: 185.9,
        h: 186.4,
        l: 185.8,
        c: 186.1,
        v: 950,
        n: 32,
        vw: 186.05,
      },
      {
        t: '2024-01-02T14:32:00Z',
        o: 186.1,
        h: 186.5,
        l: 185.95,
        c: 186.35,
        v: 1500,
        n: 51,
        vw: 186.22,
      },
    ];

    const result = normalizeAlpacaBars(input);

    assert.deepEqual(result, [
      {
        time: 1704205800,
        open: 185.5,
        high: 186.25,
        low: 185.1,
        close: 185.9,
        volume: 1200,
      },
      {
        time: 1704205860,
        open: 185.9,
        high: 186.4,
        low: 185.8,
        close: 186.1,
        volume: 950,
      },
      {
        time: 1704205920,
        open: 186.1,
        high: 186.5,
        low: 185.95,
        close: 186.35,
        volume: 1500,
      },
    ]);
  });

  it('sorts out-of-order bars ascending by Unix seconds', () => {
    const input: AlpacaBar[] = [
      {
        t: '2024-01-02T14:32:00Z',
        o: 186.1,
        h: 186.5,
        l: 185.95,
        c: 186.35,
        v: 1500,
        n: 51,
        vw: 186.22,
      },
      {
        t: '2024-01-02T14:31:00Z',
        o: 185.9,
        h: 186.4,
        l: 185.8,
        c: 186.1,
        v: 950,
        n: 32,
        vw: 186.05,
      },
      {
        t: '2024-01-02T14:30:00Z',
        o: 185.5,
        h: 186.25,
        l: 185.1,
        c: 185.9,
        v: 1200,
        n: 45,
        vw: 185.75,
      },
    ];

    const result = normalizeAlpacaBars(input);

    assert.deepEqual(
      result.map((c) => c.time),
      [1704205800, 1704205860, 1704205920],
    );
    assert.equal(result[0].close, 185.9);
    assert.equal(result[2].close, 186.35);
  });

  it('deduplicates identical timestamps keeping the last bar', () => {
    const input: AlpacaBar[] = [
      {
        t: '2024-01-02T14:30:00Z',
        o: 185.5,
        h: 186.0,
        l: 185.0,
        c: 185.8,
        v: 1000,
        n: 40,
        vw: 185.6,
      },
      {
        t: '2024-01-02T14:30:00Z',
        o: 185.5,
        h: 186.25,
        l: 185.0,
        c: 186.15,
        v: 1350,
        n: 52,
        vw: 185.9,
      },
    ];

    const result = normalizeAlpacaBars(input);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      time: 1704205800,
      open: 185.5,
      high: 186.25,
      low: 185.0,
      close: 186.15,
      volume: 1350,
    });
  });

  it('throws when required field o is missing', () => {
    const malformed = [
      {
        t: '2024-01-02T14:30:00Z',
        h: 186.25,
        l: 185.1,
        c: 185.9,
        v: 1200,
        n: 45,
        vw: 185.75,
      },
    ] as unknown as AlpacaBar[];

    assert.throws(() => normalizeAlpacaBars(malformed), /missing required numeric field "o"/);
  });

  it('throws when close price c is NaN', () => {
    const nonFinite: AlpacaBar[] = [
      {
        t: '2024-01-02T14:30:00Z',
        o: 185.5,
        h: 186.25,
        l: 185.1,
        c: Number.NaN,
        v: 1200,
        n: 45,
        vw: 185.75,
      },
    ];

    assert.throws(() => normalizeAlpacaBars(nonFinite), /non-finite "c"/);
  });
});
