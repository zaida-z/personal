# Setup and requirements

## 1. Run it locally

Requirements: Node.js 22.5 or newer (uses the built-in `node:sqlite`). No database server, no Docker.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Open http://localhost:4100. The first visit asks you to create the admin account.

Everything is stored under `DATA_DIR` (default `./data`):

- `outbound.db` — the SQLite database
- `secret.key` — the key that encrypts mailbox passwords (only created if `APP_SECRET` is unset).
  **Back this file up.** Without it stored credentials cannot be decrypted.

## 2. What I need from you to make real sending work

Nothing below can be created by the software; each item is something you own or must decide.

### Required

1. **A sending domain you control**, ideally a separate domain or subdomain from your main one
   (for example `getacme.com` next to `acme.com`), so cold outreach reputation is isolated.
2. **At least one mailbox on that domain** and its credentials:
   - Google Workspace / Gmail: enable 2-Step Verification, create an *app password*, and make sure IMAP is on.
   - Microsoft 365: enable *Authenticated SMTP* for the mailbox in the admin centre.
   - Anything else: SMTP host/port and IMAP host/port plus username and password.
3. **DNS access for the domain** to publish SPF, DKIM and DMARC. Add the domain under
   *Domain health*; each failing check shows the exact record to add. Enter your DKIM selector there
   (Google: `google`; Microsoft: `selector1`), because selectors cannot be discovered automatically.
4. **A public HTTPS URL for this server** set as `PUBLIC_URL`. Unsubscribe links and click-tracking
   links point at it. While it is `localhost`, campaigns using real accounts are blocked from launching,
   because recipients could not unsubscribe. Options: a small VPS, or a tunnel
   (Cloudflare Tunnel, Tailscale Funnel, ngrok) to your machine. Only `/c/*` and `/u/*` need to be reachable
   by recipients.
5. **Your postal address** as `SENDER_POSTAL_ADDRESS`. CAN-SPAM requires a physical address in commercial email.
6. **Leads you are allowed to contact**, as CSV or XLSX with a header row.

**Connecting many mailboxes at once:** on *Email accounts*, click **Import from CSV**. Any CSV/XLSX with
Email, SMTP Password, SMTP Host and SMTP Port columns works, including Instantly's export (a blank template is
linked in the dialog). Warm-up columns are ignored. Each account is saved encrypted and gets the normal
connection checks; connecting sends no email. Delete the file from your computer afterwards.

### Optional, and what you lose without each

| Item | Setting | Without it |
|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY` | No AI drafting, rewriting or AI review. Heuristic content checks and keyword reply classification still work. |
| Outbound port 25 | `SMTP_PROBE=on`, `SMTP_PROBE_HELO`, `SMTP_PROBE_FROM` | No address can be marked **valid**; verification covers syntax, DNS/MX, disposable and role detection, and reports deliverable-looking addresses as **unknown**. Campaigns then need the "DNS-verified" threshold, or a list verified elsewhere. Most ISPs and clouds block port 25. |
| Google OAuth client | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Connect Gmail with an app password instead. Redirect URI: `<PUBLIC_URL>/api/oauth/google/callback`. |
| Microsoft OAuth app | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Connect with SMTP AUTH instead. Redirect URI: `<PUBLIC_URL>/api/oauth/microsoft/callback`. |
| A non-public DNS resolver or Spamhaus DQS key | system resolver | Blocklist checks report "unknown": Spamhaus, SURBL and URIBL refuse queries from public resolvers such as 8.8.8.8. |
| Google Postmaster Tools / Microsoft SNDS | external | No domain reputation or Gmail complaint-rate data. The app cannot see these; check them yourself and log complaints under Settings. |

### Decisions I need from you

- **Verification threshold** per campaign: valid only, or also catch-all / role-based / DNS-only.
- **Daily volume per inbox.** Default 30; around 30–50 is the commonly cited safe ceiling for cold email.
- **Time zone and sending window** per campaign.

## 3. Going live checklist

1. Connect the account → status must be **healthy** (or healthy with warnings).
2. *Domain health* shows SPF, DKIM and DMARC passing.
3. Import leads → review the validation report → commit.
4. Select leads → **Verify emails**.
5. Build the campaign, add leads, open **Readiness & launch**. Fix every failing item.
6. Launch. The scheduler sends inside the window, rotating inboxes with random gaps.
7. Watch the first day's bounces. The campaign pauses itself if hard bounces exceed 8% after 20 sends.

## 4. Rehearse first

Add a **Sandbox** account (sends nothing), or run `npm run seed:demo`. Sandbox activity is flagged
simulated everywhere, excluded from real analytics and from domain health metrics. The seed script's
leads use the reserved `.example` domain and are marked "valid" by the script rather than by a real
check; each one says so in its verification detail.

## 5a. Team access and your own domain

*Settings → Team access*: the owner (first account) adds teammates with a temporary password; they can change it
under "Change my password". Everyone has full access. Removing someone signs them out immediately.

To reach the app at an address like `app.yourdomain.com`, point a subdomain at wherever it runs, then set
`PUBLIC_URL=https://app.yourdomain.com`: a Cloudflare Tunnel (runs on your own machine, free, handles HTTPS) or a
small server with a persistent disk. Always serve it over HTTPS; sign-in is a password only (no 2FA yet).

## 5. Running it continuously

Sending, inbox sync and domain monitoring run only while `npm start` is running. On a server, run it
under a process manager (systemd, pm2) behind an HTTPS reverse proxy. Back up `DATA_DIR`.
