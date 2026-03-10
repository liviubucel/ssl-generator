# 🔐 Free SSL Certificate Generator

<p align="center">
  <img src="https://github.com/user-attachments/assets/f1f4db59-5603-42cc-930a-65a930d66f2f" alt="Zebrabyte SSL Generator" width="300">
</p>

<p align="center">
  <strong>Built by <a href="https://liviubucel.com">Liviu Bucel</a> for <a href="https://zebrabyte.ro">Zebrabyte Limited</a></strong>
</p>

<p align="center">
  A free SSL certificate generator powered by the ACME protocol, deployed on Cloudflare Workers with a Railway backend proxy.<br>
  Supports multiple Certificate Authorities and wildcard certificates.
</p>

<p align="center">
  <a href="https://ssl-gratis.zebrabyte.ro/"><img src="https://img.shields.io/badge/Live%20Demo-ssl--gratis.zebrabyte.ro-red?style=for-the-badge" alt="Live Demo"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-orange" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Railway-Deployed-blueviolet" alt="Railway">
  <img src="https://img.shields.io/badge/Let's%20Encrypt-Supported-blue" alt="Let's Encrypt">
  <img src="https://img.shields.io/badge/ZeroSSL-Supported-brightgreen" alt="ZeroSSL">
</p>

---

## 🏗️ Architecture

```
Browser
  │
  ▼
Cloudflare Worker (src/worker.ts)
  │
  ├──► Let's Encrypt  →  via Railway Proxy (ssl-acme-engine)
  └──► ZeroSSL        →  direct (no proxy needed)
```

- **Cloudflare Worker** — serves the UI and handles ACME protocol logic
- **Railway ACME Engine** — Node.js proxy that relays requests to Let's Encrypt (avoids Cloudflare-edge HTTP 525/502 errors)
- **Cloudflare KV** — stores certificate data and auto-renewal schedules
- **Resend** — sends email notifications on renewal success/failure

---

## ✅ Features

- ✅ Free SSL certificates via **Let's Encrypt** and **ZeroSSL**
- ✅ **Wildcard certificates** (`*.example.com`) — DNS-01 only
- ✅ HTTP-01 and DNS-01 challenge verification
- ✅ Download certificate, private key, and CA bundle
- ✅ **Auto-renewal** via Cloudflare Cron Triggers (daily at 2:00 AM UTC)
- ✅ **Email notifications** on renewal (via Resend)
- ✅ Railway proxy to fix Cloudflare-edge → Let's Encrypt TLS issues
- ✅ `ENGINE_TOKEN` authentication between Worker and Railway
- ✅ Bilingual UI (**English / Romanian**)
- ✅ Mobile responsive design
- ✅ Terms & Conditions acceptance (Zebrabyte + Let's Encrypt)
- ✅ Zebrabyte branding (logo, footer)

---

## 🏛️ Supported CAs

| CA | Validity | Wildcard | Support |
|----|----------|----------|---------|
| **ZeroSSL** | 90 days | ✅ | ✅ Full support by Zebrabyte |
| **Let's Encrypt** | 90 days | ✅ | ⚠️ No support by Zebrabyte |

---

## ⚙️ Environment Variables & Secrets

Set these in **Cloudflare Workers → Settings → Variables and Secrets**:

| Secret | Required | Description |
|--------|----------|-------------|
| `ACME_ENGINE_URL` | ✅ | Railway proxy URL |
| `ENGINE_TOKEN` | ✅ | Shared secret between Worker and Railway proxy |
| `EAB_KID` | ZeroSSL | ZeroSSL EAB Key ID |
| `EAB_HMAC_KEY` | ZeroSSL | ZeroSSL EAB HMAC Key |
| `CF_API_TOKEN` | Auto-renewal | Cloudflare API token (Zone:DNS:Edit) |
| `RESEND_API_KEY` | Email | Resend API key for renewal notifications |

Set these in **Railway → ssl-acme-engine → Variables**:

| Variable | Required | Description |
|----------|----------|-------------|
| `ENGINE_TOKEN` | ✅ | Must match the Worker secret |

---

## 🗄️ Cloudflare KV Setup

```bash
wrangler kv namespace create SSL_STORE
```

```toml
[[kv_namespaces]]
binding = "SSL_STORE"
id = "YOUR_KV_NAMESPACE_ID"

[triggers]
crons = ["0 2 * * *"]
```

---

## 🔄 Auto-Renewal

Auto-renewal works **only** when:
1. User enabled "Enable automatic certificate renewal"
2. Used DNS-01 challenge
3. `CF_API_TOKEN` is configured
4. Domain is on Cloudflare DNS

> For other DNS providers, users receive an email reminder 30 days before expiry.

---

## 🚂 Railway ACME Engine

The Railway service acts as an HTTP proxy between the Cloudflare Worker and ACME CAs. Only whitelisted ACME hosts are allowed:

- `acme-v02.api.letsencrypt.org`
- `acme-staging-v02.api.letsencrypt.org`
- `acme.zerossl.com`

Authentication is enforced via `ENGINE_TOKEN` Bearer token.

---

## 📁 Project Structure

```
ssl-generator/
├── public/
│   └── index.html          # Frontend UI (vanilla JS, bilingual EN/RO)
├── src/
│   ├── worker.ts           # Cloudflare Worker entry point
│   ├── acme.ts             # ACME protocol implementation
│   ├── renewal.ts          # Auto-renewal logic + email notifications
│   ├── dns.ts              # Cloudflare DNS API helpers
│   └── asn1.ts             # CSR generation utilities
├── wrangler.toml           # Cloudflare Worker configuration
└── package.json
```

---

## 🔗 Related Repositories

- **ACME Engine (Railway proxy)**: [github.com/liviubucel/ssl-acme-engine](https://github.com/liviubucel/ssl-acme-engine)

---

## 💻 Development

```bash
npm install
npm run dev
```

## 🚀 Deployment

```bash
npx wrangler deploy

wrangler secret put ACME_ENGINE_URL
wrangler secret put ENGINE_TOKEN
wrangler secret put EAB_KID
wrangler secret put EAB_HMAC_KEY
wrangler secret put CF_API_TOKEN
wrangler secret put RESEND_API_KEY
```

---

## 👤 Author

**Liviu Bucel** — [liviubucel.com](https://liviubucel.com)  
**Zebrabyte Limited** — [zebrabyte.ro](https://zebrabyte.ro)  
Company No. 15194067 | ICO Reference: ZB74870

---

## 📄 License

[MIT](https://choosealicense.com/licenses/mit/)



