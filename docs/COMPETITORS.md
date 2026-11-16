# Competitor analysis

Compiled November 2026. Pricing figures come from public comparison pages, several of them published
by Instantly itself, so treat them as indicative and check each vendor's pricing page before deciding.

## Summary

| | Instantly | Smartlead | Apollo | Outbound OS (this project) |
|---|---|---|---|---|
| Core strength | All-in-one cold email with a large warm-up network | High-volume sending infrastructure, agency features | B2B contact database + multichannel engagement | Validation-first sending you host yourself |
| Pricing model | Flat fee, about $47–$358/mo, unlimited inboxes; credits extra for leads and AI | Flat fee, about $39–$94/mo, unlimited inboxes; $29/client white-label; lead finder add-on | Per seat, about $49–$79+/user/mo | Free, self-hosted; you pay for mailboxes and optional API usage |
| Lead database | Yes (hundreds of millions of contacts) | Yes (add-on) | Yes, its main product | **No** — bring your own list |
| Warm-up network | Yes, millions of accounts | Yes, AI-written warm-up mail | Yes, more manual | **No** — volume ramp only |
| Inbox placement tests | Yes | Yes | Limited | **No** |
| Verification | Built in / credits | Built in / add-on | Built in | Built in; "valid" only with a completed SMTP check |
| Unified inbox | Yes | Yes | Yes | Yes |
| Open tracking | Yes | Yes | Yes | Deliberately omitted |
| Data location | Vendor cloud | Vendor cloud | Vendor cloud | Your machine |

## Where the incumbents are stronger

Stated plainly, because these gaps matter:

1. **Warm-up networks.** Instantly and Smartlead exchange mail between millions of real inboxes to
   build reputation. This project cannot replicate that; it only ramps volume gradually.
2. **Contact data.** Apollo, Instantly and Smartlead sell access to large B2B databases. Here you
   import your own leads.
3. **Inbox placement testing** against seed mailboxes at Gmail, Outlook and others.
4. **Scale and operations**: hosted, multi-user, agency workspaces, white-labelling, CRM integrations,
   LinkedIn and phone steps (Apollo).

## Where this project deliberately differs

These are responses to common complaints about the category rather than feature parity.

1. **A hard launch gate.** Competitors let you launch with warnings. Here activation is refused
   server-side until verification, authentication, suppression, personalisation and schedule checks
   pass, and recipient-level checks run again before every send.
2. **Honest status vocabulary.** Reviews of the category note that warm-up "scores" and "verified"
   badges do not equal inbox placement. Here "valid" requires a completed mailbox check, DNS-only
   results are "unknown", refused blocklist queries are "unknown" rather than "clean", and no screen
   claims inbox placement.
3. **Measured versus estimated, everywhere.** "Delivered" is labelled as an estimate in tiles,
   tables and CSV column names.
4. **No open rates.** Competitors headline them; since Apple Mail Privacy Protection they mostly
   measure proxies. Clicks are reported with security-scanner clicks separated out.
5. **Quote-verified AI personalisation.** AI opening lines must cite verbatim text from the
   prospect's own site, the citation is checked in code, and a person approves each one. This targets
   the fabricated-compliment problem of bulk AI personalisation.
6. **Sandbox rehearsal.** A full campaign can be run end to end against simulated accounts, with
   that data kept out of real analytics.
7. **Self-hosted.** Lead data and mailbox credentials stay on your machine.

## Unconventional directions worth considering next

- **Bring-your-own warm-up**: integrate a dedicated warm-up service through its API instead of building a network.
- **Seed-list placement tests**: connect a few of your own mailboxes at different providers, send each
  campaign email to them first, and read back the folder over IMAP. That would be a real, measured placement signal.
- **Postmaster Tools ingestion** to bring Gmail's own complaint and reputation data into domain health.
- **Reply-rate-based throttling**: slow a campaign automatically when replies turn negative, not only when bounces rise.
- **DMARC aggregate report parsing** (`rua`) to measure authentication results as receivers saw them.
