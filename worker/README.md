# Arcward Support API (`arcward-support-api`)

Standalone free-tier Cloudflare Worker replacing FormSubmit.co for `https://tareq7.github.io/arcward-support/`.

- **Live Endpoint:** `https://arcward-support-api.najetareqz.workers.dev`
- **Health Check:** `GET https://arcward-support-api.najetareqz.workers.dev/health`
- **Form Action:** `POST https://arcward-support-api.najetareqz.workers.dev/submit`
- **Support Address:** `care@lolly.ae` (2-business-day SLA)

## What it does
- Accepts `POST /submit` (`multipart/form-data`) directly from the GitHub Pages form (works with JS off via `303 See Other` redirect to `thanks.html`).
- Validates all Shopify Theme Store §21 required fields (`first_name`, `last_name`, `email`, `store_url`, `theme_name`, `_subject`, `description`) and optional attachments (`PNG`/`JPG`/`WebP`/`PDF` up to `10 MB`).
- Sends **two** Resend emails per submission (zero server file storage):
  1. Ticket email + attachment to `care@lolly.ae` (`reply_to: <merchant email>`).
  2. Instant auto-response to `<merchant email>` confirming receipt and the **2-business-day SLA**.
- Fails closed (`503`) with a direct `care@lolly.ae` email fallback until `ARCWARD_RESEND_API_KEY` is bound.

## One-time `lolly.ae` Resend + Tasjeel.ae DNS activation
`lolly.ae` DNS is hosted on Tasjeel.ae (`ns3.tasjeel.ae` / `ns4.tasjeel.ae`) and is kept completely isolated from Smart Creations (`smartcreations.sa`).

1. In [Resend Domains](https://resend.com/domains), click **Add Domain** -> enter **`lolly.ae`**.
2. Add the DNS records Resend shows into **Tasjeel.ae DNS** for `lolly.ae`:
   - **DKIM `TXT`** record (`resend._domainkey`)
   - **SPF `MX` + `TXT`** records on the `send` subdomain (`send.lolly.ae` — leaves your root Microsoft 365 MX `lolly-ae.mail.protection.outlook.com` and root SPF untouched!)
   - *(Optional recommended)* **DMARC `TXT`** record (`_dmarc`: `v=DMARC1; p=none;`)
3. Click **Verify** in Resend until `lolly.ae` shows **Verified**.
4. In [Resend API Keys](https://resend.com/api-keys), create a **Sending access** key restricted strictly to **`lolly.ae`**.
5. Bind the secret to the deployed Worker (on `khal` or any authenticated Wrangler machine):
   ```bash
   wrangler secret put ARCWARD_RESEND_API_KEY --name arcward-support-api
   ```
6. Verify `GET https://arcward-support-api.najetareqz.workers.dev/health` reports `"resendConfigured": true`, then submit one live test with a PNG attachment and verify ticket receipt at `care@lolly.ae` + auto-response receipt at the sender mailbox.
