# E-MindBridge — Backend Architecture Map

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        SvelteKit App                        │
│  +page.server.ts (load)  |  +page.svelte  |  +server.ts     │
│  Form Actions            |  Stores        |  API Routes      │
└────────────────────────┬────────────────────────────────────┘
                         │ Supabase JS Client (SSR + browser)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                       Supabase Platform                      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Auth        │  │  PostgreSQL  │  │  Edge Functions   │ │
│  │  (JWT/RLS)   │  │  + RLS       │  │  (Deno runtime)   │ │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘ │
│                                                 │           │
│  ┌──────────────┐  ┌──────────────┐             │           │
│  │  Realtime    │  │  Storage     │             │           │
│  │  (sessions)  │  │  (photos)    │             │           │
│  └──────────────┘  └──────────────┘             │           │
└─────────────────────────────────────────────────┼───────────┘
                                                  │ fetch
                                                  ▼
                                    ┌─────────────────────────┐
                                    │   Anthropic Claude API   │
                                    │   claude-sonnet-4-20...  │
                                    └─────────────────────────┘
```

---

## Supabase Edge Functions

These are the active server-side processes. Each lives in `supabase/functions/<name>/index.ts`.

### `analyze-journal`
**Trigger:** Database webhook on `INSERT` into `journal_entries`
**What it does:**
1. Reads the new journal entry content
2. Reads the patient's last 7 mood logs
3. Calls the Claude API with a structured prompt
4. Writes the result to `ai_reports`
5. Flips `journal_entries.is_analyzed = TRUE`
6. If `risk_level` is `high` or `critical`, calls `dispatch-notification`
7. Writes to `audit_logs`

**Environment vars needed:** `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

---

### `fulfill-report-request`
**Trigger:** Database webhook on `UPDATE` to `report_requests` where `status = 'approved'`
**What it does:**
1. Reads all `journal_entries` for the patient within the requested date range
2. Reads all `mood_logs` for the same range
3. Calls Claude API with longitudinal analysis prompt
4. Writes result to `ai_reports` with `report_request_id` reference
5. Updates `report_requests.status = 'fulfilled'`
6. Notifies the requesting counselor via `notifications`
7. Writes to `audit_logs`

**Environment vars needed:** `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

---

### `assign-counselor`
**Trigger:** Called from SvelteKit server action when a patient requests a session and has no active primary counselor assignment
**What it does:**
1. Reads the patient's most recent `ai_reports.primary_category`
2. Queries `counselor_profiles` for counselors where:
   - `is_available = TRUE`
   - `specialties` overlaps with the patient's primary category
   - Current active patient count < `max_patient_load`
3. If specialty match found → assigns that counselor
4. If no specialty match → assigns the counselor with the fewest active patients
5. Writes to `counselor_patient_assignments` with `assignment_type = 'auto'`
6. Returns the assigned counselor ID to the calling action

---

### `dispatch-notification`
**Trigger:** Called internally by other Edge Functions or from SvelteKit server actions
**What it does:**
1. Accepts `{ recipient_id, type, title, body, related_session_id?, related_report_id? }`
2. Inserts into `notifications`
3. (Optional future) sends push notification or email via Resend/SendGrid

---

### `generate-analytics-snapshot`
**Trigger:** Scheduled via Supabase `pg_cron` — runs daily at midnight
**What it does:**
1. For each active counselor, aggregates mood percentages across their assigned patients for the current day
2. Computes global risk level (worst-case across group)
3. Identifies top trending `primary_category` from recent AI reports
4. Upserts into `analytics_snapshots`

---

## SvelteKit Route Architecture

```
src/
├── routes/
│   ├── (auth)/
│   │   ├── login/
│   │   └── register/
│   ├── (app)/                          # requires valid consent record
│   │   ├── dashboard/                  # patient home
│   │   │   └── +page.server.ts         # calls get_quotes_for_patient()
│   │   ├── mood/
│   │   │   └── +page.server.ts         # INSERT mood_logs
│   │   ├── journal/
│   │   │   └── +page.server.ts         # INSERT journal_entries → triggers Edge Fn
│   │   ├── sessions/
│   │   │   ├── request/                # patient proactive request
│   │   │   └── [id]/                   # tele-counseling room
│   │   └── counselor/                  # role-guarded: counselor only
│   │       ├── dashboard/              # macro view + patient list
│   │       ├── patients/[id]/          # micro MindProfile view
│   │       ├── evaluations/[id]/       # submit counselor_evaluation
│   │       └── report-requests/        # submit report_requests
│   └── admin/                          # role-guarded: admin only
│       ├── dashboard/
│       ├── report-requests/            # approve / reject queue
│       ├── users/
│       └── quotes/                     # manage wellness_quotes
├── lib/
│   ├── server/
│   │   ├── supabase.ts                 # server-side Supabase client (service role)
│   │   └── guards.ts                   # role + consent check helpers
│   ├── supabase.ts                     # browser Supabase client
│   └── types/
│       └── database.types.ts           # generated from Supabase CLI
└── hooks.server.ts                     # auth session hydration + consent gate
```

---

## Data Access Patterns

| Operation | Who | How |
|---|---|---|
| Patient reads own mood history | Patient | RLS SELECT on `mood_logs` |
| Patient submits journal | Patient | RLS INSERT on `journal_entries` → webhook → Edge Fn |
| Counselor reads AI report | Counselor | RLS SELECT via `counselor_patient_assignments` join |
| Counselor submits evaluation | Counselor | RLS INSERT on `counselor_evaluations` |
| Counselor submits report request | Counselor | RLS INSERT on `report_requests` |
| Admin approves report request | Admin | Server action UPDATE `report_requests.status` → webhook → Edge Fn |
| Patient requests session | Patient | Server action → `assign-counselor` Edge Fn → INSERT `counseling_sessions` |
| Patient requests counselor change | Patient | Server action → UPDATE `counselor_patient_assignments` + INSERT new |
| Analytics snapshot read | Counselor | RLS SELECT on `analytics_snapshots` scoped to `counselor_id` |
| Audit log write | System | Service role — all Edge Functions write via service role client |

---

## Environment Variables Required

```env
# Supabase
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # server/Edge Functions only — never expose to client

# Anthropic
ANTHROPIC_API_KEY=               # Edge Functions only

# App
PUBLIC_APP_URL=
CONSENT_VERSION=1.0              # bump to re-prompt all users
```

---

## Security Checklist

- [ ] RLS enabled on all tables — verified in schema
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never sent to browser
- [ ] `ANTHROPIC_API_KEY` only in Edge Function environment
- [ ] `hooks.server.ts` checks consent version on every authenticated route
- [ ] Counselors cannot query `journal_entries` directly (RLS blocks with `USING (FALSE)`)
- [ ] Admin role assigned only via Supabase dashboard or a protected server action — never via client-side form
- [ ] All Edge Functions validate JWT before processing
