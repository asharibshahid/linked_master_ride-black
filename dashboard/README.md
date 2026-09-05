# ACE Dispatch Client Dashboard

This folder is a standalone Vercel frontend. It does not run WhatsApp, OTS, Google Sheets, Supabase migrations, or calendar jobs.

## Deploy to Vercel

1. Import the same GitHub repository into Vercel.
2. Set **Root Directory** to `dashboard`.
3. Add the Vercel environment variable:

```text
DASHBOARD_API_BASE_URL=https://api.your-domain.com
```

4. Deploy. The browser asks each operator for the dashboard token and name; the token is kept only in that browser's local storage.

## Backend VPS configuration

The VPS must be exposed through HTTPS before the Vercel UI is connected. Add its Vercel URL(s) to:

```text
DASHBOARD_ALLOWED_ORIGINS=https://your-project.vercel.app
```

For a production custom domain, add both the Vercel deployment domain and customer-facing domain, comma-separated. Keep `DASHBOARD_AUTH_TOKEN` enabled on the VPS.

Never add `DATABASE_URL`, Google service-account JSON, WhatsApp session files, or service-role keys to Vercel.
