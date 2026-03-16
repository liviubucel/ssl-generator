import { handleCreateOrder, handleVerifyOrder, configureAcmeEngine } from './acme';
import {
  handleScheduledRenewal,
  saveRenewalConfig,
  listRenewals,
  deleteRenewal,
} from './renewal';

export interface Env {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  SSL_STORE?: KVNamespace;
  EAB_KID?: string;
  EAB_HMAC_KEY?: string;
  ACTALIS_90_ME_KID?: string;
  ACTALIS_90_HMAC_KEY?: string;
  ACTALIS_1_ME_KID?: string;
  ACTALIS_1_HMAC_KEY?: string;
  CF_API_TOKEN?: string;
  // Railway ACME engine URL — when set, all ACME calls are proxied through it
  // to avoid Cloudflare-edge → Let's Encrypt TLS handshake failures (HTTP 525).
  // Set via: wrangler secret put ACME_ENGINE_URL
  ACME_ENGINE_URL?: string;
  // Shared secret between this Worker and the Railway ACME engine.
  // Must match ENGINE_TOKEN environment variable set on Railway.
  ENGINE_TOKEN?: string;
  // Resend API key for email notifications on certificate renewal.
  // Set via: wrangler secret put RESEND_API_KEY
  RESEND_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Configure ACME engine proxy for this request (Railway relay to avoid CF→LE 525 errors)
    configureAcmeEngine(env.ACME_ENGINE_URL, env.ENGINE_TOKEN);

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url, env);
    }

    // For non-API routes, let the asset serving handle it
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduledRenewal({ ...env, RESEND_API_KEY: env.RESEND_API_KEY });
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function getEabCredentials(
  env: Env,
  ca: string
): { eabKid?: string; eabHmacKey?: string } {
  switch (ca) {
    case 'letsencrypt':
    case 'zerossl':
      return {
        eabKid: env.EAB_KID,
        eabHmacKey: env.EAB_HMAC_KEY,
      };
    case 'actalis-90d':
      return {
        eabKid: env.ACTALIS_90_ME_KID,
        eabHmacKey: env.ACTALIS_90_HMAC_KEY,
      };
    case 'actalis-1y':
      return {
        eabKid: env.ACTALIS_1_ME_KID,
        eabHmacKey: env.ACTALIS_1_HMAC_KEY,
      };
    default:
      return {};
  }
}

function detectApiErrorCode(message: string, ca?: string): string {
  if (message.includes('Actalis does not support wildcard certificates')) {
    return 'ACTALIS_WILDCARD_UNSUPPORTED';
  }

  if (
    ca === 'actalis-1y' &&
    /eab signature verification failed|eab kid lookup failed/i.test(message)
  ) {
    return 'ACTALIS_1Y_UNAVAILABLE';
  }

  if (/eab signature verification failed|eab kid lookup failed/i.test(message)) {
    return 'CA_ACCOUNT_VALIDATION_FAILED';
  }

  if (
    /Failed to fetch ACME directory|temporarily unreachable|temporarily unavailable|HTTP 525|Polling timed out/i.test(
      message
    )
  ) {
    return 'CA_TEMPORARILY_UNAVAILABLE';
  }

  if (/Challenge verification pending or failed|Certificate is still being issued/i.test(message)) {
    return 'ORDER_VERIFICATION_PENDING';
  }

  return 'SSL_GENERATION_FAILED';
}

function publicErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'ACTALIS_WILDCARD_UNSUPPORTED':
      return 'Wildcard certificates for Actalis are not supported at the moment.';
    case 'ACTALIS_1Y_UNAVAILABLE':
      return 'Actalis 1 year certificates could not be issued with the current account configuration.';
    case 'CA_ACCOUNT_VALIDATION_FAILED':
      return 'The selected certificate authority could not validate the current account configuration.';
    case 'CA_TEMPORARILY_UNAVAILABLE':
      return 'The selected certificate authority is temporarily unavailable.';
    case 'ORDER_VERIFICATION_PENDING':
      return 'Domain verification is still in progress.';
    default:
      return 'SSL generation is temporarily unavailable.';
  }
}

function sanitizeApiError(error: unknown, ca?: string): {
  error: string;
  errorCode: string;
  status: number;
} {
  const message = error instanceof Error ? error.message : String(error || '');
  const errorCode = detectApiErrorCode(message, ca);
  const status =
    errorCode === 'ACTALIS_WILDCARD_UNSUPPORTED' ||
    errorCode === 'ACTALIS_1Y_UNAVAILABLE' ||
    errorCode === 'CA_ACCOUNT_VALIDATION_FAILED'
      ? 400
      : errorCode === 'ORDER_VERIFICATION_PENDING'
      ? 409
      : 500;

  return {
    error: publicErrorMessage(errorCode),
    errorCode,
    status,
  };
}

function maskValue(value: string | undefined): string {
  if (!value) return 'missing';
  if (value.length <= 8) return 'set';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function handleApiRequest(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  let body: Record<string, any> = {};

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // GET routes
  if (request.method === 'GET') {
    switch (url.pathname) {
      case '/api/renewals': {
        if (!env.SSL_STORE) {
          return jsonResponse({ renewals: [] });
        }
        const renewals = await listRenewals(env.SSL_STORE);
        return jsonResponse({ renewals });
      }
      default:
        return jsonResponse({ error: 'Not found' }, 404);
    }
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    body = await request.json();

    switch (url.pathname) {
      case '/api/order': {
        const { domains, email, ca } = body as Record<string, string>;
        if (!domains || !email || !ca) {
          return jsonResponse(
            { error: 'Missing required fields: domains, email, ca' },
            400
          );
        }
        const { eabKid, eabHmacKey } = getEabCredentials(env, ca);
        const result = await handleCreateOrder({
          domains,
          email,
          ca,
          eabKid,
          eabHmacKey,
        });
        return jsonResponse(result);
      }

      case '/api/order/verify': {
        const {
          accountKeyPair,
          accountUrl,
          orderUrl,
          finalizeUrl,
          authorizations,
          ca,
          challengeType,
          autoRenew,
          notifyEmail,
          notifyDaysBefore,
          email,
        } = body as Record<string, any>;
        if (
          !accountKeyPair ||
          !accountUrl ||
          !orderUrl ||
          !finalizeUrl ||
          !authorizations ||
          !ca ||
          !challengeType
        ) {
          return jsonResponse(
            { error: 'Missing required fields for verification' },
            400
          );
        }
        const result = await handleVerifyOrder({
          accountKeyPair,
          accountUrl,
          orderUrl,
          finalizeUrl,
          authorizations,
          ca,
          challengeType,
        });

        if (result.error) {
          const sanitized = sanitizeApiError(result.error, ca);
          result.error = sanitized.error;
          (result as Record<string, unknown>).errorCode = sanitized.errorCode;
        }

        // If certificate issued and auto-renewal requested, save to KV
        if (
          result.status === 'valid' &&
          result.certificate &&
          autoRenew &&
          env.SSL_STORE
        ) {
          const domains = (authorizations as Array<{ domain: string }>).map(
            (a) => a.domain
          );
          await saveRenewalConfig(env.SSL_STORE, {
            domains,
            email: email || '',
            ca,
            challengeType,
            accountKeyPair,
            accountUrl,
            certificate: result.certificate,
            privateKey: result.privateKey || '',
            intermediateCert: result.intermediateCert || '',
            autoRenew: true,
            notifyEmail: notifyEmail || null,
            notifyDaysBefore: notifyDaysBefore || 30,
            createdAt: new Date().toISOString(),
            lastRenewalAttempt: null,
            lastRenewalStatus: null,
          });
        }

        return jsonResponse(result);
      }

      case '/api/renewals/delete': {
        const { key } = body as Record<string, string>;
        if (!key || !env.SSL_STORE) {
          return jsonResponse(
            { error: 'Missing key or KV not configured' },
            400
          );
        }
        await deleteRenewal(env.SSL_STORE, key);
        return jsonResponse({ success: true });
      }

      default:
        return jsonResponse({ error: 'Not found' }, 404);
    }
  } catch (error: any) {
    console.error('API Error:', error);
    const sanitized = sanitizeApiError(error, body.ca);
    if (sanitized.errorCode === 'ACTALIS_1Y_UNAVAILABLE') {
      const { eabKid, eabHmacKey } = getEabCredentials(env, 'actalis-1y');
      console.error('Actalis 1 year diagnostic', {
        ca: body.ca,
        domains: body.domains,
        email: body.email,
        kidMask: maskValue(eabKid?.trim()),
        kidLength: eabKid?.trim().length ?? 0,
        hmacLength: eabHmacKey?.replace(/\s+/g, '').length ?? 0,
      });
    }
    return jsonResponse(
      { error: sanitized.error, errorCode: sanitized.errorCode },
      sanitized.status
    );
  }
}
