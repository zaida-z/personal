# Implementation status

Updated with each milestone commit. "Verified" says how a claim was checked, so nothing here is
taken on trust.

Automated tests: **44 passing** (`npm test`). UI checked by driving every page in headless Chromium
with no console errors.

## Built and verified

| Module | Feature | Verified by |
|---|---|---|
| A. Leads | CSV + XLSX import, column mapping, custom fields, tags, sources, manual add/edit, search and filters, bulk verify / tag / edit field / suppress / delete, import history, per-row error report, CSV export | Unit + HTTP tests (CSV); browser run. XLSX parsing is implemented but was not exercised with a real file |
| A. Leads | Duplicate, syntax, mandatory-field, invalid-domain, disposable, role, malformed-company, outdated-record detection; validation report before commit | Tests |
| B. Verification | Syntax, DNS, MX (implicit and null MX), disposable, role, catch-all, SMTP probe, risk classes, confidence, last-checked date; never "valid" without a completed check | Tests with DNS and SMTP fixtures |
| C. Accounts | Gmail / Microsoft 365 presets, custom SMTP + IMAP, sandbox; health checks; daily limits; volume ramp; rotation; pause; auth-failure detection | Tests with fake connections |
| D. Domains | SPF, DKIM, DMARC, MX, propagation, blocklists, measured bounce / complaint / volume / auth-failure metrics, score, fixes, history, scheduled monitoring, alerts | Tests with DNS fixtures |
| E. Campaigns | Multi-step sequences, delays, A/B variants with weights, variables with fallbacks and conditionals, step conditions (clicked / not clicked / field set), windows, time zones, daily limits, random intervals, pause / resume, duplicate, preview, readiness checklist | Tests + browser run |
| F. AI | Quote-verified opening lines from the lead's site, variations, tone rewrite, subject suggestions, AI review; heuristic checks for spam wording, generic phrasing, unsupported claims, missing variables; review queue | Tests with a stubbed model |
| G. Analytics | All listed metrics at campaign, inbox, domain, step, variant and day level; 30-day comparison; CSV export; measured / estimated labels | Tests + browser run |
| H. Inbox | Unified threads across accounts, filters, labels with source, manual reply threaded from the owning inbox, meeting marking, bounce and unsubscribe handling | Tests (processing); browser run on sandbox data |
| Tracking | Click redirect with scanner separation; two-step and one-click unsubscribe | HTTP tests |
| Security | Auth, sessions, CSRF header, encryption at rest, CSP, SSRF guard, safe errors | HTTP tests; see ARCHITECTURE.md |

## Built but NOT verified against live systems

This was developed in a sandbox with no DNS and no outbound mail access. The code paths below are
implemented and their logic is tested with stand-ins, but they have never run against the real thing.
Expect to find issues on first contact.

| Area | What is unverified |
|---|---|
| Real SMTP sending | `nodemailer` delivery through Gmail / Microsoft 365 / other SMTP |
| IMAP sync | Fetching and parsing real replies and real bounce (DSN) formats, which vary by provider |
| Live DNS | SPF / DKIM / DMARC / MX / blocklist lookups against real resolvers; DNS-over-HTTPS mode |
| SMTP probing | The port-25 conversation against real mail servers |
| OAuth | Google and Microsoft authorization-code flow and XOAUTH2 sign-in |
| Claude API | Real model calls (request shape follows the SDK docs; responses were stubbed) |

## Not built

| Requirement | State | Why |
|---|---|---|
| Warm-up integration | Volume ramp only | A warm-up network needs a pool of cooperating inboxes; no third-party warm-up API is integrated |
| Domain reputation | Reported as unavailable | Only visible through Google Postmaster Tools / Microsoft SNDS for your own verified domain |
| IP blocklists | Not checked | The sending IP belongs to your mail provider and is not known here; domain blocklists only |
| Inbox placement testing | Not built | Needs seed mailboxes; see COMPETITORS.md for a proposed approach |
| Per-lead time zones | Campaign time zone only | Lead `timezone` is stored but not used for scheduling |
| Legacy `.xls` | Rejected with a message | `.xlsx` and `.csv` are supported |
| Multi-user, roles, workspaces | Single admin account | Local single-user scope |
| Spam complaint feeds | Manual recording only | Gmail does not send complaint notifications to senders |
| Server-side model fallback on refusals | Not enabled | A refusal is reported to the user instead |

## Note on the unified inbox requirement

The original brief was cut off after "Unified conversation view". Filters, labelling, replying,
meeting marking and sync were implemented as the likely intent; anything else that section listed
is not covered.

## Milestones

1. Backend core, 43 tests.
2. Web UI, sandbox demo seed, DNS-health guard, exclusive import reject counts, documentation. 44 tests.
