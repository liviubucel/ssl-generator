export const config = {
  maxDuration: 60,
};

import { handleVerifyOrder } from '../../src/acme';

function json(res: any, status: number, body: Record<string, unknown>) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.json(body);
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    res.status(204)
      .setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type')
      .end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const {
      accountKeyPair,
      accountUrl,
      orderUrl,
      finalizeUrl,
      authorizations,
      ca,
      challengeType,
    } = req.body ?? {};

    if (
      !accountKeyPair ||
      !accountUrl ||
      !orderUrl ||
      !finalizeUrl ||
      !authorizations ||
      !ca ||
      !challengeType
    ) {
      json(res, 400, { error: 'Missing required fields for verification' });
      return;
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

    json(res, 200, result as unknown as Record<string, unknown>);
  } catch (error: any) {
    json(res, 500, { error: error?.message || 'Internal server error' });
  }
}
