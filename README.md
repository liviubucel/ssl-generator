# Free SSL Certificate Generator

An open-source SSL certificate generator deployed on Cloudflare Workers. Supports multiple Certificate Authorities.

## Supported CAs

- **Let's Encrypt** — 90-day certificates
- **Buypass** — 180-day certificates
- **ZeroSSL** — 90-day certificates (requires EAB credentials)

## Features

- HTTP-01 and DNS-01 challenge verification
- Wildcard SSL certificate support (DNS-01 only)
- Download certificate, private key, and CA bundle
- Runs entirely on Cloudflare Workers (no traditional server needed)

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npx wrangler deploy
```

## Badges

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://choosealicense.com/licenses/mit/)

## Acknowledgements

- [SSL Certificate Generator](https://punchsalad.com/ssl-certificate-generator/)
- [Let's Encrypt](https://letsencrypt.org/)
- [Buypass](https://www.buypass.com/)
- [ZeroSSL](https://zerossl.com/)

## License

[MIT](https://choosealicense.com/licenses/mit/)
