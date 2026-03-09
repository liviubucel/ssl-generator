import { handleCreateOrder, handleVerifyOrder } from './acme';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);

    // Handle API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, url);
    }

    // For non-API routes, let the asset serving handle it
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function handleApiRequest(request: Request, url: URL): Promise<Response> {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await request.json();

    switch (url.pathname) {
      case '/api/order': {
        const result = await handleCreateOrder(body as any);
        return jsonResponse(result);
      }

      case '/api/order/verify': {
        const result = await handleVerifyOrder(body as any);
        return jsonResponse(result);
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
