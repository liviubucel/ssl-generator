// Auto-renewal logic with KV storage

import { handleCreateOrder, handleVerifyOrder } from './acme';
import { createDnsTxtRecord, deleteDnsTxtRecord, findZoneId } from './dns';

export interface Env {
  SSL_STORE?: KVNamespace;
  EAB_KID?: string;
  EAB_HMAC_KEY?: string;
  CF_API_TOKEN?: string;
  RESEND_API_KEY?: string;
}

export interface RenewalConfig {
  domains: string[];
  email: string;
  ca: string;
  challengeType: string;
  accountKeyPair: JsonWebKey;
  accountUrl: string;
  certificate: string;
  privateKey: string;
  intermediateCert: string;
  autoRenew: boolean;
  notifyEmail: string | null;
  notifyDaysBefore: number;
  createdAt: string;
  lastRenewalAttempt: string | null;
  lastRenewalStatus: string | null;
}

const RENEWAL_PREFIX = 'renewal:';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DNS_PROPAGATION_DELAY_MS = 15000;

export async function saveRenewalConfig(
  kv: KVNamespace,
  config: RenewalConfig
): Promise<void> {
  const key = `${RENEWAL_PREFIX}${config.domains.join(',')}`;
  await kv.put(key, JSON.stringify(config));
}

export async function listRenewals(
  kv: KVNamespace
): Promise<Array<{ key: string; config: RenewalConfig }>> {
  const list = await kv.list({ prefix: RENEWAL_PREFIX });
  const renewals: Array<{ key: string; config: RenewalConfig }> = [];

  for (const key of list.keys) {
    const value = await kv.get(key.name);
    if (value) {
      try {
        renewals.push({ key: key.name, config: JSON.parse(value) });
      } catch {
        /* skip invalid entries */
      }
    }
  }

  return renewals;
}

export async function deleteRenewal(
  kv: KVNamespace,
  key: string
): Promise<void> {
  await kv.delete(key);
}

function shouldRenew(config: RenewalConfig): boolean {
  if (!config.autoRenew) return false;

  const created = new Date(config.createdAt);
  const now = new Date();

  // Estimate expiry based on CA validity periods
  const validityDays = 90; // Let's Encrypt, ZeroSSL

  const expiryDate = new Date(
    created.getTime() + validityDays * MS_PER_DAY
  );
  const renewalDate = new Date(
    expiryDate.getTime() - config.notifyDaysBefore * MS_PER_DAY
  );

  return now >= renewalDate;
}

// Extract the base domain for Cloudflare zone lookup.
// Note: This simple approach may not work for multi-level TLDs like co.uk.
// For production use, consider a public suffix list library.
function getBaseDomain(domain: string): string {
  const d = domain.startsWith('*.') ? domain.slice(2) : domain;
  const parts = d.split('.');
  if (parts.length <= 2) return d;
  return parts.slice(-2).join('.');
}

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string
): Promise<void> {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SSL Generator <noreply@zebrabyte.ro>',
        to: [to],
        subject,
        html,
      }),
    });
  } catch (err) {
    console.error('Failed to send email:', err);
  }
}

export async function handleScheduledRenewal(env: Env): Promise<void> {
  if (!env.SSL_STORE) {
    console.log('SSL_STORE KV not configured, skipping renewal check');
    return;
  }

  const renewals = await listRenewals(env.SSL_STORE);

  for (const { config } of renewals) {
    if (!shouldRenew(config)) continue;

    console.log(`Attempting renewal for: ${config.domains.join(', ')}`);

    try {
      // Create new ACME order
      const orderResult = await handleCreateOrder({
        domains: config.domains.join(','),
        email: config.email,
        ca: config.ca,
        eabKid: env.EAB_KID,
        eabHmacKey: env.EAB_HMAC_KEY,
      });

      // For DNS challenges, auto-create TXT records if CF_API_TOKEN is available
      if (config.challengeType === 'dns-01' && env.CF_API_TOKEN) {
        const createdRecords: Array<{ zoneId: string; recordId: string }> = [];

        try {
          for (const auth of orderResult.authorizations) {
            if (auth.challenges.dns) {
              const baseDomain = getBaseDomain(auth.domain);
              const zoneId = await findZoneId(env.CF_API_TOKEN, baseDomain);

              if (zoneId) {
                const recordId = await createDnsTxtRecord(
                  env.CF_API_TOKEN,
                  zoneId,
                  auth.challenges.dns.name,
                  auth.challenges.dns.value
                );
                if (recordId) {
                  createdRecords.push({ zoneId, recordId });
                }
              }
            }
          }

          // Wait for DNS propagation
          await new Promise((resolve) => setTimeout(resolve, DNS_PROPAGATION_DELAY_MS));

          // Verify and get certificate
          const verifyResult = await handleVerifyOrder({
            accountKeyPair: orderResult.accountKeyPair,
            accountUrl: orderResult.accountUrl,
            orderUrl: orderResult.orderUrl,
            finalizeUrl: orderResult.finalizeUrl,
            authorizations: orderResult.authorizations,
            ca: orderResult.ca,
            challengeType: config.challengeType,
          });

          if (verifyResult.status === 'valid' && verifyResult.certificate) {
            config.certificate = verifyResult.certificate;
            config.privateKey = verifyResult.privateKey || config.privateKey;
            config.intermediateCert =
              verifyResult.intermediateCert || config.intermediateCert;
            config.createdAt = new Date().toISOString();
            config.lastRenewalAttempt = new Date().toISOString();
            config.lastRenewalStatus = 'success';
            await saveRenewalConfig(env.SSL_STORE, config);
            console.log(`Successfully renewed certificate for: ${config.domains.join(', ')}`);

            if (env.RESEND_API_KEY && config.notifyEmail) {
              await sendEmail(
                env.RESEND_API_KEY,
                config.notifyEmail,
                `✅ SSL Certificate Renewed: ${config.domains[0]}`,
                `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                  <img src="https://static-media.zebrabyte.ro/Zebrabyte-Logo-black.png" alt="Zebrabyte" style="height:36px;margin-bottom:24px">
                  <h2 style="color:#27ae60">Certificate Renewed Successfully</h2>
                  <p>Your SSL certificate for <strong>${config.domains.join(', ')}</strong> has been automatically renewed.</p>
                  <p>The new certificate is valid for <strong>90 days</strong>.</p>
                  <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
                  <p style="color:#888;font-size:12px">© 2015 - 2025 ZEBRABYTE LIMITED. All Rights Reserved.</p>
                </div>`
              );
            }
          } else {
            config.lastRenewalAttempt = new Date().toISOString();
            config.lastRenewalStatus = `failed: ${verifyResult.error || 'Unknown error'}`;
            await saveRenewalConfig(env.SSL_STORE, config);
            console.error(`Renewal verification failed for: ${config.domains.join(', ')}`);

            if (env.RESEND_API_KEY && config.notifyEmail) {
              await sendEmail(
                env.RESEND_API_KEY,
                config.notifyEmail,
                `⚠️ SSL Renewal Failed: ${config.domains[0]}`,
                `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                  <img src="https://static-media.zebrabyte.ro/Zebrabyte-Logo-black.png" alt="Zebrabyte" style="height:36px;margin-bottom:24px">
                  <h2 style="color:#c0392b">Certificate Renewal Failed</h2>
                  <p>Automatic renewal for <strong>${config.domains.join(', ')}</strong> has failed.</p>
                  <p>Error: ${verifyResult.error || 'Unknown error'}</p>
                  <p>Please visit <a href="https://ssl.zebrabyte.ro">ssl.zebrabyte.ro</a> to renew manually.</p>
                  <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
                  <p style="color:#888;font-size:12px">© 2015 - 2025 ZEBRABYTE LIMITED. All Rights Reserved.</p>
                </div>`
              );
            }
          }
        } finally {
          // Clean up DNS TXT records
          for (const record of createdRecords) {
            try {
              await deleteDnsTxtRecord(
                env.CF_API_TOKEN!,
                record.zoneId,
                record.recordId
              );
            } catch {
              /* ignore cleanup errors */
            }
          }
        }
      } else {
        config.lastRenewalAttempt = new Date().toISOString();
        config.lastRenewalStatus =
          'skipped: DNS challenge requires CF_API_TOKEN secret';
        await saveRenewalConfig(env.SSL_STORE, config);
      }
    } catch (error: any) {
      config.lastRenewalAttempt = new Date().toISOString();
      config.lastRenewalStatus = `error: ${error.message}`;
      await saveRenewalConfig(env.SSL_STORE, config);
      console.error(
        `Renewal error for ${config.domains.join(', ')}:`,
        error.message
      );
    }
  }
}
