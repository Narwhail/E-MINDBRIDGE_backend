# E-MindBridge API Documentation

This document provides a comprehensive overview of the REST API endpoints available in the E-MindBridge backend.

## Base URL
All API routes are prefixed with `/api`. For local development, the base URL is typically `http://localhost:3000/api`.

## Authentication
Unless otherwise specified, endpoints require an authenticated user.
Authentication is handled via Supabase JWTs. Include the token in the `Authorization` header:
```
Authorization: Bearer <your_supabase_jwt>
```
Some routes are additionally restricted to specific roles (e.g., `patient`, `counselor`, `admin`).

---

## 1. Authentication & Onboarding

### User Registration
Creates a new user and corresponding profile. Note: Admin assignment must be done manually.
- **URL**: `/auth/register`
- **Method**: `POST`
- **Auth Required**: None
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "securepassword",
    "full_name": "John Doe",
    "role": "patient" // "patient" or "counselor"
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "message": "User registered successfully.",
    "user_id": "uuid-string"
  }
  ```

### Submit Consent Record
Records user agreement to terms and privacy policies. Must be completed before accessing dashboards.
- **URL**: `/auth/consent`
- **Method**: `POST`
- **Auth Required**: None (Usually done immediately post-registration)
- **Body**:
  ```json
  {
    "user_id": "uuid-string",
    "terms_agreed": true,
    "privacy_agreed": true,
    "ai_analysis_agreed": true,
    "disclosure_agreed": true
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "message": "Consent recorded. Access granted.",
    "consent_id": "uuid-string",
    "status": "agreed"
  }
  ```

---

## 2. Mood Logging

### Get Today's Mood Log
Fetches the current user's mood log for the day, if it exists.
- **URL**: `/mood/today`
- **Method**: `GET`
- **Auth Required**: Yes
- **Response**: `200 OK`
  ```json
  {
    "logged_today": true,
    "entry": { ... } // Mood log object or null
  }
  ```

### Get Mood History
Fetches recent mood logs for the authenticated patient.
- **URL**: `/mood/history`
- **Method**: `GET`
- **Auth Required**: Yes
- **Query Params**: `limit` (Optional, max 90, default 30)
- **Response**: `200 OK`
  ```json
  {
    "moods": [ ... ]
  }
  ```

### Submit Daily Mood Log
Logs a mood for the day or updates the existing entry for today.
- **URL**: `/mood`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `patient`)
- **Body**:
  ```json
  {
    "mood": "great", // "great", "good", "okay", "low", "struggling"
    "note": "Feeling productive today." // Optional
  }
  ```
- **Response**: `201 Created` or `200 OK`
  ```json
  {
    "message": "Mood logged successfully.",
    "entry": { ... }
  }
  ```

---

## 3. Journaling

### Submit Journal Entry
Saves a journal entry and asynchronously triggers Gemini AI analysis.
- **URL**: `/journal`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `patient`)
- **Body**:
  ```json
  {
    "content": "Today was a tough day because...",
    "language_code": "en" // Optional, default "en"
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "message": "Journal entry saved. AI analysis is processing in the background.",
    "entry_id": "uuid-string"
  }
  ```

### Get Journal Entries Metadata
Fetches a list of the patient's journal entries (excluding raw content).
- **URL**: `/journal`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `patient`)
- **Query Params**: `limit` (Optional, max 50, default 20)
- **Response**: `200 OK`
  ```json
  {
    "entries": [ ... ]
  }
  ```

---

## 4. AI Reports

### Request Longitudinal Report
Allows a counselor to request an aggregated AI analysis for a patient over a date range.
- **URL**: `/reports/request`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `counselor`)
- **Body**:
  ```json
  {
    "patient_id": "uuid-string",
    "date_range_start": "YYYY-MM-DD",
    "date_range_end": "YYYY-MM-DD",
    "reason": "Evaluating recent behavioral changes."
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "message": "Report request submitted successfully. Awaiting admin approval.",
    "request_id": "uuid-string"
  }
  ```

### Get Report Requests (Counselor)
Fetches all report requests submitted by the counselor.
- **URL**: `/reports/requests`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor`)
- **Response**: `200 OK`
  ```json
  {
    "requests": [ ... ]
  }
  ```

### Get Pending Report Requests (Admin)
Fetches all pending report requests across the platform.
- **URL**: `/reports/admin/pending`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `admin`)
- **Response**: `200 OK`
  ```json
  {
    "requests": [ ... ]
  }
  ```

### Approve/Reject Report Request (Admin)
Approves (triggers analysis) or rejects a report request.
- **URL**: `/reports/admin/:requestId`
- **Method**: `PATCH`
- **Auth Required**: Yes (Role: `admin`)
- **Body**:
  ```json
  {
    "action": "approve", // or "reject"
    "rejection_reason": "Insufficient reason provided." // Required if rejecting
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "message": "Report request approved. AI analysis is processing."
  }
  ```

### Get Patient Reports
Fetches AI reports for a specific patient.
- **URL**: `/reports/patient/:patientId`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor` or `admin`)
- **Response**: `200 OK`
  ```json
  {
    "reports": [ ... ]
  }
  ```

---

## 5. Clinical Evaluations

### Submit Evaluation
Allows a counselor to evaluate and plan next steps based on an AI report.
- **URL**: `/evaluations`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `counselor`)
- **Body**:
  ```json
  {
    "ai_report_id": "uuid-string",
    "patient_id": "uuid-string",
    "clinical_impression": "Patient shows signs of...",
    "ai_recommendation_status": "approved", // "approved", "modified", "rejected"
    "modification_reason": "AI missed context.", // Required if modified/rejected
    "next_step": "schedule_session", // "schedule_session", "refer_external", "monitor_only", "emergency_referral"
    "external_referral_name": "Local Clinic", // Optional
    "counselor_notes": "Internal notes here" // Optional
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "message": "Evaluation submitted. You can now schedule a reactive session for this patient.",
    "evaluation_id": "uuid-string",
    "next_step": "schedule_session"
  }
  ```

### Get Patient Evaluations
- **URL**: `/evaluations/patient/:patientId`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor` or `admin`)
- **Response**: `200 OK`
  ```json
  {
    "evaluations": [ ... ]
  }
  ```

---

## 6. Counseling Sessions

### Request Proactive Session (Patient)
- **URL**: `/sessions/proactive`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `patient`)
- **Body**:
  ```json
  {
    "preferred_date": "2023-10-15T14:00:00Z",
    "notes": "Feeling overwhelmed" // Optional
  }
  ```
- **Response**: `201 Created`

### Schedule Reactive Session (Counselor)
- **URL**: `/sessions/reactive`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `counselor`)
- **Body**:
  ```json
  {
    "patient_id": "uuid-string",
    "scheduled_at": "2023-10-15T14:00:00Z",
    "evaluation_id": "uuid-string", // Optional
    "ai_report_id": "uuid-string", // Optional
    "notes": "Follow-up session" // Optional
  }
  ```
- **Response**: `201 Created`

### Update Session Status
- **URL**: `/sessions/:sessionId/status`
- **Method**: `PATCH`
- **Auth Required**: Yes
- **Body**:
  ```json
  {
    "status": "active", // "active", "completed", "cancelled", "no_show"
    "session_notes": "Summary of session", // Optional for completed
    "cancellation_reason": "Patient unavailable" // Optional for cancelled
  }
  ```
- **Response**: `200 OK`

### Get My Sessions
- **URL**: `/sessions`
- **Method**: `GET`
- **Auth Required**: Yes
- **Response**: `200 OK` (Returns sessions relevant to the authenticated patient or counselor)

### Request Counselor Reassignment (Patient)
- **URL**: `/sessions/reassign`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `patient`)
- **Response**: `200 OK`

### Assign Counselor (Admin)
Manually assigns a counselor or triggers auto-assignment.
- **URL**: `/sessions/admin/assign`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `admin`)
- **Body**:
  ```json
  {
    "patient_id": "uuid-string",
    "counselor_id": "uuid-string" // Omit for auto-assign
  }
  ```
- **Response**: `200 OK`

---

## 7. Analytics

### Generate Analytics Snapshot (Admin/Cron)
Generates end-of-day analytics for all counselors based on their assigned patients.
- **URL**: `/analytics/snapshot`
- **Method**: `POST`
- **Auth Required**: Yes (Role: `admin`)
- **Response**: `200 OK`

### Get My Analytics Snapshot Today (Counselor)
- **URL**: `/analytics/snapshot/me`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor`)
- **Response**: `200 OK`

### Get Analytics Snapshot History (Counselor)
- **URL**: `/analytics/snapshot/history`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor`)
- **Query Params**: `limit` (Optional, max 90, default 30)
- **Response**: `200 OK`

---

## 8. Notifications

### Get Notifications
- **URL**: `/notifications`
- **Method**: `GET`
- **Auth Required**: Yes
- **Query Params**: 
  - `limit` (Optional, default 20)
  - `unread` (Optional boolean, e.g., `true`)
- **Response**: `200 OK`

### Mark Notification as Read
- **URL**: `/notifications/:id/read`
- **Method**: `PATCH`
- **Auth Required**: Yes
- **Response**: `200 OK`

### Mark All Notifications as Read
- **URL**: `/notifications/read-all`
- **Method**: `PATCH`
- **Auth Required**: Yes
- **Response**: `200 OK`

---

## 9. Dashboards

### Patient Dashboard
Aggregates today's mood, wellness quotes, recent reports, and upcoming sessions.
- **URL**: `/dashboard/patient`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `patient`)
- **Response**: `200 OK`

### Counselor Dashboard
Aggregates counselor analytics, assigned patients, and upcoming sessions.
- **URL**: `/dashboard/counselor`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `counselor`)
- **Response**: `200 OK`

### Admin Dashboard
Aggregates pending requests, user metrics, and recent audit logs.
- **URL**: `/dashboard/admin`
- **Method**: `GET`
- **Auth Required**: Yes (Role: `admin`)
- **Response**: `200 OK`
