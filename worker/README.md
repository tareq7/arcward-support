# Arcward Support API (`arcward-support-api`)

Standalone free-tier Cloudflare Worker replacing FormSubmit.co for `https://tareq7.github.io/arcward-support/`.

- **Live Endpoint:** `https://arcward-support-api.najetareqz.workers.dev`
- **Health Check:** `GET https://arcward-support-api.najetareqz.workers.dev/health`
- **Form Action:** `POST https://arcward-support-api.najetareqz.workers.dev/submit`

## What it does
- Accepts `POST /submit` (`multipart/form-data`) directly from the GitHub Pages form (progressive enhancement via `303 See Other` redirect to `thanks.html`).
- Validates all Shopify Theme Store §21 required fields (`first_name`, `last_name`, `email`, `store_url`, `theme_name`, `_subject`, `description`) and optional attachments (`PNG`/`JPG`/`WebP`/`PDF` up to `10 MB`).
- Sends **two** Resend emails per submission (zero server file storage):
  1. Ticket email + attachment to `t.naji@tribonds.net` (`reply_to: <merchant email>`).
  2. Instant auto-response to `<merchant email>` confirming receipt and the **2-business-day SLA**.
- Fails closed (`503`) with a direct `t.naji@tribonds.net` email fallback until `ARCWARD_RESEND_API_KEY` is bound.

## One-time `tribonds.net` Resend + GoDaddy DNS activation (Option A)
`tribonds.net` DNS is hosted on GoDaddy (`ns15.domaincontrol.com` / `ns16.domaincontrol.com`) and is kept completely isolated from Smart Creations (`smartcreations.sa`).

1. In [Resend Domains](https://resend.com/domains), click **Add Domain** → enter **`tribonds.net`**.
2. Add the DNS records Resend shows into **GoDaddy DNS** for `tribonds.net`:
   - **DKIM `TXT`** record (`resend._domainkey`)
   - **SPF `MX` + `TXT`** records on the `send` subdomain (`send.tribonds.net` — leaves your root Microsoft 365 MX and root SPF `v=spf1 include:spf.protection.outlook.com -all` untouched!)
   - *(Optional recommended)* **DMARC `TXT`** record (`_dmarc`: `v=DMARC1; p=none;`)
3. Click **Verify** in Resend until `tribonds.net` shows **Verified**.
4. In [Resend API Keys](https://resend.com/api-keys), create a **Sending access** key restricted strictly to **`tribonds.net`**.
5. Bind the secret to the deployed Worker (on `khal` or any authenticated Wrangler machine):
   ```bash
   wrangler secret put ARCWARD_RESEND_API_KEY --name arcward-support-api
   ```
6. Verify `GET https://arcward-support-api.najetareqz.workers.dev/health` reports `"resendConfigured": true`, then submit one live test with a PNG attachment and verify both ticket receipt at `t.naji@tribonds.net` and auto-response receipt at the sender mailbox.
