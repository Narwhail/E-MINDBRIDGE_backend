# E-MindBridge API Documentation

A mental-health telemetry and teletherapy platform built with **Node.js / Express**, **Supabase (PostgreSQL)**, and **Google Gemini AI**.

---

## Table of Contents

1. [Base URL & Auth](#base-url--auth)
2. [Roles & Permissions](#roles--permissions)
3. [Session Status Flow](#session-status-flow)
4. [DB Enum Reference](#db-enum-reference)
5. [Auth Routes](#auth-routes) — `/api/auth`
6. [Mood Routes](#mood-routes) — `/api/mood`
7. [Journal Routes](#journal-routes) — `/api/journal`
8. [Dashboard Routes](#dashboard-routes) — `/api/dashboard`
9. [Sessions Routes](#sessions-routes) — `/api/sessions`
10. [Reports Routes](#reports-routes) — `/api/reports`
11. [Evaluations Routes](#evaluations-routes) — `/api/evaluations`
12. [Patients Routes](#patients-routes) — `/api/patients`
13. [Notifications Routes](#notifications-routes) — `/api/notifications`
14. [Analytics Routes](#analytics-routes) — `/api/analytics`
15. [Admin Routes](#admin-routes) — `/api/admin`
16. [Admin Console (Web UI)](#admin-console-web-ui)

---

## Base URL & Auth

All API routes are prefixed with `/api`. For local development:

```
http://localhost:3000/api
```

All protected endpoints require a Supabase JWT in the `Authorization` header:

```
Authorization: Bearer <your_supabase_jwt>
```

Obtain the JWT by calling `POST /api/auth/login`. The token expires as configured in Supabase; refresh with the `refresh_token` returned at login.

---

## Roles & Permissions

| Role | Description |
|---|---|
| `patient` | End users who log moods, write journals, and request sessions |
| `counselor` | Mental health professionals who evaluate AI reports and conduct sessions |
| `admin` | Platform administrators with full management access |

Endpoints are role-gated. Attempting to call a route without the correct role returns `403 Forbidden`.

---

## Session Status Flow

### Patient-Initiated (Proactive) Sessions
```
patient POST /api/sessions/proactive
  → status: "pending_confirmation"   (no Jitsi URL yet)
  → Counselor gets notified to confirm

counselor PATCH /api/sessions/:id/confirm  { action: "accept" }
  → status: "scheduled"
  → Jitsi room URL generated NOW
  → Both parties notified with the link

counselor PATCH /api/sessions/:id/confirm  { action: "decline" }
  → status: "cancelled"
  → Patient notified
```

### Counselor-Initiated (Reactive) Sessions
```
counselor POST /api/sessions/reactive
  → status: "pending_patient_confirmation"   (no Jitsi URL yet)
  → Patient gets notified to confirm

patient PATCH /api/sessions/:id/patient-confirm  { action: "accept" }
  → status: "scheduled"
  → Jitsi room URL generated NOW
  → Both parties notified with the link

patient PATCH /api/sessions/:id/patient-confirm  { action: "decline" }
  → status: "cancelled"
  → Counselor notified
```

### Lifecycle After Confirmation
```
scheduled → active (PATCH /api/sessions/:id/status { status: "active" })
          → completed (PATCH /api/sessions/:id/status { status: "completed" })
          → cancelled (PATCH /api/sessions/:id/status { status: "cancelled" })
          → no_show   (PATCH /api/sessions/:id/status { status: "no_show" })
```

---

## DB Enum Reference

| Enum | Values |
|---|---|
| `user_role` | `patient`, `counselor`, `admin` |
| `mood_level` | `great`, `good`, `okay`, `low`, `struggling` |
| `risk_level` | `low`, `moderate`, `high`, `critical` |
| `sentiment_type` | `positive`, `neutral`, `negative` |
| `primary_category` | `academic`, `personal`, `grief`, `career`, `family`, `social`, `health`, `other` |
| `session_status` | `pending_confirmation`, `pending_patient_confirmation`, `scheduled`, `active`, `completed`, `cancelled`, `no_show` |
| `session_request_type` | `proactive`, `reactive` |
| `threat_detection_status` | `detected`, `not_detected` |
| `ai_recommendation_status` | `approved`, `modified`, `rejected`, `pending` |
| `next_step_type` | `schedule_session`, `refer_external`, `monitor_only`, `emergency_referral` |
| `notification_type` | `session_scheduled`, `session_reminder`, `risk_alert`, `general` |
| `consent_status` | `pending`, `agreed`, `withdrawn` |
| `request_status` | `pending`, `approved`, `rejected`, `fulfilled` |
| `assignment_type` | `auto`, `manual`, `patient_requested` |

> **Note:** The statuses `pending_confirmation` and `pending_patient_confirmation` must exist in the `session_status` enum. Run in Supabase SQL editor if not already present:
> ```sql
> ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'pending_confirmation';
> ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'pending_patient_confirmation';
> ```

---

## Auth Routes

**Base:** `/api/auth`

### `POST /api/auth/register`
Register a new user account.

**Access:** Public  
**Body:**
```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "full_name": "Juan Dela Cruz",
  "role": "patient"
}
```
- `role` must be `patient` or `counselor`. Admin accounts must be created manually via the Admin Console.

**Response `201`:**
```json
{ "message": "User registered successfully.", "user_id": "uuid" }
```

---

### `POST /api/auth/consent`
Submit a consent record for a newly registered user.

**Access:** Public (called immediately after registration)  
**Body:**
```json
{
  "user_id": "uuid",
  "terms_agreed": true,
  "privacy_agreed": true,
  "ai_analysis_agreed": true,
  "disclosure_agreed": true
}
```

**Response `201`:**
```json
{ "message": "Consent recorded. Access granted.", "consent_id": "uuid", "status": "agreed" }
```

---

### `POST /api/auth/login`
Authenticate a user and receive a JWT access token.

**Access:** Public  
**Body:**
```json
{ "email": "user@example.com", "password": "securepassword" }
```

**Response `200`:**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "...",
  "expires_at": 1234567890,
  "user": { "id": "uuid", "full_name": "Juan", "role": "patient", "email": "..." }
}
```

---

### `GET /api/auth/me`
Get the authenticated user's profile.

**Access:** Any authenticated user  
**Response `200`:**
```json
{ "user": { "id": "uuid", "role": "patient", "full_name": "...", "is_active": true, "created_at": "..." } }
```

---

### `POST /api/auth/logout`
Invalidate the current session token.

**Access:** Any authenticated user  
**Response `200`:**
```json
{ "message": "Logged out successfully." }
```

---

## Mood Routes

**Base:** `/api/mood`

### `GET /api/mood/today`
Check whether the patient has logged a mood today, and retrieve it if so.

**Access:** Patient  
**Response `200`:**
```json
{ "logged_today": true, "entry": { "id": "uuid", "mood": "okay", "note": "...", "logged_at": "..." } }
```

---

### `GET /api/mood/history`
Get the patient's mood log history.

**Access:** Patient  
**Query Params:**
- `limit` (optional, default 30, max 90)

**Response `200`:**
```json
{ "moods": [ { "id": "uuid", "mood": "good", "note": null, "logged_at": "..." } ] }
```

---

### `POST /api/mood`
Log or update today's mood. Only one entry per calendar day is allowed; a second submission updates the existing one.

**Access:** Patient  
**Body:**
```json
{ "mood": "okay", "note": "Feeling a bit stressed but managing." }
```
- `mood` must be one of: `great`, `good`, `okay`, `low`, `struggling`

**Response `201` (new) or `200` (updated):**
```json
{ "message": "Mood logged successfully.", "entry": { ... } }
```

---

## Journal Routes

**Base:** `/api/journal`

### `POST /api/journal`
Submit a new journal entry. AI analysis is **not** triggered automatically — analysis only happens when a counselor requests a report (see [Reports Routes](#reports-routes)).

**Access:** Patient  
**Body:**
```json
{ "content": "Today I felt overwhelmed by my workload...", "language_code": "en" }
```

**Response `201`:**
```json
{ "message": "Journal entry saved successfully.", "entry_id": "uuid" }
```

---

### `GET /api/journal`
Retrieve the patient's own journal entries. Raw content is only visible to the patient.

**Access:** Patient  
**Query Params:**
- `limit` (optional, default 20, max 50)

**Response `200`:**
```json
{ "entries": [ { "id": "uuid", "content": "...", "language_code": "en", "is_analyzed": false, "created_at": "..." } ] }
```

---

## Dashboard Routes

**Base:** `/api/dashboard`

### `GET /api/dashboard/patient`
Comprehensive patient dashboard snapshot: today's mood, mood history chart data, latest AI report, wellness quotes, upcoming sessions, and unread notification count.

**Access:** Patient  
**Response `200`:**
```json
{
  "today_mood": { ... },
  "mood_history": [ ... ],
  "latest_report": { "id": "uuid", "risk_level": "moderate", "sentiment": "negative", ... },
  "wellness_quotes": [ ... ],
  "upcoming_sessions": [ ... ],
  "unread_notifications": 3
}
```

---

### `GET /api/dashboard/counselor`
Counselor dashboard: today's analytics snapshot, assigned patient summaries with latest AI risk flags, upcoming sessions, and unread notification count.

**Access:** Counselor  
**Response `200`:**
```json
{
  "analytics_snapshot": { ... },
  "patients": [ { "id": "uuid", "full_name": "...", "latest_report": { "risk_level": "high", ... } } ],
  "upcoming_sessions": [ ... ],
  "unread_notifications": 1
}
```

---

### `GET /api/dashboard/admin`
Admin dashboard summary: pending report request count, active user counts by role, high-risk patient count in last 7 days, and recent audit log entries.

**Access:** Admin  
**Response `200`:**
```json
{
  "pending_report_requests": 2,
  "user_counts": { "patient": 45, "counselor": 8, "admin": 2 },
  "high_risk_last_7_days": 3,
  "recent_audit_logs": [ ... ]
}
```

---

## Sessions Routes

**Base:** `/api/sessions`

### `POST /api/sessions/proactive`
Patient requests a session at a preferred time. The session is created with status `pending_confirmation` — no Jitsi URL is generated until the counselor accepts. If the patient has no assigned counselor, one is auto-assigned using the smart matching algorithm (specialty + load balancing).

**Access:** Patient  
**Body:**
```json
{ "preferred_date": "2026-06-20T10:00:00.000Z", "notes": "Optional notes." }
```

**Response `201`:**
```json
{
  "message": "Session requested successfully. Awaiting counselor confirmation.",
  "session_id": "uuid",
  "counselor_id": "uuid",
  "scheduled_at": "2026-06-20T10:00:00.000Z",
  "status": "pending_confirmation",
  "was_auto_assigned": false
}
```

---

### `PATCH /api/sessions/:sessionId/confirm`
Counselor accepts or declines a patient's session request. On `accept`, the Jitsi room URL is generated and both parties are notified.

**Access:** Counselor (only the assigned counselor of the session)  
**Body:**
```json
{ "action": "accept" }
```
or
```json
{ "action": "decline", "decline_reason": "I'm unavailable at that time." }
```

**Response `200` (accept):**
```json
{
  "message": "Session confirmed. Jitsi room created and patient notified.",
  "session_id": "uuid",
  "scheduled_at": "...",
  "room_url": "https://meet.jit.si/EMindBridge-..."
}
```

**Response `200` (decline):**
```json
{ "message": "Session declined. Patient has been notified." }
```

---

### `POST /api/sessions/reactive`
Counselor proposes a session to a patient (typically after reviewing an AI evaluation). The session is created with status `pending_patient_confirmation` — no Jitsi URL is generated until the patient accepts.

**Access:** Counselor (must be actively assigned to the patient)  
**Body:**
```json
{
  "patient_id": "uuid",
  "scheduled_at": "2026-06-22T14:00:00.000Z",
  "evaluation_id": "uuid",
  "ai_report_id": "uuid",
  "notes": "Follow-up after AI risk flag."
}
```

**Response `201`:**
```json
{
  "message": "Reactive session proposed. Awaiting patient confirmation.",
  "session_id": "uuid",
  "scheduled_at": "...",
  "status": "pending_patient_confirmation"
}
```

---

### `PATCH /api/sessions/:sessionId/patient-confirm`
Patient accepts or declines a counselor-proposed session. On `accept`, the Jitsi room URL is generated and both parties are notified.

**Access:** Patient (only the patient of the session)  
**Body:**
```json
{ "action": "accept" }
```
or
```json
{ "action": "decline", "decline_reason": "I have a conflict at that time." }
```

**Response `200` (accept):**
```json
{
  "message": "Session confirmed. Jitsi room created and counselor notified.",
  "session_id": "uuid",
  "scheduled_at": "...",
  "room_url": "https://meet.jit.si/EMindBridge-..."
}
```

**Response `200` (decline):**
```json
{ "message": "Session declined. Your counselor has been notified." }
```

---

### `PATCH /api/sessions/:sessionId/status`
Update the lifecycle status of a confirmed/scheduled session.

**Access:** Patient or Counselor  
**Body:**
```json
{ "status": "completed", "session_notes": "Patient showed improvement.", "cancellation_reason": null }
```
- `status` must be: `active`, `completed`, `cancelled`, `no_show`
- Setting `active` automatically records `started_at`
- Setting `completed` automatically records `ended_at` and saves `session_notes`

**Response `200`:**
```json
{ "message": "Session status updated to completed." }
```

---

### `GET /api/sessions`
Get all sessions for the authenticated user (patient sees their sessions; counselor sees their sessions).

**Access:** Patient or Counselor  
**Response `200`:**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "patient_id": "uuid",
      "counselor_id": "uuid",
      "status": "scheduled",
      "request_type": "proactive",
      "scheduled_at": "...",
      "started_at": null,
      "ended_at": null,
      "room_url": "https://meet.jit.si/...",
      "low_bandwidth_mode": true
    }
  ]
}
```

---

### `POST /api/sessions/reassign`
Patient requests to be assigned a different counselor. This deactivates the current assignment and notifies all admins to manually reassign.

**Access:** Patient  
**Body:** *(none)*

**Response `200`:**
```json
{ "message": "Reassignment request submitted. An admin will assign your new counselor shortly." }
```

---

### `POST /api/sessions/admin/assign`
Admin manually assigns a counselor to a patient. If `counselor_id` is omitted, the smart auto-assignment algorithm runs.

**Access:** Admin  
**Body:**
```json
{ "patient_id": "uuid", "counselor_id": "uuid" }
```
- Omit `counselor_id` for automatic assignment based on specialty match and lowest patient load.

**Response `200`:**
```json
{ "message": "Counselor assigned successfully (manual).", "counselor_id": "uuid" }
```

---

## Reports Routes

**Base:** `/api/reports`

### `POST /api/reports/request`
Counselor submits a request for an AI longitudinal report for a patient over a date range. Requires admin approval before the AI analysis runs.

**Access:** Counselor (must be assigned to the patient)  
**Body:**
```json
{
  "patient_id": "uuid",
  "date_range_start": "2026-05-01",
  "date_range_end": "2026-05-31",
  "reason": "Patient has shown irregular mood patterns over the past month."
}
```

**Response `201`:**
```json
{ "message": "Report request submitted successfully. Awaiting admin approval.", "request_id": "uuid" }
```

---

### `GET /api/reports/requests`
Get the authenticated counselor's own report requests and their statuses.

**Access:** Counselor  
**Response `200`:**
```json
{
  "requests": [
    {
      "id": "uuid",
      "patient_id": "uuid",
      "date_range_start": "2026-05-01",
      "date_range_end": "2026-05-31",
      "reason": "...",
      "status": "fulfilled",
      "fulfilled_report_id": "uuid",
      "requested_at": "..."
    }
  ]
}
```

---

### `GET /api/reports/admin/pending`
Get all report requests currently awaiting admin review.

**Access:** Admin  
**Response `200`:**
```json
{ "requests": [ { "id": "uuid", "patient_id": "uuid", "reason": "...", "status": "pending", "requested_at": "..." } ] }
```

---

### `GET /api/reports/admin/processed`
Get all report requests that have already been processed (approved, fulfilled, or rejected). Paginated.

**Access:** Admin  
**Query Params:**
- `page` (default 1)
- `limit` (default 10, max 100)

**Response `200`:**
```json
{
  "requests": [ { "id": "uuid", "status": "fulfilled", "fulfilled_report_id": "uuid", "reviewed_at": "...", ... } ],
  "pagination": { "page": 1, "limit": 10, "total_count": 42, "total_pages": 5 }
}
```

---

### `PATCH /api/reports/admin/:requestId`
Admin approves or rejects a pending report request. On approval, the Gemini longitudinal analysis pipeline runs asynchronously and stores the result in `ai_reports`.

**Access:** Admin  
**Body (approve):**
```json
{ "action": "approve" }
```
**Body (reject):**
```json
{ "action": "reject", "rejection_reason": "Insufficient date range provided." }
```

**Response `200`:**
```json
{ "message": "Report request approved. AI analysis is processing." }
```

---

### `GET /api/reports/patient/:patientId`
Get AI-generated reports for a specific patient.

**Access:** Counselor (must be assigned to patient) or Admin  
**Response `200`:**
```json
{
  "reports": [
    {
      "id": "uuid",
      "report_reference_number": "RPT-20260615-001",
      "risk_level": "moderate",
      "sentiment": "negative",
      "primary_category": "personal",
      "longitudinal_pattern": "...",
      "emotional_markers": ["overwhelmed", "stressed"],
      "self_harm_detected": "not_detected",
      "suicidal_ideation_detected": "not_detected",
      "immediate_action": "...",
      "self_help_suggestion": "...",
      "clinical_goal": "...",
      "ai_model_version": "gemini-2.5-flash",
      "generated_at": "..."
    }
  ]
}
```

---

## Evaluations Routes

**Base:** `/api/evaluations`

### `POST /api/evaluations`
Counselor submits a clinical evaluation for an AI report. This is the human-in-the-loop step. The `next_step` field drives session scheduling and referral logic.

**Access:** Counselor (must be assigned to the patient)  
**Body:**
```json
{
  "ai_report_id": "uuid",
  "patient_id": "uuid",
  "clinical_impression": "Patient shows signs of work-related burnout.",
  "ai_recommendation_status": "approved",
  "modification_reason": null,
  "next_step": "schedule_session",
  "external_referral_name": null,
  "counselor_notes": "Will follow up with a reactive session this week."
}
```
- `ai_recommendation_status`: `approved`, `modified`, `rejected`
- `modification_reason` is required if status is `modified` or `rejected`
- `next_step`: `schedule_session`, `refer_external`, `monitor_only`, `emergency_referral`
- `next_step: "emergency_referral"` immediately sends a `risk_alert` notification to the patient

**Response `201`:**
```json
{
  "message": "Evaluation submitted. You can now schedule a reactive session for this patient.",
  "evaluation_id": "uuid",
  "next_step": "schedule_session"
}
```

---

### `GET /api/evaluations/patient/:patientId`
Get all evaluations for a specific patient.

**Access:** Counselor (must be assigned to patient) or Admin  
**Response `200`:**
```json
{ "evaluations": [ { "id": "uuid", "ai_report_id": "uuid", "clinical_impression": "...", "next_step": "schedule_session", "evaluated_at": "..." } ] }
```

---

## Patients Routes

**Base:** `/api/patients`

### `GET /api/patients`
Get the counselor's assigned patients, paginated and enriched with latest mood and active session info.

**Access:** Counselor  
**Query Params:**
- `page` (default 1)
- `limit` (default 10, max 50)
- `search` — filter by patient name (case-insensitive)

**Response `200`:**
```json
{
  "patients": [
    {
      "id": "uuid",
      "full_name": "...",
      "school_or_org": "...",
      "is_active": true,
      "latest_mood": { "mood": "low", "logged_at": "..." },
      "active_session": { "id": "uuid", "status": "scheduled", "scheduled_at": "..." }
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 23, "total_pages": 3, "has_next": true, "has_prev": false }
}
```

---

### `GET /api/patients/:patientId`
Get the full profile of a single assigned patient, including recent moods, sessions, and AI reports.

**Access:** Counselor (must be actively assigned to the patient)  
**Response `200`:**
```json
{
  "patient": { "id": "uuid", "full_name": "...", "assigned_since": "...", ... },
  "recent_moods": [ ... ],
  "recent_sessions": [ ... ],
  "recent_ai_reports": [ ... ]
}
```

---

## Notifications Routes

**Base:** `/api/notifications`

### `GET /api/notifications`
Get the authenticated user's notifications, newest first.

**Access:** Any authenticated user  
**Query Params:**
- `limit` (default 20, max 50)
- `unread=true` — filter to unread only

**Response `200`:**
```json
{
  "notifications": [
    {
      "id": "uuid",
      "type": "session_scheduled",
      "title": "Session Confirmed!",
      "body": "Your session is on June 20 at 10:00 AM. Join: https://meet.jit.si/...",
      "is_read": false,
      "read_at": null,
      "created_at": "...",
      "related_session_id": "uuid",
      "related_report_id": null
    }
  ]
}
```

---

### `PATCH /api/notifications/:id/read`
Mark a specific notification as read.

**Access:** Any authenticated user (own notifications only)  
**Response `200`:**
```json
{ "message": "Notification marked as read." }
```

---

### `PATCH /api/notifications/read-all`
Mark all unread notifications as read for the authenticated user.

**Access:** Any authenticated user  
**Response `200`:**
```json
{ "message": "All notifications marked as read." }
```

---

## Analytics Routes

**Base:** `/api/analytics`

### `POST /api/analytics/snapshot`
Generate today's analytics snapshots for all counselors. Aggregates mood percentages, risk levels, and top categories across each counselor's patient group. Designed to be called by a cron job.

**Access:** Admin  
**Response `200`:**
```json
{ "message": "Analytics snapshots generated.", "snapshots_generated": 8 }
```

---

### `GET /api/analytics/snapshot/me`
Get today's pre-aggregated analytics snapshot for the authenticated counselor.

**Access:** Counselor  
**Response `200`:**
```json
{
  "snapshot": {
    "snapshot_date": "2026-06-16",
    "total_users": 12,
    "mood_great_pct": 16.67,
    "mood_okay_pct": 33.33,
    "mood_struggling_pct": 8.33,
    "global_risk_level": "moderate",
    "high_risk_count": 1,
    "top_category": "academic"
  }
}
```

---

### `GET /api/analytics/snapshot/history`
Get historical daily snapshots for the authenticated counselor.

**Access:** Counselor  
**Query Params:**
- `limit` (default 30, max 90)

**Response `200`:**
```json
{ "snapshots": [ { "snapshot_date": "2026-06-15", ... }, { "snapshot_date": "2026-06-14", ... } ] }
```

---

## Admin Routes

**Base:** `/api/admin`  
All admin routes require `role = admin`.

---

### User Management — `/api/admin/users`

#### `GET /api/admin/users`
List all users. Supports search by name **or full UUID**, role filter, and status filter. Paginated.

**Query Params:**
- `page` (default 1)
- `limit` (default 20)
- `search` — name (fuzzy) or exact UUID
- `role` — `patient`, `counselor`, or `admin`
- `is_active` — `true` or `false`

**Response `200`:**
```json
{
  "users": [ { "id": "uuid", "full_name": "...", "email": "...", "role": "patient", "is_active": true, "created_at": "..." } ],
  "pagination": { "page": 1, "limit": 20, "total_count": 55, "total_pages": 3 }
}
```

#### `POST /api/admin/users`
Create a new user account. Admin can set any role including `admin`.

**Body:**
```json
{ "email": "doc@hospital.com", "password": "securepass", "full_name": "Dr. Santos", "role": "counselor", "school_or_org": "City Hospital" }
```

#### `PATCH /api/admin/users/:userId`
Update a user's profile (name, org) or toggle their `is_active` status (suspend/reactivate).

**Body (any subset):**
```json
{ "full_name": "Dr. Santos Jr.", "is_active": false }
```

#### `PATCH /api/admin/users/:userId/role`
Change a user's role.

**Body:**
```json
{ "role": "admin" }
```

#### `DELETE /api/admin/users/:userId`
Permanently delete a user account.

---

### Assignment Management — `/api/admin/assignments`

#### `GET /api/admin/assignments`
List all counselor-patient assignments. Supports search by name **or UUID**, active/inactive filter. Paginated.

**Query Params:**
- `page`, `limit`
- `search` — name (fuzzy) or exact UUID of patient or counselor
- `is_active` — `true` or `false`

**Response `200`:**
```json
{
  "assignments": [
    {
      "id": "uuid",
      "counselor_id": "uuid",
      "patient_id": "uuid",
      "assignment_type": "manual",
      "is_primary": true,
      "is_active": true,
      "assigned_at": "...",
      "counselor": { "full_name": "..." },
      "patient": { "full_name": "..." }
    }
  ],
  "pagination": { ... }
}
```

#### `GET /api/admin/assignments/users`
Get lightweight lists of all active patients and counselors for the assignment dropdown UI.

**Response `200`:**
```json
{
  "patients": [ { "id": "uuid", "full_name": "...", "email": "..." } ],
  "counselors": [ { "id": "uuid", "full_name": "...", "email": "...", "is_available": true, "specialties": ["academic", "grief"] } ]
}
```

#### `POST /api/admin/assignments`
Manually assign a counselor to a patient.

> **Protocol:** If the patient already has an active primary assignment, the admin can only reassign if the patient has completed **at least one session** with their current counselor. Otherwise, returns `409`.

**Body:**
```json
{ "patient_id": "uuid", "counselor_id": "uuid" }
```

#### `PATCH /api/admin/assignments/:assignmentId/deactivate`
Deactivate (end) an assignment.

**Body:**
```json
{ "reason": "Patient completed program." }
```

#### `PATCH /api/admin/assignments/:assignmentId/reassign`
Reassign a patient's counselor on an existing active assignment.

> **Protocol:** Same first-session rule applies — if the patient has not yet completed their first session with the current counselor, reassignment is blocked.

**Body:**
```json
{ "new_counselor_id": "uuid" }
```

---

### Report Request Management — `/api/admin/reports` (proxied via `/api/reports/admin`)

See [Reports Routes](#reports-routes) for:
- `GET /api/reports/admin/pending`
- `GET /api/reports/admin/processed`
- `PATCH /api/reports/admin/:requestId`

---

### Wellness Quotes — `/api/admin/quotes`

#### `GET /api/admin/quotes`
List all wellness quotes. Supports content search and pagination.

**Query Params:** `page`, `limit`, `search`

#### `GET /api/admin/quotes/:quoteId`
Get a single quote by ID.

#### `POST /api/admin/quotes`
Create a new wellness quote.

**Body:**
```json
{
  "content": "The journey of a thousand miles begins with a single step.",
  "author": "Lao Tzu",
  "mood_targets": ["low", "struggling"],
  "tags": ["motivation", "personal"],
  "is_active": true
}
```
- `mood_targets` — array of `mood_level` values this quote is shown for
- `tags` — array of `primary_category` strings (e.g. `personal`, `grief`)

#### `PATCH /api/admin/quotes/:quoteId`
Update any fields of an existing quote.

#### `DELETE /api/admin/quotes/:quoteId`
Permanently delete a wellness quote.

---

### Audit Log — `/api/admin/audit`

#### `GET /api/admin/audit`
Get the platform audit log, enriched with actor name and role. Paginated.

**Query Params:**
- `page` (default 1)
- `limit` (default 20, max 100)
- `search` — filter by `action` string (e.g. `session_confirmed`, `admin_reassigned_counselor`)

**Response `200`:**
```json
{
  "logs": [
    {
      "id": "uuid",
      "actor_id": "uuid",
      "actor_name": "Dr. Santos",
      "actor_role": "counselor",
      "action": "session_confirmed",
      "target_table": "counseling_sessions",
      "target_id": "uuid",
      "metadata": { ... },
      "created_at": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total_count": 312, "total_pages": 16 }
}
```

**Audit Actions Reference:**

| Action | Triggered By |
|---|---|
| `user_registered` | User registers |
| `session_requested` | Patient requests proactive session |
| `session_proposed` | Counselor proposes reactive session |
| `session_confirmed` | Either party confirms a session |
| `session_declined` | Either party declines a session |
| `session_scheduled` | Legacy (pre-confirmation flow) |
| `counselor_reassignment_requested` | Patient requests new counselor |
| `counselor_reassigned` | Admin assigns counselor |
| `auto_assign_counselor` | System auto-assigns a counselor |
| `admin_manual_assignment` | Admin manually assigns counselor |
| `admin_reassigned_counselor` | Admin reassigns an existing assignment |
| `admin_deactivated_assignment` | Admin deactivates assignment |
| `viewed_report` | Counselor/admin views a patient report |
| `report_request_fulfilled` | AI report generated successfully |
| `report_request_rejected` | Admin rejects a report request |
| `emergency_referral_triggered` | Counselor flags emergency referral |
| `admin_created_quote` | Admin creates a wellness quote |
| `admin_deleted_quote` | Admin deletes a wellness quote |

---

## Admin Console (Web UI)

A browser-based admin dashboard is served at:
```
http://localhost:3000/admin
```

### Features

| Section | Capabilities |
|---|---|
| **Dashboard** | Live system stats (total users, active counselors, pending reports, scheduled sessions). Paginated Audit Log (20 entries/page, color-coded role badges, 📋 copy target IDs). |
| **User Management** | List all users with UUID column + 📋 copy button. Search by name or full UUID. Filter by role and status. Create, suspend/reactivate, change role. |
| **Assignments** | Search assignments by name or UUID. Filter by Active/Inactive. Assign new counselors via UUID dropdown with detail cards. Reassign existing assignments. Deactivate. Full pagination. |
| **Report Requests** | **Pending** tab: approve or reject requests. **Processed** tab: paginated history of approved/fulfilled/rejected requests with 📋 copy buttons for all UUIDs. |
| **Wellness Quotes** | Create, edit, delete quotes. Inline tag and mood badges. Paginated. Content search. |

### Authentication

The admin console uses its own login form. Only users with `role = admin` can sign in. The JWT is stored in `localStorage` for the browser session.

---

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `GEMINI_API_KEY` | Google Gemini API key for AI analysis |
| `JITSI_DOMAIN` | Jitsi Meet domain (default: `meet.jit.si`) |
| `CONSENT_VERSION` | Current consent form version string (default: `1.0`) |
| `PORT` | Server port (default: `3000`) |

---

## Running the Backend

```bash
# Install dependencies
npm install

# Development (hot-reload)
npm run dev

# Production build
npm run build
npm start
```

---

## Key Architecture Notes

- **Jitsi Meet URL generation:** Room URLs are **only** generated at the moment a session is confirmed by the receiving party — never on creation. This ensures a room is only "open" once both parties have agreed to meet.
- **First-session reassignment rule:** A patient with an active assignment cannot be reassigned (by admin or self) until they have completed at least one `completed` session with their current counselor.
- **AI report pipeline:** Journal entries are stored but not analyzed automatically. Analysis only occurs via counselor-requested reports approved by admin. The Gemini longitudinal analysis runs asynchronously after admin approval.
- **Audit log:** All sensitive actions are immutably appended to `audit_logs`. Records are never deleted.
- **Auto-assignment algorithm:** When a session is requested without an existing assignment, the system selects the available counselor whose `specialties` array contains the patient's latest `primary_category` from their AI reports, then breaks ties by lowest active patient count.
