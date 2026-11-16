# Architecture

One Node.js process, one SQLite file, no build step. Chosen so the whole system runs locally with
`npm start` and can be backed up by copying a directory.

```
Browser (vanilla JS SPA, public/)
        │  JSON over HTTP, session cookie
┌───────▼─────────────────────────────────────────────────────────┐
│ Express app (src/server.js)                                     │
│  /api/*  auth-gated routes      /c/:t  click redirect (public)  │
│  api-core.js  api-campaigns.js  /u/:t  unsubscribe   (public)   │
├─────────────────────────────────────────────────────────────────┤
│ Domain services                                                 │
│  verify/engine     leads/import       domains/health            │
│  accounts/service  campaigns/readiness, render                  │
│  engine/scheduler, transport          inbox/sync                │
│  ai/assistant, lint                   analytics/metrics         │
├─────────────────────────────────────────────────────────────────┤
│ lib/dns (injectable resolver)   crypto (AES-GCM, scrypt)   db   │
└───────┬───────────────┬──────────────────┬──────────────────────┘
     SQLite          SMTP / IMAP        DNS, Claude API
   data/outbound.db  (nodemailer,       (optional)
                      imapflow)
```

## Background loops (`src/server.js`)

| Loop | Default interval | Work |
|---|---|---|
| Sender | 30 s | `tick()`: for each active campaign inside its window, send at most one due email per available inbox |
| Inbox | 120 s | IMAP fetch of new messages per account → `processInbound()` |
| Domains | 6 h | Re-run every domain check, store history, raise or resolve alerts |

Each loop skips a run if the previous one is still going. Set `SCHEDULER=off` to disable all three.

## Sending engine

1. Select active campaigns whose local time (campaign time zone) is inside the window on an enabled weekday.
2. Circuit breaker: pause the campaign if measured hard bounces exceed 8% after 20 sends.
3. Load due `campaign_leads` (follow-ups before first touches), up to the campaign daily limit.
4. Pick an inbox: the one that already emailed this lead (so follow-ups thread); otherwise the
   least-used inbox that is healthy, under its daily limit (ramp-up aware) and past its cool-down.
   If the lead's inbox is merely busy, wait for it; if it can no longer send, fall back.
5. Pre-send gate (see VALIDATION.md). Skip step conditions that are not met.
6. Choose the A/B variant deterministically from the lead id, render, compose text + HTML,
   add `List-Unsubscribe` / `List-Unsubscribe-Post`, thread with `In-Reply-To` / `References`.
7. Deliver. On success record the event, schedule the next step and set the inbox cool-down to a random
   value between the campaign's min and max interval.
8. On failure classify: authentication (stop the account), recipient rejection (hard bounce,
   suppress), or transient (retry in 30 minutes, three attempts).

Step delays are "days after the previous step". Follow-ups with an empty subject reuse `Re: <first subject>`.

## Data model (main tables)

| Table | Purpose |
|---|---|
| `leads` | Contact + company fields, tags, custom fields (JSON), flags, verification status / confidence / timestamp / detail |
| `imports` | Staged rows, validation report, commit result |
| `suppressions` | Emails and domains never to be contacted, with reason |
| `accounts` | Mailboxes; credentials encrypted; limits, ramp-up, last check results |
| `domains`, `domain_checks` | Current health and history |
| `campaigns`, `steps`, `variants`, `campaign_accounts` | Sequence definition |
| `campaign_leads` | Per-lead sequence state (unique per campaign + lead) |
| `messages` | Every outbound and stored inbound message; `simulated` flag |
| `events` | Append-only facts: sent, bounce_hard, bounce_soft, reply, click, unsubscribe, complaint, meeting_booked, blocked, send_failed, auth_failure |
| `links`, `unsub_tokens` | Random tokens for click and unsubscribe URLs |
| `ai_drafts` | AI output awaiting review, with sources |
| `alerts`, `audit_log` | Open problems; who did what |

Analytics are computed from `events` (and current reply labels on `messages`), so they can be
recomputed and filtered without counters drifting.

## Testability

External systems sit behind small seams that tests replace: `setResolver()` for DNS,
`transport.deliver` for SMTP, `testers.smtp/imap` for connection checks, `fetcher.page` and
`ai.client` for the assistant, `{ probe }` for SMTP verification. `processInbound()` is independent
of IMAP so reply and bounce handling are tested directly.

## Security

| Concern | Measure |
|---|---|
| Passwords | scrypt with per-user salt; minimum length 10; login throttled per IP + email |
| Sessions | 256-bit random token, only its SHA-256 stored; `HttpOnly`, `SameSite=Lax`, `Secure` when `PUBLIC_URL` is https |
| CSRF | SameSite cookie plus a required custom header on every state-changing API call |
| Mailbox credentials | AES-256-GCM at rest; never returned by the API |
| XSS | UI builds DOM nodes with text content (no HTML strings); CSP `default-src 'self'`, no inline scripts |
| SQL injection | Parameterised statements throughout; sort columns whitelisted |
| SSRF (AI research fetch) | http(s) only, DNS-resolved address must be public, redirects re-checked, size and time limits |
| Prompt injection | Fetched pages and inbound replies are delimited as untrusted data; model output is structured and quote-checked |
| CSV injection | Exported cells starting with `= + - @` are neutralised |
| OAuth | Single-use `state` bound to the signed-in user, 10-minute expiry |
| Tracking endpoints | Unguessable tokens; unsubscribe requires POST so link scanners cannot unsubscribe people |
| Error handling | Only deliberate errors expose a message; parser and internal errors return a generic one |
| Privacy | Inbound mail that is not a reply to a tracked message is never stored |

Single-user by design: there are no roles or workspaces. Run it behind HTTPS if it is reachable
from the internet.
