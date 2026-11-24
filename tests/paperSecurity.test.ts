import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ExplainStructuredOutput } from '../src/contracts/explain.ts';
import type { PaperTradeExplainRequest } from '../src/contracts/explain.ts';
import {
  validateExplainOutput,
  validatePaperTradeExplainOutput,
} from '../src/engine/explainGuard.ts';
import {
  FirebaseAuthError,
  verifyFirebaseTokenWithCerts,
} from '../server/firebaseTokenVerifier.ts';
import {
  PaperStoreError,
  restoreUserPaperSession,
} from '../server/paper/paperStore.ts';
import {
  validateCreateSessionInput,
  validateRestoreSnapshotInput,
  validateSubmitOrderInput,
  validateWalkForwardInput,
} from '../server/paper/validators.ts';
import { createPaperSessionState, buildContractSpecFromProduct } from '../src/engine/paperBrokerEngine.ts';
import type { DeltaProductSummary } from '../src/contracts/delta.ts';

function b64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generateTestCertAndKey(): { certPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // Create a self-signed X.509 cert via openssl if available, else verify Node crypto cert generation
  try {
    const tmpDir = fs.mkdtempSync('/tmp/jwt-test-');
    const keyPath = path.join(tmpDir, 'key.pem');
    const certPath = path.join(tmpDir, 'cert.pem');
    fs.writeFileSync(keyPath, privateKeyPem, 'utf8');
    execFileSync('openssl', [
      'req',
      '-new',
      '-x509',
      '-key',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=test-firebase-signer',
    ]);
    const certPem = fs.readFileSync(certPath, 'utf8');
    // Sanity parse with X509Certificate
    new X509Certificate(certPem);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { certPem, privateKeyPem };
  } catch {
    // Fallback to publicKey PEM (createVerify accepts SPKI PEM as well as X.509 cert PEM)
    return {
      certPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem,
    };
  }
}

function signJwt(
  payload: Record<string, unknown>,
  privateKeyPem: string,
  kid = 'kid-1',
): string {
  const header = b64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64Url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = b64Url(signer.sign(privateKeyPem));
  return `${header}.${body}.${sig}`;
}

describe('Zero-Admin-SDK Firebase ID token verifier', () => {
  const projectId = 'test-project-123';
  const nowSec = 1_750_000_000;
  const { certPem, privateKeyPem } = generateTestCertAndKey();
  const certs = { 'kid-1': certPem };

  it('verifies valid RS256 token claims and returns verified user', () => {
    const token = signJwt(
      {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'uid_abc_123',
        email: 'trader@example.com',
        email_verified: true,
        iat: nowSec - 60,
        exp: nowSec + 3600,
      },
      privateKeyPem,
    );
    const verified = verifyFirebaseTokenWithCerts(token, certs, projectId, nowSec);
    assert.equal(verified.uid, 'uid_abc_123');
    assert.equal(verified.email, 'trader@example.com');
    assert.equal(verified.emailVerified, true);
  });

  it('rejects expired, wrong audience, wrong issuer, forged signature, and unverified email', () => {
    const basePayload = {
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      sub: 'uid_abc_123',
      email: 'trader@example.com',
      email_verified: true,
      iat: nowSec - 60,
      exp: nowSec + 3600,
    };

    // Expired
    const expToken = signJwt({ ...basePayload, exp: nowSec - 1 }, privateKeyPem);
    assert.throws(
      () => verifyFirebaseTokenWithCerts(expToken, certs, projectId, nowSec),
      (e: unknown) => e instanceof FirebaseAuthError && e.status === 401 && e.code === 'TOKEN_EXPIRED',
    );

    // Wrong aud
    const audToken = signJwt({ ...basePayload, aud: 'other-proj' }, privateKeyPem);
    assert.throws(
      () => verifyFirebaseTokenWithCerts(audToken, certs, projectId, nowSec),
      (e: unknown) => e instanceof FirebaseAuthError && e.status === 401,
    );

    // Wrong iss
    const issToken = signJwt({ ...basePayload, iss: 'https://evil.example.com' }, privateKeyPem);
    assert.throws(
      () => verifyFirebaseTokenWithCerts(issToken, certs, projectId, nowSec),
      (e: unknown) => e instanceof FirebaseAuthError && e.status === 401,
    );

    // Tampered payload -> signature invalid
    const valid = signJwt(basePayload, privateKeyPem);
    const parts = valid.split('.');
    const forgedPayload = b64Url(JSON.stringify({ ...basePayload, sub: 'attacker_uid' }));
    assert.throws(
      () =>
        verifyFirebaseTokenWithCerts(`${parts[0]}.${forgedPayload}.${parts[2]}`, certs, projectId, nowSec),
      (e: unknown) => e instanceof FirebaseAuthError && e.status === 401 && e.code === 'INVALID_SIGNATURE',
    );

    // email_verified === false -> 403
    const unverifiedToken = signJwt({ ...basePayload, email_verified: false }, privateKeyPem);
    assert.throws(
      () => verifyFirebaseTokenWithCerts(unverifiedToken, certs, projectId, nowSec),
      (e: unknown) => e instanceof FirebaseAuthError && e.status === 403 && e.code === 'EMAIL_NOT_VERIFIED',
    );
  });
});

describe('Hand-written server validators (zero zod)', () => {
  it('validates session create, order submit, walk-forward, and restore snapshot payloads', () => {
    const okCreate = validateCreateSessionInput({
      symbol: 'BTCUSD',
      resolution: '15m',
      startingBalanceUsdt: '10000',
      resetTimeZone: 'Asia/Kolkata',
    });
    assert.equal(okCreate.ok, true);

    const badTz = validateCreateSessionInput({
      symbol: 'BTCUSD',
      resolution: '15m',
      resetTimeZone: 'Mars/Olympus',
    });
    assert.equal(badTz.ok, false);

    const badLimit = validateSubmitOrderInput({
      clientOrderId: 'ord_1',
      side: 'BUY',
      type: 'LIMIT',
      contracts: 2,
      limitPriceTicks: null,
    });
    assert.equal(badLimit.ok, false);

    const okWf = validateWalkForwardInput({ fixedHalfSpreadTicks: 4, lookbackBars: 600 });
    assert.equal(okWf.ok, true);

    const product: DeltaProductSummary = {
      id: 27,
      symbol: 'BTCUSD',
      description: 'BTC Perp',
      shortDescription: null,
      contractType: 'perpetual_futures',
      underlyingSymbol: 'BTC',
      settlingSymbol: 'USDT',
      strikePrice: null,
      settlementTime: null,
      tickSize: '0.5',
      contractValue: '0.001',
      makerCommissionRate: '0.0002',
      takerCommissionRate: '0.0005',
      initialMargin: '0.5',
      initialMarginScalingFactor: '0',
      maintenanceMargin: '0.25',
      maintenanceMarginScalingFactor: '0',
      liquidationPenaltyFactor: '0.5',
      defaultLeverage: '20',
      positionSizeLimit: 100000,
      tradingStatus: 'operational',
      rateExchangeInterval: 28800,
      sortPriority: 1,
    };
    const snap = createPaperSessionState({
      sessionId: 'sess_restore_1',
      uid: 'uid_owner',
      contract: buildContractSpecFromProduct(product),
      resolution: '15m',
      createdAtSec: 1_700_000_000,
    });
    const okRestore = validateRestoreSnapshotInput(snap, 'sess_restore_1', 'uid_owner');
    assert.equal(okRestore.ok, true);

    const badRestoreOwner = validateRestoreSnapshotInput(snap, 'sess_restore_1', 'other_uid');
    assert.equal(badRestoreOwner.ok, false);

    // Reject missing, zero, or non-integer sessionVersion
    const badVersionSnap = {
      ...snap,
      account: { ...snap.account, sessionVersion: 0 },
    };
    assert.equal(validateRestoreSnapshotInput(badVersionSnap, 'sess_restore_1', 'uid_owner').ok, false);

    // Reject invalid rateExchangeIntervalSource
    const badSourceSnap = {
      ...snap,
      contract: { ...snap.contract, rateExchangeIntervalSource: 'unknown' },
    };
    assert.equal(validateRestoreSnapshotInput(badSourceSnap, 'sess_restore_1', 'uid_owner').ok, false);
  });

  it('rejects stale snapshot restores with 409 STALE_SESSION_VERSION when incoming sessionVersion is older', async () => {
    const product: DeltaProductSummary = {
      id: 27,
      symbol: 'BTCUSD',
      description: 'BTC Perp',
      shortDescription: null,
      contractType: 'perpetual_futures',
      underlyingSymbol: 'BTC',
      settlingSymbol: 'USDT',
      strikePrice: null,
      settlementTime: null,
      tickSize: '0.5',
      contractValue: '0.001',
      makerCommissionRate: '0.0002',
      takerCommissionRate: '0.0005',
      initialMargin: '0.5',
      initialMarginScalingFactor: '0',
      maintenanceMargin: '0.25',
      maintenanceMarginScalingFactor: '0',
      liquidationPenaltyFactor: '0.5',
      defaultLeverage: '20',
      positionSizeLimit: 100000,
      tradingStatus: 'operational',
      rateExchangeInterval: 28800,
      sortPriority: 1,
    };
    const oldAnchorSec = 1_700_000_000;
    const snapV2 = createPaperSessionState({
      sessionId: 'sess_stale_ver_test',
      uid: 'uid_ver_guard',
      contract: buildContractSpecFromProduct(product),
      resolution: '15m',
      createdAtSec: oldAnchorSec,
    });
    snapV2.account.sessionVersion = 2;

    const firstRestore = await restoreUserPaperSession('uid_ver_guard', 'sess_stale_ver_test', snapV2);
    assert.equal(firstRestore.state.account.stale, true);
    assert.ok(firstRestore.state.account.sessionVersion >= 3);

    const olderSnapV1 = {
      ...snapV2,
      account: { ...snapV2.account, sessionVersion: 1 },
    };
    await assert.rejects(
      () => restoreUserPaperSession('uid_ver_guard', 'sess_stale_ver_test', olderSnapV1),
      (err: unknown) =>
        err instanceof PaperStoreError &&
        err.status === 409 &&
        err.code === 'STALE_SESSION_VERSION',
    );
  });
});

describe('Paper trade review explainGuard & static real-exchange isolation scan', () => {
  it('allows past-tense trade words (long/short/entry/exit) in paper_trade_review while still blocking directives & ungrounded numbers', () => {
    const req: PaperTradeExplainRequest = {
      tradeId: 'trd_1',
      symbol: 'BTCUSD',
      side: 'LONG',
      contracts: 2,
      entryPriceDisplay: '60000.0',
      exitPriceDisplay: '60120.0',
      grossPnlDisplay: '0.24',
      feesDisplay: '0.06',
      slippageDisplay: '0.00',
      fundingDisplay: '0.00',
      liquidationPenaltyDisplay: '0.00',
      netPnlDisplay: '0.18',
      exitReason: 'TARGET',
      parameterVersionId: 'v1-baseline',
      entryGuardrailDecision: 'CONTINUE',
      entryFiredRules: ['NONE'],
      entryScore: 22.5,
      entryVolZ: 0.4,
      entryTrend: 0.45,
      exitGuardrailDecision: 'CONTINUE',
      exitFiredRules: ['NONE'],
      exitScore: 24.0,
      exitVolZ: 0.5,
      exitTrend: 0.5,
      openedAtSec: 1_700_000_000,
      closedAtSec: 1_700_000_900,
    };

    const validReview: ExplainStructuredOutput = {
      summary:
        'Simulated LONG entry on BTCUSD at 60000.0 exited via TARGET at 60120.0 with net PnL 0.18 USDT after fees 0.06.',
      keyPoints: [
        {
          label: 'Entry Context',
          valueText: 'Score 22.5, Vol Z 0.4',
          meaning: 'Guardrail was CONTINUE with trend 0.45 at entry.',
        },
      ],
      cautions: ['Simulated paper trade only; single closed trade does not establish edge.'],
      unavailable: ['Orderbook queue priority beyond configured slippage is not modeled.'],
    };

    assert.deepEqual(validatePaperTradeExplainOutput(validReview, req), { ok: true });

    // Directive word like "buy" or "predict" must still be blocked
    const directiveReview: ExplainStructuredOutput = {
      ...validReview,
      summary: 'You should buy BTCUSD because the model predicts higher prices.',
    };
    const resDirective = validatePaperTradeExplainOutput(directiveReview, req);
    assert.equal(resDirective.ok, false);
    if (!resDirective.ok) assert.equal(resDirective.code, 'DISALLOWED_CONTENT');

    // Ungrounded number must be blocked
    const ungroundedReview: ExplainStructuredOutput = {
      ...validReview,
      summary: 'Simulated LONG entry on BTCUSD captured 999.99 USDT profit.',
    };
    const resUngrounded = validatePaperTradeExplainOutput(ungroundedReview, req);
    assert.equal(resUngrounded.ok, false);
    if (!resUngrounded.ok) assert.equal(resUngrounded.code, 'UNGROUNDED_OUTPUT');

    // Ensure existing market_snapshot guard still blocks "long" / "short"
    const marketGuard = validateExplainOutput(validReview, {
      source: 'Delta',
      symbol: 'BTCUSD',
      timeframe: '15m',
      candleCount: 100,
      lastCandleTime: 1_700_000_000,
      regime: {
        score: 22.5,
        volZ: 0.4,
        trend: 0.45,
        changePointsInWindow: 0,
        lastChangePointAgeBars: null,
      },
      guardrail: {
        decision: 'CONTINUE',
        firedRules: ['NONE'],
        reasons: ['All calm'],
        thresholdsUsed: {
          pauseScore: 70,
          pauseVolZ: 2,
          pauseChangePointAgeBars: 3,
          reduceScore: 45,
          reduceVolZ: 1.25,
          reduceChangePointAgeBars: 6,
        },
      },
      windows: {
        volWindow: 20,
        volLookback: 60,
        trendWindow: 20,
        cusumVolWindow: 20,
        cusumK: 0.5,
        cusumH: 4,
        cusumDecayBars: 10,
        weights: { volatility: 0.4, trend: 0.3, cusum: 0.3 },
        requiredBarsForVolZ: 80,
        requiredBarsForTrend: 21,
        requiredBarsForCusum: 21,
        skippedNonPositiveCloses: 0,
      },
    });
    assert.equal(marketGuard.ok, false);
  });

  it('contains zero real-exchange trading endpoints or API-key signing headers in paper modules', () => {
    const filesToScan = [
      'src/engine/decimal.ts',
      'src/engine/paperBrokerEngine.ts',
      'src/engine/paperStrategy.ts',
      'src/engine/paperAnalytics.ts',
      'server/paper/validators.ts',
      'server/paper/paperRunner.ts',
      'server/paper/walkForwardWorker.ts',
      'server/paper/paperStore.ts',
      'server/routes/paper.ts',
      'src/api/paperApi.ts',
      'src/services/paperPersistence.ts',
      'src/hooks/usePaperTrading.ts',
    ];
    const forbiddenPatterns = [
      /\/v2\/orders/i,
      /\/v2\/wallet/i,
      /\/v2\/positions/i,
      /api-key/i,
      /DELTA_API_SECRET/i,
      /ALPACA_ORDER/i,
      /firebase-admin/i,
      /from\s+['"]zod['"]/i,
    ];

    for (const rel of filesToScan) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      for (const pat of forbiddenPatterns) {
        assert.equal(
          pat.test(content),
          false,
          `Forbidden pattern ${pat.toString()} found in ${rel}`,
        );
      }
    }
  });
});
