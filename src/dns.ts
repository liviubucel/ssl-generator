// Cloudflare DNS API integration for auto-renewal

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export async function findZoneId(apiToken: string, domain: string): Promise<string | null> {
  const resp = await fetch(
    `${CF_API_BASE}/zones?name=${encodeURIComponent(domain)}&status=active`,
    {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const data = (await resp.json()) as { success: boolean; result?: { id: string }[] };
  if (data.success && data.result && data.result.length > 0) {
    return data.result[0].id;
  }
  return null;
}

export async function createDnsTxtRecord(
  apiToken: string,
  zoneId: string,
  name: string,
  content: string
): Promise<string | null> {
  // Remove existing record with the same name first
  const existing = await findDnsTxtRecord(apiToken, zoneId, name);
  if (existing) {
    await deleteDnsTxtRecord(apiToken, zoneId, existing);
  }

  const resp = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'TXT',
      name,
      content,
      ttl: 120,
    }),
  });

  const data = (await resp.json()) as { success: boolean; result?: { id: string } };
  if (data.success && data.result) {
    return data.result.id;
  }
  return null;
}

export async function deleteDnsTxtRecord(
  apiToken: string,
  zoneId: string,
  recordId: string
): Promise<void> {
  await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });
}

async function findDnsTxtRecord(
  apiToken: string,
  zoneId: string,
  name: string
): Promise<string | null> {
  const resp = await fetch(
    `${CF_API_BASE}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`,
    {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const data = (await resp.json()) as { success: boolean; result?: { id: string }[] };
  if (data.success && data.result && data.result.length > 0) {
    return data.result[0].id;
  }
  return null;
}
