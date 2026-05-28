# E-MindBridge — Process Flows

## PF-01: User Registration & Consent

```
User fills registration form
        │
        ▼
Supabase Auth creates auth.users record
        │
        ▼
DB trigger (handle_new_user) creates profiles record
        │
        ▼
App redirects to /consent
        │
        ▼
User reviews Ethics & Privacy Module:
  - Terms & Conditions
  - Data Privacy Policy
  - AI Analysis Consent
  - Disclosure Clause (harm threshold)
        │
        ├─── User clicks "I Agree" ──────────────────────────────────►
        │                                                              │
        │                                               INSERT consent_records
        │                                               { status: 'agreed' }
        │                                                              │
        │                                               Redirect to /dashboard
        │
        └─── User closes / does not agree ──► Blocked from all app routes
             (hooks.server.ts consent gate)
```

---

## PF-02: Daily Mood Check-in

```
Patient opens /mood
        │
        ▼
System checks: has patient already logged today?
        │
        ├─── YES ──► Show today's entry (read-only), option to update
        │
        └─── NO ───► Show emoji selector (Great → Struggling)
                            │
                            ▼
                     Patient selects mood + optional note
                            │
                            ▼
                     INSERT mood_logs
                     (unique index blocks duplicates)
                            │
                            ▼
                     Mood data available to:
                       - Patient dashboard chart
                       - AI analysis engine (PF-04)
                       - Analytics snapshot generator (PF-09)
```

---

## PF-03: Journal Entry Submission

```
Patient opens /journal → writes entry → clicks Save
        │
        ▼
INSERT journal_entries
{ content, language_code, is_analyzed: false, analysis_queued_at: now() }
        │
        ▼
Supabase DB webhook fires → Edge Function: analyze-journal
        │
        ▼
[See PF-04: Automatic AI Analysis]
```

---

## PF-04: Automatic AI Report Generation

```
Edge Function: analyze-journal receives new journal_entry
        │
        ▼
Fetch: last 7 mood_logs for patient
Fetch: journal_entry content
        │
        ▼
Call Anthropic Claude API
  System prompt: MindProfile analysis instructions
  User message: journal content + mood history + language hint
        │
        ▼
Parse Claude response:
  - risk_level
  - sentiment
  - primary_category
  - longitudinal_pattern
  - emotional_markers[]
  - behavioral_tendencies
  - self_harm_detected
  - suicidal_ideation_detected
  - specific_triggers[]
  - immediate_action
  - self_help_suggestion
  - clinical_goal
        │
        ▼
INSERT ai_reports (auto-generate report_reference_number via trigger)
        │
        ▼
UPDATE journal_entries SET is_analyzed = TRUE
        │
        ▼
INSERT audit_logs { action: 'ai_report_generated' }
        │
        ├─── risk_level IN ('high', 'critical')
        │    OR self_harm_detected = 'detected'
        │    OR suicidal_ideation_detected = 'detected'
        │           │
        │           ▼
        │    Call dispatch-notification Edge Function
        │    → INSERT notifications { type: 'risk_alert' }
        │      to all active counselors assigned to this patient
        │
        └─── risk_level IN ('low', 'moderate') ──► No alert, report available silently
```

---

## PF-05: Counselor On-Request AI Report

```
Counselor opens /counselor/report-requests/new
        │
        ▼
Fills form: patient_id + date_range_start + date_range_end + reason
        │
        ▼
INSERT report_requests
{ status: 'pending', requested_by: counselor_id }
        │
        ▼
INSERT notifications to Admin
{ type: 'general', title: 'New Report Request Pending Review' }
        │
        ▼
──────────────── ADMIN REVIEWS ────────────────────────────────────
        │
Admin opens /admin/report-requests
        │
        ▼
Admin reads: patient identity, counselor, date range, reason
        │
        ├─── Admin clicks APPROVE
        │           │
        │           ▼
        │    UPDATE report_requests SET status = 'approved'
        │           │
        │           ▼
        │    Supabase DB webhook fires
        │    → Edge Function: fulfill-report-request
        │           │
        │           ▼
        │    Fetch all journal_entries in date range for patient
        │    Fetch all mood_logs in date range for patient
        │           │
        │           ▼
        │    Call Claude API (longitudinal analysis prompt)
        │           │
        │           ▼
        │    INSERT ai_reports
        │    UPDATE report_requests SET status = 'fulfilled'
        │           │
        │           ▼
        │    Notify counselor: "Your report for [patient] is ready"
        │    INSERT audit_logs { action: 'report_request_fulfilled' }
        │
        └─── Admin clicks REJECT + reason
                    │
                    ▼
             UPDATE report_requests SET status = 'rejected', rejection_reason
                    │
                    ▼
             Notify counselor: "Report request rejected: [reason]"
             INSERT audit_logs { action: 'report_request_rejected' }
```

---

## PF-06: Counselor Evaluation

```
Counselor opens /counselor/patients/[id] → views ai_report
        │
        ▼
INSERT audit_logs { action: 'viewed_report' }
        │
        ▼
Counselor reviews:
  - Longitudinal pattern
  - Emotional markers
  - Threat detection flags  ← mandatory review
  - AI recommendations
        │
        ▼
Counselor fills evaluation form:
  - Clinical impression (free text)
  - AI recommendation status: approved / modified / rejected
  - If modified/rejected: reason
  - Next step: schedule_session / refer_external / monitor_only / emergency_referral
        │
        ▼
INSERT counselor_evaluations
        │
        ├─── next_step = 'schedule_session' ──► Trigger PF-07 (Reactive Session)
        ├─── next_step = 'refer_external'   ──► Notify patient, log referral
        ├─── next_step = 'monitor_only'     ──► No further action
        └─── next_step = 'emergency_referral' ──► Immediate notification + audit flag
```

---

## PF-07: Tele-Counseling Session (Reactive — Counselor-Initiated)

```
Counselor sets next_step = 'schedule_session' in evaluation
        │
        ▼
Counselor opens session scheduler → picks date/time
        │
        ▼
INSERT counseling_sessions
{
  patient_id,
  counselor_id: current counselor,
  evaluation_id,
  ai_report_id,
  request_type: 'reactive',
  status: 'scheduled',
  low_bandwidth_mode: true
}
        │
        ▼
Call dispatch-notification:
  → Patient: "A session has been scheduled for you on [date]"
  → Counselor: confirmation
        │
        ▼
INSERT audit_logs { action: 'session_scheduled' }
        │
        ▼
At session time → both parties open /sessions/[id]
        │
        ▼
UPDATE counseling_sessions SET status = 'active', started_at = now()
        │
        ▼
Session ends → Counselor submits session_notes
UPDATE counseling_sessions SET status = 'completed', ended_at = now()
```

---

## PF-08: Tele-Counseling Session (Proactive — Patient-Initiated)

```
Patient clicks "Request Session" on dashboard
        │
        ▼
System checks: does patient have an active primary counselor assignment?
        │
        ├─── YES ──► Use existing primary counselor
        │            INSERT counseling_sessions { request_type: 'proactive' }
        │            → Notify counselor of patient request
        │
        └─── NO ────► Call Edge Function: assign-counselor
                            │
                            ▼
                     [See PF-10: Auto-Assignment]
                            │
                            ▼
                     INSERT counselor_patient_assignments
                     { assignment_type: 'auto', is_primary: true }
                            │
                            ▼
                     INSERT counseling_sessions { request_type: 'proactive' }
                            │
                            ▼
                     After session completes:
                     Patient sees prompt:
                       "Keep [Counselor Name] for future sessions?"
                       [Yes, keep] / [Request different counselor]
                            │
                            ├─── Keep ──► Assignment remains active (default)
                            │
                            └─── Request change ──► PF-11: Counselor Reassignment
```

---

## PF-09: Analytics Snapshot Generation

```
pg_cron job fires daily at 00:00
        │
        ▼
For each counselor with active patient assignments:
        │
        ▼
Aggregate across all assigned patients for today:
  - mood_great_pct, mood_good_pct, ... mood_struggling_pct
  - high_risk_count (from ai_reports today)
  - global_risk_level (max risk across group)
  - top_category (most frequent primary_category in ai_reports this week)
        │
        ▼
UPSERT analytics_snapshots
{ counselor_id, snapshot_date: today, ... }
        │
        ▼
Data available on counselor dashboard macro view
```

---

## PF-10: Auto-Assignment of Counselor to Patient

```
Patient requests session with no active counselor
        │
        ▼
Edge Function: assign-counselor
        │
        ▼
Read patient's most recent ai_reports.primary_category (e.g. 'academic')
        │
        ▼
Query counselor_profiles WHERE:
  - is_available = TRUE
  - active patient count < max_patient_load
        │
        ▼
Rank counselors:
  Priority 1: specialties overlaps with patient's primary_category
              AND fewest current active patients
  Priority 2: any available counselor with fewest active patients (fallback)
        │
        ▼
INSERT counselor_patient_assignments
{
  counselor_id: selected,
  patient_id,
  assignment_type: 'auto',
  is_primary: true,
  is_active: true
}
        │
        ▼
Return assigned counselor_id to calling action
```

---

## PF-11: Patient Requests Counselor Reassignment

```
Patient clicks "Request different counselor" post-session
        │
        ▼
System records preference: UPDATE counselor_patient_assignments
SET is_active = FALSE, deactivated_reason = 'patient_requested'
WHERE patient_id = X AND is_primary = TRUE
        │
        ▼
INSERT notification to Admin:
"Patient [name] has requested a counselor change."
        │
        ▼
Admin reviews and either:
  ├─── Manually assigns a specific counselor
  │    INSERT counselor_patient_assignments
  │    { assignment_type: 'manual', is_primary: true }
  │
  └─── Triggers auto-assign again (PF-10)
        │
        ▼
Notify patient: "Your new counselor is [name]"
INSERT audit_logs { action: 'counselor_reassigned' }
```
