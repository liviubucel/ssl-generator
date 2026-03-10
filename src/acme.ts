import {
  generateCSR,
  arrayBufferToBase64Url,
  base64UrlToArrayBuffer,
  pemFromDer,
  arrayBufferToBase64,
} from './asn1';

// ACME directory URLs in priority order.
const ACME_DIRECTORIES: Record<string, string[]> = {
  letsencrypt: [
    'https://acme-v02.api.letsencrypt.org/directory',
    // Same endpoint with trailing slash can route differently on some edges.
    'https://acme-v02.api.letsencrypt.org/directory/',
  ],
  zerossl: ['https://acme.zerossl.com/v2/DV90'],
};

const REQUEST_TIMEOUT_MS = 12000;
const FAST_LE_TIMEOUT_MS = 2500;

// Optional Railway proxy URL — set via configureAcmeEngine() at request start.
// When set, all ACME HTTP calls are relayed through the Railway backend so that
// Cloudflare-edge → Let's Encrypt TLS handshake issues (HTTP 525) are avoided.
let _acmeEngineUrl: string | undefined;

export function configureAcmeEngine(url: string | undefined): void {
  _acmeEngineUrl = url;
}

/**
 * Thin fetch wrapper: when a Railway relay URL is configured, all ACME
 * requests are forwarded to POST /api/acme-proxy on the Railway backend
 * instead of hitting the ACME CA directly from the Cloudflare edge.
 */
async function acmeFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!_acmeEngineUrl) {
    return fetch(url, init);
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  let rawHeaders: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { rawHeaders[k] = v; });
    } else {
      rawHeaders = init.headers as Record<string, string>;
    }
  }

  const body = init?.body != null ? String(init.body) : undefined;

  return fetch(`${_acmeEngineUrl}/api/acme-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers: rawHeaders, body }),
  });
}

function previewText(input: string, max = 180): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseJsonSafe(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface JWK {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

export interface AcmeChallenge {
  type: string;
  url: string;
  token: string;
  status: string;
}

export interface AcmeAuthorization {
  domain: string;
  expires: string;
  challenges: {
    http: { token: string; content: string; url: string } | null;
    dns: { name: string; value: string; url: string } | null;
  };
  verified: boolean | null;
}

export interface CreateOrderResult {
  accountKeyPair: JsonWebKey;
  accountUrl: string;
  orderUrl: string;
  finalizeUrl: string;
  authorizations: AcmeAuthorization[];
  ca: string;
}

export interface VerifyResult {
  status: string;
  certificate?: string;
  privateKey?: string;
  intermediateCert?: string;
  authorizations?: AcmeAuthorization[];
  error?: string;
}

// Fetch ACME directory (with retry for transient connectivity issues)
async function getDirectory(ca: string): Promise<AcmeDirectory> {
  const directoryUrls = ACME_DIRECTORIES[ca];
  if (!directoryUrls || directoryUrls.length === 0) {
    throw new Error(`Unknown CA: ${ca}`);
  }

  // Keep LE fallback snappy; allow more retries for other CAs.
  const maxAttempts = ca === 'letsencrypt' ? 1 : 4;
  const timeoutMs = ca === 'letsencrypt' ? FAST_LE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  let lastError: Error | null = null;

  for (const directoryUrl of directoryUrls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await acmeFetch(directoryUrl, {
          headers: {
            'Accept': 'application/json',
            'Cache-Control': 'no-cache',
          },
          redirect: 'follow',
          signal: controller.signal,
        });

        if (!resp.ok) {
          let detail = '';
          try {
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('text') || contentType.includes('json')) {
              detail = await resp.text();
            }
          } catch {
            // Ignore body parsing failures, we still have status code.
          }

          const is525 = resp.status === 525;
          const errorMsg = is525
            ? `Failed to fetch ACME directory from ${ca}: HTTP 525 (SSL Handshake Failed). This is a temporary Cloudflare<->Let's Encrypt connectivity issue. Please try again or switch to ZeroSSL.`
            : `Failed to fetch ACME directory from ${ca}: HTTP ${resp.status}${detail ? ' - ' + detail : ''}. The certificate authority may be temporarily unavailable. Please try again later or select a different CA.`;
          throw new Error(errorMsg);
        }

        const raw = await resp.text();
        const data = parseJsonSafe(raw);
        if (!data) {
          throw new Error(
            'Failed to parse ACME directory JSON from ' + ca + '. Response preview: ' + previewText(raw)
          );
        }
        if (!data.newNonce || !data.newAccount || !data.newOrder) {
          throw new Error(
            'Invalid ACME directory payload from ' + ca + '. Response preview: ' + previewText(raw)
          );
        }
        return {
          newNonce: data.newNonce,
          newAccount: data.newAccount,
          newOrder: data.newOrder,
        };
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          const delayMs =
            ca === 'letsencrypt'
              ? 600
              : Math.min(1200 * 2 ** (attempt - 1), 8000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  throw lastError!;
}
// Get a fresh nonce
async function getNonce(nonceUrl: string): Promise<string> {
  const resp = await acmeFetch(nonceUrl, {
    method: 'HEAD',
  });
  const nonce = resp.headers.get('Replay-Nonce');
  if (!nonce) throw new Error('Failed to get nonce');
  return nonce;
}

// Generate ECDSA P-256 key pair for ACME account
async function generateAccountKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  ) as Promise<CryptoKeyPair>;
}

// Export public key as JWK
async function getPublicJWK(publicKey: CryptoKey): Promise<JWK> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey) as JsonWebKey;
  return {
    kty: jwk.kty!,
    crv: jwk.crv!,
    x: jwk.x!,
    y: jwk.y!,
  };
}

// Compute JWK thumbprint (SHA-256)
async function jwkThumbprint(jwk: JWK): Promise<string> {
  const ordered = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ordered));
  return arrayBufferToBase64Url(hash);
}

// Create JWS (JSON Web Signature)
async function signJWS(
  payload: string | object | null,
  protectedHeader: object,
  privateKey: CryptoKey
): Promise<string> {
  const encodedProtected = arrayBufferToBase64Url(
    new TextEncoder().encode(JSON.stringify(protectedHeader)).buffer as ArrayBuffer
  );

  let encodedPayload: string;
  if (payload === null || payload === '') {
    encodedPayload = '';
  } else {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    encodedPayload = arrayBufferToBase64Url(
      new TextEncoder().encode(payloadStr).buffer as ArrayBuffer
    );
  }

  const signingInput = `${encodedProtected}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  // Convert DER signature to raw R||S format for JWS
  const rawSignature = derToRaw(new Uint8Array(signature));
  const encodedSignature = arrayBufferToBase64Url(rawSignature.buffer as ArrayBuffer);

  return JSON.stringify({
    protected: encodedProtected,
    payload: encodedPayload,
    signature: encodedSignature,
  });
}

// Convert DER-encoded ECDSA signature to raw R||S format
function derToRaw(der: Uint8Array): Uint8Array {
  // If it's already raw (64 bytes for P-256), return as-is
  if (der.length === 64) return der;

  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  if (der[0] !== 0x30) return der;

  let offset = 2;
  // Parse R
  if (der[offset] !== 0x02) return der;
  offset++;
  const rLen = der[offset];
  offset++;
  let r = der.slice(offset, offset + rLen);
  offset += rLen;

  // Parse S
  if (der[offset] !== 0x02) return der;
  offset++;
  const sLen = der[offset];
  offset++;
  let s = der.slice(offset, offset + sLen);

  // Trim leading zeros and pad to 32 bytes
  if (r.length > 32) r = r.slice(r.length - 32);
  if (s.length > 32) s = s.slice(s.length - 32);

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

// Make ACME request with JWS
async function acmeRequest(
  url: string,
  payload: object | string | null,
  privateKey: CryptoKey,
  nonce: string,
  accountUrl: string | null,
  publicJWK: JWK | null
): Promise<{ data: any; headers: Headers; nonce: string }> {
  const protectedHeader: Record<string, unknown> = {
    alg: 'ES256',
    nonce: nonce,
    url: url,
  };

  if (accountUrl) {
    protectedHeader.kid = accountUrl;
  } else if (publicJWK) {
    protectedHeader.jwk = publicJWK;
  }

  const body = await signJWS(payload, protectedHeader, privateKey);

  const resp = await acmeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/jose+json',
    },
    body: body,
  });

  const newNonce = resp.headers.get('Replay-Nonce') || nonce;
  const contentType = resp.headers.get('content-type') || '';

  let data;
  if (contentType.includes('application/json') || contentType.includes('application/problem+json')) {
    const raw = await resp.text();
    data = parseJsonSafe(raw);
    if (!data) {
      throw new Error(
        'ACME returned invalid JSON from ' + url + '. Response preview: ' + previewText(raw)
      );
    }
  } else if (contentType.includes('application/pem-certificate-chain')) {
    data = await resp.text();
  } else {
    data = await resp.text();
    try {
      data = JSON.parse(data);
    } catch {
      // keep as text
    }
  }

  if (!resp.ok && typeof data === 'object' && data.type) {
    throw new Error(`ACME error: ${data.type} - ${data.detail || JSON.stringify(data)}`);
  }

  return { data, headers: resp.headers, nonce: newNonce };
}

// Create account (or find existing)
async function createAccount(
  directory: AcmeDirectory,
  privateKey: CryptoKey,
  publicJWK: JWK,
  nonce: string,
  email: string,
  eabKid?: string,
  eabHmacKey?: string
): Promise<{ accountUrl: string; nonce: string }> {
  const payload: Record<string, unknown> = {
    termsOfServiceAgreed: true,
    contact: [`mailto:${email}`],
  };

  // Handle External Account Binding (for ZeroSSL)
  if (eabKid && eabHmacKey) {
    const eabKey = await crypto.subtle.importKey(
      'raw',
      base64UrlToArrayBuffer(eabHmacKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const eabProtected = {
      alg: 'HS256',
      kid: eabKid,
      url: directory.newAccount,
    };

    const encodedProtected = arrayBufferToBase64Url(
      new TextEncoder().encode(JSON.stringify(eabProtected)).buffer as ArrayBuffer
    );
    const encodedPayload = arrayBufferToBase64Url(
      new TextEncoder().encode(JSON.stringify(publicJWK)).buffer as ArrayBuffer
    );

    const eabSigningInput = `${encodedProtected}.${encodedPayload}`;
    const eabSignature = await crypto.subtle.sign(
      'HMAC',
      eabKey,
      new TextEncoder().encode(eabSigningInput)
    );

    payload.externalAccountBinding = {
      protected: encodedProtected,
      payload: encodedPayload,
      signature: arrayBufferToBase64Url(eabSignature),
    };
  }

  const result = await acmeRequest(
    directory.newAccount,
    payload,
    privateKey,
    nonce,
    null,
    publicJWK
  );

  const accountUrl = result.headers.get('Location');
  if (!accountUrl) throw new Error('Failed to get account URL');

  return { accountUrl, nonce: result.nonce };
}

// Create order
async function createOrder(
  directory: AcmeDirectory,
  privateKey: CryptoKey,
  accountUrl: string,
  nonce: string,
  domains: string[]
): Promise<{
  orderUrl: string;
  finalizeUrl: string;
  authorizationUrls: string[];
  nonce: string;
}> {
  const payload = {
    identifiers: domains.map((d) => ({ type: 'dns', value: d })),
  };

  const result = await acmeRequest(
    directory.newOrder,
    payload,
    privateKey,
    nonce,
    accountUrl,
    null
  );

  const location = result.headers.get('Location') || '';

  return {
    orderUrl: location || '',
    finalizeUrl: result.data.finalize,
    authorizationUrls: result.data.authorizations,
    nonce: result.nonce,
  };
}

// Get authorization and challenges
async function getAuthorization(
  url: string,
  privateKey: CryptoKey,
  accountUrl: string,
  nonce: string,
  thumbprint: string
): Promise<{ authorization: AcmeAuthorization; nonce: string }> {
  const result = await acmeRequest(url, '', privateKey, nonce, accountUrl, null);

  const identifierDomain = result.data.identifier.value;
  const isWildcard = result.data.wildcard === true;
  // Display domain includes wildcard prefix; base domain is used for DNS challenge name
  const domain = isWildcard ? `*.${identifierDomain}` : identifierDomain;
  const expires = result.data.expires || '';
  const challenges: AcmeAuthorization['challenges'] = { http: null, dns: null };

  for (const ch of result.data.challenges) {
    const keyAuth = `${ch.token}.${thumbprint}`;

    if (ch.type === 'http-01') {
      challenges.http = {
        token: ch.token,
        content: keyAuth,
        url: ch.url,
      };
    } else if (ch.type === 'dns-01') {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(keyAuth)
      );
      challenges.dns = {
        name: `_acme-challenge.${identifierDomain}`,
        value: arrayBufferToBase64Url(hash),
        url: ch.url,
      };
    }
  }

  const verified =
    result.data.status === 'valid'
      ? true
      : result.data.status === 'invalid'
      ? false
      : null;

  return {
    authorization: { domain, expires, challenges, verified },
    nonce: result.nonce,
  };
}

// Respond to a challenge
async function respondToChallenge(
  challengeUrl: string,
  privateKey: CryptoKey,
  accountUrl: string,
  nonce: string
): Promise<string> {
  const result = await acmeRequest(
    challengeUrl,
    {},
    privateKey,
    nonce,
    accountUrl,
    null
  );
  return result.nonce;
}

// Poll for status
async function pollStatus(
  url: string,
  privateKey: CryptoKey,
  accountUrl: string,
  nonce: string,
  targetStatuses: string[],
  maxAttempts = 15,
  delayMs = 2000
): Promise<{ data: any; nonce: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await acmeRequest(url, '', privateKey, nonce, accountUrl, null);
    nonce = result.nonce;

    if (targetStatuses.includes(result.data.status)) {
      return { data: result.data, nonce };
    }

    if (result.data.status === 'invalid') {
      throw new Error(`Status is invalid: ${JSON.stringify(result.data)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('Polling timed out');
}

function isLetsEncryptDirectory525(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Failed to fetch ACME directory from letsencrypt') &&
    message.includes('HTTP 525')
  );
}

// Main: Create ACME Order
export async function handleCreateOrder(body: {
  domains: string;
  email: string;
  ca: string;
  eabKid?: string;
  eabHmacKey?: string;
}): Promise<CreateOrderResult> {
  const { email, ca, eabKid, eabHmacKey } = body;
  const domains = body.domains
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (domains.length === 0) throw new Error('At least one domain is required');
  if (!email) throw new Error('Email is required');
  if (!ACME_DIRECTORIES[ca]) throw new Error('Invalid CA');

  // ZeroSSL requires EAB
  if (ca === 'zerossl' && (!eabKid || !eabHmacKey)) {
    throw new Error('ZeroSSL requires EAB credentials (KID and HMAC Key)');
  }

  let effectiveCa = ca;

  // Get directory with fallback from Let's Encrypt to ZeroSSL on transient 525.
  let directory: AcmeDirectory;
  try {
    directory = await getDirectory(effectiveCa);
  } catch (error) {
    if (ca === 'letsencrypt' && isLetsEncryptDirectory525(error)) {
      if (!eabKid || !eabHmacKey) {
        throw new Error(
          "Let's Encrypt is temporarily unreachable (HTTP 525). Automatic fallback to ZeroSSL requires EAB credentials (EAB_KID and EAB_HMAC_KEY)."
        );
      }
      effectiveCa = 'zerossl';
      directory = await getDirectory(effectiveCa);
    } else {
      throw error;
    }
  }

  // Get nonce
  let nonce = await getNonce(directory.newNonce);

  // Generate account key pair
  const keyPair = await generateAccountKeyPair();
  const publicJWK = await getPublicJWK(keyPair.publicKey);
  const thumbprint = await jwkThumbprint(publicJWK);

  const effectiveEabKid = effectiveCa === 'zerossl' ? eabKid : undefined;
  const effectiveEabHmacKey = effectiveCa === 'zerossl' ? eabHmacKey : undefined;

  // Create account
  const accountResult = await createAccount(
    directory,
    keyPair.privateKey,
    publicJWK,
    nonce,
    email,
    effectiveEabKid,
    effectiveEabHmacKey
  );
  nonce = accountResult.nonce;

  // Create order
  const orderResult = await createOrder(
    directory,
    keyPair.privateKey,
    accountResult.accountUrl,
    nonce,
    domains
  );
  nonce = orderResult.nonce;

  // Get authorizations
  const authorizations: AcmeAuthorization[] = [];
  for (const authUrl of orderResult.authorizationUrls) {
    const authResult = await getAuthorization(
      authUrl,
      keyPair.privateKey,
      accountResult.accountUrl,
      nonce,
      thumbprint
    );
    nonce = authResult.nonce;
    authorizations.push(authResult.authorization);
  }

  // Export account key pair for client storage
  const exportedKey = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;

  return {
    accountKeyPair: exportedKey,
    accountUrl: accountResult.accountUrl,
    orderUrl: orderResult.orderUrl,
    finalizeUrl: orderResult.finalizeUrl,
    authorizations,
    ca: effectiveCa,
  };
}

// Main: Verify challenges and get certificate
export async function handleVerifyOrder(body: {
  accountKeyPair: JsonWebKey;
  accountUrl: string;
  orderUrl: string;
  finalizeUrl: string;
  authorizations: AcmeAuthorization[];
  ca: string;
  challengeType: string;
}): Promise<VerifyResult> {
  const {
    accountKeyPair,
    accountUrl,
    orderUrl,
    finalizeUrl,
    authorizations,
    ca,
    challengeType,
  } = body;

  // Import account key
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    accountKeyPair,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );

  const directory = await getDirectory(ca);
  let nonce = await getNonce(directory.newNonce);

  // Respond to challenges
  for (const auth of authorizations) {
    if (auth.verified === true) continue;

    let challengeUrl: string | null = null;
    if (challengeType === 'http-01' && auth.challenges.http) {
      challengeUrl = auth.challenges.http.url;
    } else if (challengeType === 'dns-01' && auth.challenges.dns) {
      challengeUrl = auth.challenges.dns.url;
    }

    if (challengeUrl) {
      nonce = await respondToChallenge(challengeUrl, privateKey, accountUrl, nonce);
    }
  }

  // Poll order until ready
  let orderData;
  try {
    const pollResult = await pollStatus(
      orderUrl,
      privateKey,
      accountUrl,
      nonce,
      ['ready', 'valid'],
      20,
      3000
    );
    orderData = pollResult.data;
    nonce = pollResult.nonce;
  } catch (e: any) {
    return {
      status: 'pending',
      error: `Challenge verification pending or failed: ${e.message}`,
    };
  }

  if (orderData.status === 'valid' && orderData.certificate) {
    // Certificate is already available
    const certResult = await acmeRequest(
      orderData.certificate,
      '',
      privateKey,
      nonce,
      accountUrl,
      null
    );

    return {
      status: 'valid',
      certificate: certResult.data,
    };
  }

  // Generate domain key pair (RSA 2048 for wide compatibility)
  const domainKeyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;

  // Build domains list from authorizations
  const domains = authorizations.map((a) => a.domain);

  // Generate CSR
  const csrDer = await generateCSR(domains, domainKeyPair.privateKey, domainKeyPair.publicKey);
  const csrBase64url = arrayBufferToBase64Url(csrDer);

  // Finalize order
  const finalizeResult = await acmeRequest(
    finalizeUrl,
    { csr: csrBase64url },
    privateKey,
    nonce,
    accountUrl,
    null
  );
  nonce = finalizeResult.nonce;

  // Poll for certificate
  const certOrderUrl = finalizeResult.headers.get('Location') || orderUrl;
  let certData;
  try {
    const certPollResult = await pollStatus(
      certOrderUrl,
      privateKey,
      accountUrl,
      nonce,
      ['valid'],
      20,
      3000
    );
    certData = certPollResult.data;
    nonce = certPollResult.nonce;
  } catch {
    return { status: 'processing', error: 'Certificate is still being issued. Try again shortly.' };
  }

  if (!certData.certificate) {
    return { status: 'processing', error: 'Certificate URL not yet available.' };
  }

  // Download certificate
  const certResult = await acmeRequest(
    certData.certificate,
    '',
    privateKey,
    nonce,
    accountUrl,
    null
  );

  // Export domain private key as PEM
  const domainKeyDer = await crypto.subtle.exportKey('pkcs8', domainKeyPair.privateKey) as ArrayBuffer;
  const domainKeyPem = pemFromDer(domainKeyDer, 'PRIVATE KEY');

  // Parse certificate chain
  const fullChain = certResult.data as string;
  const certs = fullChain
    .split(/(?=-----BEGIN CERTIFICATE-----)/)
    .filter((c: string) => c.trim().length > 0);

  return {
    status: 'valid',
    certificate: certs[0] || fullChain,
    privateKey: domainKeyPem,
    intermediateCert: certs.slice(1).join('') || undefined,
  };
}
