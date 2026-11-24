import { createVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GOOGLE_X509_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const IDENTITY_TOOLKIT_LOOKUP_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
}

export class FirebaseAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 401, code = 'UNAUTHORIZED') {
    super(message);
    this.name = 'FirebaseAuthError';
    this.status = status;
    this.code = code;
  }
}

interface CertCache {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let certCache: CertCache | null = null;
let inFlightCertFetch: Promise<Record<string, string>> | null = null;

interface RuntimeFirebaseConfig {
  projectId: string | null;
  apiKey: string | null;
}

function readRuntimeFirebaseConfig(): RuntimeFirebaseConfig {
  let fileProjectId: string | null = null;
  let fileApiKey: string | null = null;
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        projectId?: unknown;
        apiKey?: unknown;
      };
      if (typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
        fileProjectId = parsed.projectId.trim();
      }
      if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) {
        fileApiKey = parsed.apiKey.trim();
      }
    }
  } catch {
    // Fall back to environment variables
  }

  return {
    projectId:
      process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
      process.env.FIREBASE_PROJECT_ID?.trim() ||
      fileProjectId,
    apiKey:
      process.env.VITE_FIREBASE_API_KEY?.trim() ||
      process.env.FIREBASE_WEB_API_KEY?.trim() ||
      fileApiKey,
  };
}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

function parseJwtParts(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signedInput: string;
  signature: Buffer;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new FirebaseAuthError('Malformed Firebase ID token', 401, 'INVALID_TOKEN_FORMAT');
  }

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
    const signature = base64UrlDecode(parts[2]);
    return {
      header,
      payload,
      signedInput: `${parts[0]}.${parts[1]}`,
      signature,
    };
  } catch {
    throw new FirebaseAuthError('Unable to decode Firebase ID token', 401, 'INVALID_TOKEN_ENCODING');
  }
}

function validateTokenClaims(
  payload: Record<string, unknown>,
  projectId: string,
  nowSec: number,
): VerifiedFirebaseUser {
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== expectedIssuer) {
    throw new FirebaseAuthError('Invalid token issuer', 401, 'INVALID_TOKEN_ISSUER');
  }
  if (payload.aud !== projectId) {
    throw new FirebaseAuthError('Invalid token audience', 401, 'INVALID_TOKEN_AUDIENCE');
  }
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 128) {
    throw new FirebaseAuthError('Missing or invalid token subject', 401, 'INVALID_TOKEN_SUB');
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
    throw new FirebaseAuthError('Firebase ID token expired', 401, 'TOKEN_EXPIRED');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > nowSec + 300) {
    throw new FirebaseAuthError('Invalid token issued-at timestamp', 401, 'INVALID_TOKEN_IAT');
  }
  if (payload.email_verified !== true) {
    throw new FirebaseAuthError(
      'Verified email is required for paper trading access',
      403,
      'EMAIL_NOT_VERIFIED',
    );
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: true,
  };
}

/**
 * Pure local RS256 verification against Google X.509 certificates (zero Admin SDK).
 * Exposed for deterministic unit testing.
 */
export function verifyFirebaseTokenWithCerts(
  token: string,
  certsByKid: Record<string, string>,
  projectId: string,
  nowSec = Math.floor(Date.now() / 1000),
): VerifiedFirebaseUser {
  const { header, payload, signedInput, signature } = parseJwtParts(token);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new FirebaseAuthError('Unsupported JWT algorithm or missing kid', 401, 'INVALID_TOKEN_ALG');
  }

  const certPem = certsByKid[header.kid];
  if (!certPem) {
    throw new FirebaseAuthError('Unknown signing key ID (kid)', 401, 'UNKNOWN_SIGNING_KID');
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signedInput);
  verifier.end();
  const sigValid = verifier.verify(certPem, signature);
  if (!sigValid) {
    throw new FirebaseAuthError('Invalid Firebase ID token signature', 401, 'INVALID_SIGNATURE');
  }

  return validateTokenClaims(payload, projectId, nowSec);
}

async function fetchGooglePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certCache && now < certCache.expiresAtMs) {
    return certCache.certs;
  }
  if (inFlightCertFetch) {
    return inFlightCertFetch;
  }

  inFlightCertFetch = (async () => {
    const res = await fetch(GOOGLE_X509_CERTS_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw new Error(`Google public key fetch returned HTTP ${res.status}`);
    }
    const certs = (await res.json()) as Record<string, string>;
    const cc = res.headers.get('cache-control') ?? '';
    const maxAgeMatch = /max-age=(\d+)/i.exec(cc);
    const maxAgeMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 300_000;
    certCache = { certs, expiresAtMs: Date.now() + maxAgeMs };
    return certs;
  })().finally(() => {
    inFlightCertFetch = null;
  });

  return inFlightCertFetch;
}

async function verifyViaAccountsLookup(
  token: string,
  projectId: string,
  apiKey: string,
): Promise<VerifiedFirebaseUser> {
  const { payload } = parseJwtParts(token);
  const claimsUser = validateTokenClaims(payload, projectId, Math.floor(Date.now() / 1000));

  const res = await fetch(`${IDENTITY_TOOLKIT_LOOKUP_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new FirebaseAuthError('Firebase accounts:lookup rejected token', 401, 'INVALID_ID_TOKEN');
  }

  const json = (await res.json()) as {
    users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
  };
  const userRecord = Array.isArray(json.users) ? json.users[0] : null;
  if (!userRecord || userRecord.localId !== claimsUser.uid || userRecord.emailVerified !== true) {
    throw new FirebaseAuthError('Firebase token user mismatch or unverified email', 401, 'INVALID_ID_TOKEN');
  }

  return {
    uid: userRecord.localId,
    email: typeof userRecord.email === 'string' ? userRecord.email : claimsUser.email,
    emailVerified: true,
  };
}

export async function verifyFirebaseIdToken(token: string): Promise<VerifiedFirebaseUser> {
  if (!token || typeof token !== 'string' || token.length > 8192) {
    throw new FirebaseAuthError('Missing or oversized bearer token', 401, 'MISSING_TOKEN');
  }

  const cfg = readRuntimeFirebaseConfig();
  if (!cfg.projectId) {
    throw new FirebaseAuthError('Firebase projectId is not configured on server', 503, 'AUTH_NOT_CONFIGURED');
  }

  try {
    const certs = await fetchGooglePublicCerts(false);
    try {
      return verifyFirebaseTokenWithCerts(token, certs, cfg.projectId);
    } catch (err) {
      if (err instanceof FirebaseAuthError && err.code === 'UNKNOWN_SIGNING_KID') {
        const refreshed = await fetchGooglePublicCerts(true);
        return verifyFirebaseTokenWithCerts(token, refreshed, cfg.projectId);
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof FirebaseAuthError) {
      // Only fall back to accounts:lookup on key/network availability errors, never on forged signature/expired token
      if (
        err.code === 'INVALID_SIGNATURE' ||
        err.code === 'TOKEN_EXPIRED' ||
        err.code === 'INVALID_TOKEN_ISSUER' ||
        err.code === 'INVALID_TOKEN_AUDIENCE' ||
        err.code === 'EMAIL_NOT_VERIFIED' ||
        err.code === 'INVALID_TOKEN_FORMAT'
      ) {
        throw err;
      }
    }
    if (cfg.apiKey) {
      return verifyViaAccountsLookup(token, cfg.projectId, cfg.apiKey);
    }
    if (err instanceof FirebaseAuthError) {
      throw err;
    }
    throw new FirebaseAuthError('Unable to verify Firebase ID token', 401, 'TOKEN_VERIFICATION_FAILED');
  }
}
