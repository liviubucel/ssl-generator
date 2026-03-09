// ASN.1 DER encoding utilities for CSR generation

function encodeLengthBytes(length: number): number[] {
  if (length < 0x80) return [length];
  if (length < 0x100) return [0x81, length];
  if (length < 0x10000) return [0x82, (length >> 8) & 0xff, length & 0xff];
  return [0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
}

function asn1Sequence(contents: number[]): number[] {
  return [0x30, ...encodeLengthBytes(contents.length), ...contents];
}

function asn1Set(contents: number[]): number[] {
  return [0x31, ...encodeLengthBytes(contents.length), ...contents];
}

function asn1Integer(value: number): number[] {
  if (value === 0) return [0x02, 0x01, 0x00];
  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return [0x02, ...encodeLengthBytes(bytes.length), ...bytes];
}

function asn1OID(oid: number[]): number[] {
  const encoded: number[] = [40 * oid[0] + oid[1]];
  for (let i = 2; i < oid.length; i++) {
    let val = oid[i];
    if (val >= 0x80) {
      const parts: number[] = [];
      parts.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        parts.unshift((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.push(...parts);
    } else {
      encoded.push(val);
    }
  }
  return [0x06, ...encodeLengthBytes(encoded.length), ...encoded];
}

function asn1UTF8String(str: string): number[] {
  const bytes = new TextEncoder().encode(str);
  return [0x0c, ...encodeLengthBytes(bytes.length), ...Array.from(bytes)];
}

function asn1BitString(data: number[]): number[] {
  return [0x03, ...encodeLengthBytes(data.length + 1), 0x00, ...data];
}

function asn1OctetString(data: number[]): number[] {
  return [0x04, ...encodeLengthBytes(data.length), ...data];
}

function asn1ContextTag(tagNumber: number, contents: number[], constructed = true): number[] {
  const tag = 0x80 | (constructed ? 0x20 : 0) | tagNumber;
  return [tag, ...encodeLengthBytes(contents.length), ...contents];
}

// OIDs
const OID_CN = [2, 5, 4, 3];
const OID_SHA256_WITH_RSA = [1, 2, 840, 113549, 1, 1, 11];
const OID_EXTENSION_REQUEST = [1, 2, 840, 113549, 1, 9, 14];
const OID_SUBJECT_ALT_NAME = [2, 5, 29, 17];

function buildSANExtension(domains: string[]): number[] {
  const names: number[] = [];
  for (const domain of domains) {
    const domainBytes = new TextEncoder().encode(domain);
    names.push(...asn1ContextTag(2, Array.from(domainBytes), false));
  }
  const sanValue = asn1Sequence(names);
  const sanOctetString = asn1OctetString(sanValue);
  const extension = asn1Sequence([...asn1OID(OID_SUBJECT_ALT_NAME), ...sanOctetString]);
  const extensions = asn1Sequence([...extension]);
  return extensions;
}

function buildSubject(cn: string): number[] {
  const atv = asn1Sequence([...asn1OID(OID_CN), ...asn1UTF8String(cn)]);
  const rdn = asn1Set(atv);
  return asn1Sequence([...rdn]);
}

export async function generateCSR(
  domains: string[],
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<ArrayBuffer> {
  const subject = buildSubject(domains[0]);

  // Export public key as SPKI
  const spkiDer = await crypto.subtle.exportKey('spki', publicKey) as ArrayBuffer;
  const spkiBytes = Array.from(new Uint8Array(spkiDer));

  // Build extensions attribute (SAN)
  const sanExt = buildSANExtension(domains);
  const extAttr = asn1Sequence([
    ...asn1OID(OID_EXTENSION_REQUEST),
    ...asn1Set(sanExt),
  ]);
  const attributes = asn1ContextTag(0, extAttr);

  // Build CertificationRequestInfo
  const certRequestInfo = asn1Sequence([
    ...asn1Integer(0), // version
    ...subject,
    ...spkiBytes,
    ...attributes,
  ]);

  // Sign the CertificationRequestInfo
  const certRequestInfoBuffer = new Uint8Array(certRequestInfo);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    certRequestInfoBuffer
  );

  // Build the final CSR
  const signatureAlgorithm = asn1Sequence(asn1OID(OID_SHA256_WITH_RSA));
  const signatureBitString = asn1BitString(Array.from(new Uint8Array(signature)));

  const csr = asn1Sequence([
    ...certRequestInfo,
    ...signatureAlgorithm,
    ...signatureBitString,
  ]);

  return new Uint8Array(csr).buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  return arrayBufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return base64ToArrayBuffer(base64);
}

export function pemFromDer(der: ArrayBuffer, type: string): string {
  const base64 = arrayBufferToBase64(der);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.substring(i, i + 64));
  }
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}
