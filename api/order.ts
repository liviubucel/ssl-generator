export const config = {
  maxDuration: 60,
};

import { handleCreateOrder } from '../src/acme';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

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

    const result = await withTimeout(handleCreateOrder({
      domains,
      email,
      ca,
      eabKid: process.env.EAB_KID,
      eabHmacKey: process.env.EAB_HMAC_KEY,
    }), 9000, 'Order creation timed out in serverless runtime. Please retry or switch CA.');

    json(res, 200, result as unknown as Record<string, unknown>);
  } catch (error: any) {
    json(res, 500, { error: error?.message || 'Internal server error' });
  }
}
