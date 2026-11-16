# HTTP API

Base path `/api`. JSON in and out. All routes except `/session`, `/setup`, `/login` and `/logout`
need the session cookie; every non-GET request must send `X-Requested-With: outbound-os`.
Errors are `{ "error": "message" }` with a 4xx/5xx status.

Analytics, dashboard and inbox routes accept `mode=real` (default) or `mode=sandbox`.

| Method & path | Purpose |
|---|---|
| **Auth** | |
| `GET /session` | Current user; `needs_setup` on first run |
| `POST /setup` `{email,password}` | Create the admin account (once) |
| `POST /login`, `POST /logout` | Session |
| **System** | |
| `GET /system` | What is configured (AI, SMTP probe, public URL, OAuth), providers, thresholds, custom fields |
| `GET /dashboard` | 30-day summary, previous 30 days, daily series, campaign progress, alerts, health |
| `GET /alerts`, `POST /alerts/:id/resolve` | Open alerts |
| `GET /jobs/:id` | Progress of a bulk verification |
| **Leads** | |
| `GET /leads` | Filter: `q,status,tag,flag,source,campaign_id,not_in_campaign,custom_key,custom_value,suppressed,page,size,sort,dir` |
| `GET /leads/facets`, `GET /leads/export.csv` | Counts for filters; CSV export |
| `POST /leads`, `PATCH /leads/:id`, `DELETE /leads/:id` | Create (validated, duplicate-checked), edit, delete |
| `POST /leads/bulk` `{ids\|filter, action}` | `verify` (returns a job), `add_tags`, `remove_tags`, `set_field`, `suppress`, `delete` |
| `POST /verify` `{email}` | Verify one address without storing it |
| **Imports** | |
| `POST /imports/parse?filename=` (file body) | Headers, suggested mapping, sample rows |
| `POST /imports/stage?filename=&options=` (file body) | Validate; returns the report. Writes no leads |
| `POST /imports/:id/commit`, `POST /imports/:id/discard` | Commit clean rows, or discard |
| `GET /imports`, `GET /imports/:id/errors.csv` | History; per-row report |
| **Suppressions** | |
| `GET /suppressions`, `POST /suppressions` `{values}`, `DELETE /suppressions/:id` | Automatic entries need `?confirm=<reason>` to remove |
| `POST /events/complaint` `{email}` | Record a spam complaint and suppress |
| **Domains** | |
| `GET /domains`, `POST /domains` `{name,dkim_selectors}` | List; add and check |
| `PATCH /domains/:id`, `POST /domains/:id/check`, `GET /domains/:id/history`, `DELETE /domains/:id` | Selector, re-check, history |
| **Accounts** | |
| `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id`, `DELETE /accounts/:id` | Credentials are write-only |
| `POST /accounts/:id/check` | Re-run all checks |
| `GET /oauth/:provider/start`, `GET /oauth/:provider/callback` | Google / Microsoft OAuth2 |
| **Campaigns** | |
| `GET /campaigns`, `POST /campaigns`, `GET /campaigns/:id`, `DELETE /campaigns/:id` | |
| `PUT /campaigns/:id` | Settings, `account_ids`, and the full `steps[].variants[]` sequence |
| `POST /campaigns/:id/duplicate` | Copy without leads |
| `GET /campaigns/:id/leads`, `POST /campaigns/:id/leads` `{lead_ids}`, `POST /campaigns/:id/leads/remove` | Adding reports how many were refused and why |
| `GET /campaigns/:id/readiness` | The launch checklist |
| `POST /campaigns/:id/launch` | Launch or resume; 422 with the checklist if not ready |
| `POST /campaigns/:id/pause`, `POST /campaigns/:id/preview` | |
| **AI** | |
| `POST /ai/lint` | Heuristic content checks (no API key needed) |
| `POST /ai/opening-line` `{lead_id}` | Research + quote-verified draft, saved as pending |
| `POST /ai/variations`, `/ai/rewrite`, `/ai/subjects`, `/ai/review` | Suggestions for review |
| `GET /ai/drafts?status=`, `POST /ai/drafts/:id/decision` `{decision,content?}` | Review queue |
| **Inbox** | |
| `GET /inbox/threads`, `GET /inbox/threads/:leadId` | Filter: `label,unread,account_id,campaign_id,q` |
| `POST /inbox/threads/:leadId/reply` `{body}` | Threaded reply from the owning inbox |
| `PATCH /inbox/messages/:id` `{classification,is_read}` | Correct a label |
| `POST /inbox/threads/:leadId/meeting` `{booked}` | Mark a meeting |
| `POST /inbox/sync` | Sync all IMAP accounts now |
| **Analytics** | |
| `GET /analytics/summary`, `/analytics/timeseries?days=`, `/analytics/breakdown?by=` | `by`: campaign, account, domain, step, variant, day |
| `GET /analytics/export.csv?by=` | CSV with a data-source column |
| **Engine / sandbox** | |
| `POST /engine/tick` | Run the sender once now |
| `POST /sandbox/inbound` `{message_id,kind,text}` | Simulate a reply or bounce; sandbox accounts only |

Public, unauthenticated: `GET /c/:token` (click redirect), `GET /u/:token` (confirm page),
`POST /u/:token` (unsubscribe, including RFC 8058 one-click).
