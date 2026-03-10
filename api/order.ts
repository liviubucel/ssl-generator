import { handleCreateOrder } from '../src/acme';

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
    const { domains, email, ca } = req.body ?? {};

    if (!domains || !email || !ca) {
      json(res, 400, { error: 'Missing required fields: domains, email, ca' });
      return;
    }

    const result = await handleCreateOrder({
      domains,
      email,
      ca,
      eabKid: process.env.EAB_KID,
      eabHmacKey: process.env.EAB_HMAC_KEY,
    });

    json(res, 200, result as unknown as Record<string, unknown>);
  } catch (error: any) {
    json(res, 500, { error: error?.message || 'Internal server error' });
  }
}
