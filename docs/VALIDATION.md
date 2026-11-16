# Validation rules

Every rule below is enforced in code and covered by a test. "Blocks" means the operation is refused.

## Lead import (`src/leads/import.js`)

Import is two-phase: **stage** (parse + validate + report) then **commit**. Staging writes nothing to
the leads table.

| Check | Outcome |
|---|---|
| Email syntax (RFC 5321 limits, dot-atom local part, LDH domain with TLD) | Row rejected |
| Missing mandatory field (email always; first name / company optional) | Row rejected |
| Duplicate within the file | Later rows rejected, naming the first row |
| Lead already exists | Row rejected |
| Address or domain on the suppression list | Row rejected |
| Domain has no MX and no A record, or a null MX | Row rejected |
| Domain could not be looked up (DNS failure) | Imported, flagged `domain_unchecked` |
| Disposable provider | Imported, flagged `disposable` |
| Role address (info@, sales@ ...) | Imported, flagged `role_based` |
| Malformed company (placeholder text, URL, email, symbols) | Imported, flagged `malformed_company` |
| Source date older than 12 months | Imported, flagged `possibly_outdated` |
| Likely typo of a major mailbox domain | Imported, flagged with the suggestion |

Each rejected row is counted under exactly one reason so the report adds up. A CSV report of every
rejected and flagged row is downloadable. Imported leads start as **unverified**.

A broken network that answers "not found" for everything is detected with a canary lookup, so it
produces "unchecked", never "invalid".

## Email verification (`src/verify/engine.js`)

| Status | Meaning | Requires |
|---|---|---|
| valid | Server accepted this recipient and rejected a random one | Completed SMTP probe |
| invalid | Bad syntax, no mail server, null MX, or recipient rejected (5xx) | Syntax / DNS / SMTP |
| catch_all | Server accepts any recipient | Completed SMTP probe |
| risky | Mailbox full, typo domain, or provider that accepts then bounces | DNS / SMTP |
| disposable | Temporary mailbox provider | List match + DNS |
| role_based | Shared inbox | Pattern match |
| unknown | Could not be confirmed: probe off, timeout, greylisting, policy block, DNS failure | — |

**`valid` is never produced without a completed mailbox-level check.** Every result stores which
stages ran, the reasons, a confidence figure and the timestamp. Results older than 90 days do not
satisfy a campaign threshold. Editing a lead's email resets it to unverified. A later hard bounce
overwrites the status to invalid.

SMTP probing sends `RCPT TO` only and never `DATA`. It is off by default; check that probing is
permitted for your network and jurisdiction before enabling it.

## Sending accounts (`src/accounts/service.js`)

Checks: SMTP authentication, IMAP authentication, From/login domain alignment, SPF, DKIM, DMARC,
limit sanity. Status is **healthy** only when every required check passes; any required check that
fails gives **failing**, and any that could not be completed gives **unverified**. Failing, unverified
and paused accounts cannot send. An SMTP authentication rejection during sending marks the account
failing, raises an alert and stops it.

## Domain health (`src/domains/health.js`)

SPF (missing, multiple records, `+all`, more than 10 lookups, weak `?all`), DKIM (key present per
selector, key length), DMARC (missing, multiple, policy, reporting), MX, propagation across public
resolvers, domain blocklists, measured bounce rate, recorded complaint rate, volume spikes,
authentication failures.

- The score counts only what was measured. Unknown checks earn nothing and are listed as unverified.
- A failing required check caps the score at 49 and marks the domain unhealthy, with an alert.
- DKIM not found under common selectors is "unverified", not "missing", because selectors cannot be listed.
- Blocklists that refuse the query are "unknown", not "clean".
- No result claims inbox placement; the result carries an explicit disclaimer.

## Campaign launch (`src/campaigns/readiness.js`)

`POST /api/campaigns/:id/launch` re-runs the checklist server-side and refuses with HTTP 422 if any
item is blocking. Resuming a paused campaign goes through the same gate.

| Item | Blocks when |
|---|---|
| Lead list | No queued leads |
| Email verification | Any lead is below the threshold, never verified, or stale |
| Sending accounts | None selected, or any is failing / unverified / paused |
| Sandbox isolation | Sandbox and real accounts mixed |
| Domain authentication | SPF, DKIM or DMARC failing or unverified, blocklisted, or check older than 48h |
| Duplicates | Same recipient twice (also prevented by a database constraint) |
| Suppression | Any recipient unsubscribed, bounced or suppressed |
| Sequence | No steps, empty body, missing first subject, follow-up delay under 1 day |
| Content | Unknown variable, broken placeholder, fake "Re:"/"Fwd:" subject, URL shortener, AI drafts awaiting review |
| Personalisation | Any variable without a fallback is empty for any recipient |
| Limits | An account has no capacity |
| Schedule | Invalid window, days, time zone or intervals |
| Public URL | `PUBLIC_URL` is localhost for a real campaign |

Warnings (do not block): DNS-only threshold, campaign limit above capacity, lead also in another
active campaign, spam-associated wording, missing postal address.

Editing email content on a live campaign pauses it so it must pass the gate again.

## Before every individual send (`src/engine/scheduler.js`)

Re-checked per recipient immediately before sending: suppression, verification threshold, reply
received, variables resolve, non-empty subject and body, account can send, account and campaign daily
limits, sending window. A blocked send is recorded as a `blocked` event with its reason.

Automatic stops: hard bounce (suppress + stop), unsubscribe (suppress + stop everywhere), reply (stop),
three transient failures for a step (stop), campaign hard-bounce rate above 8% after 20 sends (pause +
alert), no healthy account (pause + alert).

## AI output (`src/ai/assistant.js`)

- Opening lines are researched from the lead's own website. The model must return a verbatim quote for
  every fact; each quote is searched for in the fetched page text in code. If any quote is absent the
  draft is discarded.
- Surviving drafts are stored as **pending** with source URL, fetch time and quotes. They are applied to
  the lead only when a person approves them.
- Rewrites, variations and subject suggestions are shown for review and linted; nothing is applied
  without a click.
- Web page content and inbound replies are passed to the model as untrusted data.

## Analytics (`src/analytics/metrics.js`)

- **Measured**: sent, failed, blocked, bounces, replies, clicks, unsubscribes, recorded complaints, meetings.
- **Estimated**: delivered = sent − bounces, labelled everywhere, including CSV column names.
- Sandbox activity is returned only in sandbox mode.
- Clicks from scanners (automated user agent, non-GET, or within 30 seconds of sending) are counted separately.
- Open tracking is not implemented.
- Reply sentiment is a classification (keywords or AI) and is labelled with its source; manual corrections win.
