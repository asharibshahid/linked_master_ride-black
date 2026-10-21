# ACE Dispatch Client Dashboard

This folder is a standalone Vercel frontend. It does not run WhatsApp, OTS, Google Sheets, Supabase migrations, or calendar jobs.

## Deploy to Vercel

1. Import the same GitHub repository into Vercel.
2. Set **Root Directory** to `dashboard`.
3. Add the Vercel environment variable:

```text
DASHBOARD_API_BASE_URL=https://api.your-domain.com
```

4. From the repository root, run `npm run dashboard:deploy`. This deploys the `dashboard/` folder and moves the live `ots-chat.vercel.app` alias to that exact deployment. Do not use a raw production Vercel deploy for this dashboard, because Vercel's project default alias is different.

The dashboard HTML, JavaScript, and CSS are delivered with `no-store` headers, so a browser revalidates the current interface instead of holding an old dashboard release.

## Backend VPS configuration

The VPS must be exposed through HTTPS before the Vercel UI is connected. Add its Vercel URL(s) to:

```text
DASHBOARD_ALLOWED_ORIGINS=https://your-project.vercel.app
```

For a production custom domain, add both the Vercel deployment domain and customer-facing domain, comma-separated. Keep `DASHBOARD_AUTH_TOKEN` enabled on the VPS.

Never add `DATABASE_URL`, Google service-account JSON, WhatsApp session files, or service-role keys to Vercel.
