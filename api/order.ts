import { handleCreateOrder } from '../src/acme';
import { sendErrorEmail } from './email';

function json(res: any, status: number, body: Record<string, unknown>) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function parseBody(req: any): Record<string, any> {
  const body = req?.body;
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (typeof body === 'object') return body;
  return {};
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
    const { domains, email, ca } = parseBody(req);

    if (!domains || !email || !ca) {
      json(res, 400, { error: 'Missing required fields: domains, email, ca' });
      return;
    }

    let eabKid, eabHmacKey;
    if (ca === 'zerossl') {
      eabKid = process.env.EAB_KID;
      eabHmacKey = process.env.EAB_HMAC_KEY;
    } else if (ca === 'actalis-1y') {
      eabKid = process.env.ACTALIS_1_ME_KID;
      eabHmacKey = process.env.ACTALIS_1_HMAC_KEY;
    } else if (ca === 'actalis-90d') {
      eabKid = process.env.ACTALIS_90_ME_KID;
      eabHmacKey = process.env.ACTALIS_90_HMAC_KEY;
    }

    // DEBUG: Log EAB values mascate
    const mask = (val) => val ? val.slice(0, 4) + '...' + val.slice(-4) : undefined;
    console.log('[EAB DEBUG]', {
      ca,
      eabKid: mask(eabKid),
      eabHmacKey: mask(eabHmacKey),
    });
    const result = await handleCreateOrder({
      domains,
      email,
      ca,
      eabKid,
      eabHmacKey,
    });

    json(res, 200, result as unknown as Record<string, unknown>);
  } catch (error: any) {
    // Maschează erorile tehnice pentru utilizatorii finali
    let userMessage = 'Serviciul de generare SSL este momentan indisponibil (mentenanță sau suprasarcină). Vă rugăm să încercați din nou mai târziu.';
    let shouldNotify = false;
    if (typeof error?.message === 'string') {
      if (/\b(502|503|504|403|404|500|acme|forbidden|unavailable|timeout|failed|error)\b/i.test(error.message)) {
        shouldNotify = true;
      } else {
        userMessage = error.message;
      }
    }
    if (shouldNotify) {
      sendErrorEmail({
        subject: `[SSL Generator] Eroare API: ${error?.message?.slice(0, 80)}`,
        text: `Eroare API:\n${error?.stack || error?.message}\n\nRequest: ${JSON.stringify({
          url: req.url,
          body: req.body,
          headers: req.headers,
        }, null, 2)}`,
      });
    }
    json(res, 500, { error: userMessage });
  }
}