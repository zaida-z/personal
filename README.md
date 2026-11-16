# Outbound OS

A self-hosted outbound email platform: lead management, email verification, sending-account and
domain health, multi-step campaigns, AI-assisted personalisation, a unified reply inbox and analytics.
It runs locally on one machine with a single SQLite file.

**Principle:** nothing is imported, activated or sent without passing the checks that apply to it, and
nothing is reported as verified, healthy or delivered unless the system actually observed it.

## Quick start

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4100 and create the admin account. Data lives in `./data/` (git-ignored).

To explore every screen without sending anything, load the sandbox rehearsal data and switch the UI
to **Sandbox**:

```bash
npm run seed:demo
```

```bash
npm test
```

## What you need to provide for real sending

The app runs with zero configuration, but sending real email needs things only you have.
See **[docs/SETUP.md](docs/SETUP.md)** for the full list with steps. In short:

| Needed for | What |
|---|---|
| Sending and reading mail | A mailbox on a domain you control (Google Workspace, Microsoft 365 or any SMTP+IMAP) with an app password |
| Passing the launch gate | SPF, DKIM and DMARC records on that domain (the app tells you exactly what is missing) |
| Unsubscribe links and click tracking | A public HTTPS URL that reaches this server (`PUBLIC_URL`) |
| Legal footer | Your postal address (`SENDER_POSTAL_ADDRESS`) |
| AI drafting and review | `ANTHROPIC_API_KEY` |
| Confirming mailboxes exist ("valid") | Outbound port 25 (`SMTP_PROBE=on`), which most home and cloud networks block |

## Documentation

| Doc | Contents |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Requirements, configuration, going live checklist |
| [docs/STATUS.md](docs/STATUS.md) | What is built, how each part was verified, known gaps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data model, sending engine, security |
| [docs/VALIDATION.md](docs/VALIDATION.md) | Every validation rule and where it is enforced |
| [docs/COMPETITORS.md](docs/COMPETITORS.md) | Instantly, Smartlead and Apollo compared, and where this differs |
| [docs/API.md](docs/API.md) | HTTP API reference |

## Dashboard

The dashboard shows 30-day sends, estimated delivery, reply rate, positive replies, click rate
(scanner clicks separated out), bounce rate, unsubscribes and meetings, with daily charts and per-campaign
sequence progress. Real and sandbox data are never mixed: a toggle switches between them and
sandbox views carry a banner.

Open rates are deliberately not tracked. Apple Mail Privacy Protection and corporate gateways pre-load
tracking pixels, so an "open" does not show that a person read anything.

## Responsible use

Cold email is regulated (CAN-SPAM, GDPR/PECR, CASL and others). This tool enforces suppression,
unsubscribe handling and verification thresholds, but you remain responsible for having a lawful basis
to contact each person.
