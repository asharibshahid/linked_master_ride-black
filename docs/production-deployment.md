# Production Deployment

Run the dispatch backend on the VPS. Do not run WhatsApp, OTS polling, or the Node process on Vercel.

## VPS

1. Install Node 20+, Chromium dependencies, Nginx, and PM2.
2. Clone this project to a persistent path such as `/opt/taxi-dispatch`.
3. Copy the current `.env` securely to the VPS. Keep it outside source control.
4. Use a persistent WhatsApp session path:

```text
WHATSAPP_SESSION_PATH=/opt/taxi-dispatch/data/.wwebjs_auth
WHATSAPP_AUTO_CLEAR_STALE_SESSION=false
DASHBOARD_AUTH_TOKEN=<long-random-secret>
OPENAI_EXTRACTION_ENABLED=false
BID_AI_REVIEW_ENABLED=false
```

5. Install packages, migrate the database, and start PM2:

```bash
npm ci
npm run db:migrate
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
```

6. Put Nginx with HTTPS in front of port `3000`. Expose `/dashboard`, `/qr`, and `/health` through one HTTPS domain.

The dashboard's WhatsApp Restart and Reset Session controls intentionally exit the Node process. PM2 starts it again. Reset Session deletes only the saved WhatsApp session after typed confirmation, then the client scans the newly shown QR.

## Vercel dashboard

The standalone client dashboard is in `dashboard/`. Import the same repository into Vercel and set its **Root Directory** to `dashboard`.

1. First expose the VPS backend on an HTTPS domain, for example `https://api.example.com`.
2. On the VPS set:

```text
DASHBOARD_ALLOWED_ORIGINS=https://your-project.vercel.app,https://dispatch.example.com
```

3. In Vercel set the one environment variable below and redeploy:

```text
DASHBOARD_API_BASE_URL=https://api.example.com
```

The browser asks for `DASHBOARD_AUTH_TOKEN`; it is never stored in Vercel. Never put `DATABASE_URL`, Google credentials, service-role keys, WhatsApp session data, or `OPENAI_API_KEY` in Vercel.

## OTS

Keep the OTS worker on the same VPS or another private worker machine. Its saved browser login must live on persistent storage. Run its manual login once after deployment, then the main dispatch service can import and submit through the configured worker scripts.

## OpenAI Cost Control

Rule-based pricing runs locally and costs nothing. OpenAI is disabled for extraction by default. Enable `BID_AI_REVIEW_ENABLED=true` only when an operator needs the `AI Review` button for an individual bid. The review is cached per ride for 24 hours and limited to eight calls per hour per running service.
