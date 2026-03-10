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
  CF_API_TOKEN?: string;
  // Railway ACME engine URL — when set, all ACME calls are proxied through it
  // to avoid Cloudflare-edge → Let's Encrypt TLS handshake failures (HTTP 525).
  // Set via: wrangler secret put ACME_ENGINE_URL
  ACME_ENGINE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Configure ACME engine proxy for this request (Railway relay to avoid CF→LE 525 errors)
    configureAcmeEngine(env.ACME_ENGINE_URL);

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
    await handleScheduledRenewal(env);
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

async function handleApiRequest(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
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
    const body = await request.json();

    switch (url.pathname) {
      case '/api/order': {
        const { domains, email, ca } = body as Record<string, string>;
        if (!domains || !email || !ca) {
          return jsonResponse(
            { error: 'Missing required fields: domains, email, ca' },
            400
          );
        }
        // EAB credentials come from environment secrets for ZeroSSL
        const result = await handleCreateOrder({
          domains,
          email,
          ca,
          eabKid: env.EAB_KID,
          eabHmacKey: env.EAB_HMAC_KEY,
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
    return jsonResponse(
      { error: error.message || 'Internal server error' },
      500
    );
  }
}
