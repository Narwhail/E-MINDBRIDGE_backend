# E-MindBridge — State Machines

## SM-01: Report Request Lifecycle

Applies to: `report_requests.status`

```
                    ┌─────────┐
                    │ PENDING │  ◄── Counselor submits request
                    └────┬────┘
                         │
              Admin reviews the request
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │ APPROVED │          │ REJECTED │  (terminal)
        └────┬─────┘          └──────────┘
             │
    Edge Function fires
    Claude API called
             │
             ▼
        ┌───────────┐
        │ FULFILLED │  (terminal)
        └───────────┘
```

**Valid transitions:**
| From | To | Actor | Condition |
|---|---|---|---|
| `pending` | `approved` | Admin | Admin clicks Approve |
| `pending` | `rejected` | Admin | Admin clicks Reject + provides reason |
| `approved` | `fulfilled` | System (Edge Fn) | AI report successfully written |

**Invalid transitions:** `fulfilled → any`, `rejected → any`

---

## SM-02: AI Report Generation Status

Applies to: `journal_entries.is_analyzed`

```
   ┌───────────────────┐
   │  is_analyzed=FALSE │  ◄── Entry inserted
   └─────────┬─────────┘
             │
    Webhook fires Edge Fn
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
┌──────────┐    ┌──────────────┐
│  TRUE    │    │  (remains    │
│ (success)│    │   FALSE on   │
└──────────┘    │   API error) │
                └──────────────┘
                  Retry policy applies
```

**Notes:**
- If the Claude API call fails, `is_analyzed` stays `FALSE` and the entry remains in the retry queue (filtered by the `idx_journal_entries_unanalyzed` index).
- A dead-letter mechanism (e.g. entries older than 1 hour with `is_analyzed = FALSE`) should alert the admin.

---

## SM-03: Counseling Session Lifecycle

Applies to: `counseling_sessions.status`

```
                     ┌───────────┐
                     │ SCHEDULED │  ◄── Session created
                     └─────┬─────┘
                           │
              ┌────────────┼─────────────┐
              │            │             │
   Either party       Session time    Either party
   cancels before     arrives         no-shows
              │            │             │
              ▼            ▼             ▼
         ┌──────────┐ ┌────────┐  ┌──────────┐
         │CANCELLED │ │ ACTIVE │  │ NO_SHOW  │  (terminal)
         └──────────┘ └───┬────┘  └──────────┘
         (terminal)       │
                     Session ends,
                     counselor submits notes
                          │
                          ▼
                    ┌───────────┐
                    │ COMPLETED │  (terminal)
                    └───────────┘
```

**Valid transitions:**
| From | To | Actor | Condition |
|---|---|---|---|
| `scheduled` | `active` | System | Session start time reached, both parties joined |
| `scheduled` | `cancelled` | Patient or Counselor | Before session start time |
| `scheduled` | `no_show` | System | Session time passed, no join detected |
| `active` | `completed` | Counselor | Counselor ends session + submits notes |

---

## SM-04: Counselor–Patient Assignment Lifecycle

Applies to: `counselor_patient_assignments.is_active`

```
                     ┌────────────┐
                     │  INACTIVE  │
                     └─────┬──────┘
                           │
              Auto-assign (PF-10)
              OR Admin manual assign
                           │
                           ▼
                     ┌───────────┐
                     │  ACTIVE   │  ◄──────────────────────┐
                     └─────┬─────┘                         │
                           │                               │
              ┌────────────┼────────────┐                  │
              │            │            │                   │
     Patient requests  Admin     Counselor            Admin re-assigns
     reassignment    deactivates  leaves/deactivates   same counselor
              │            │            │
              ▼            ▼            ▼
          ┌──────────────────────────────┐
          │  is_active = FALSE           │
          │  deactivated_reason recorded │
          └──────────────┬───────────────┘
                         │
                  New assignment
                  created for patient
                         │
                         └──────────────────────────────►  ACTIVE (new record)
```

**`deactivated_reason` values:** `patient_requested`, `counselor_deactivated`, `admin_reassigned`, `load_exceeded`

---

## SM-05: Counselor Availability

Applies to: `counselor_profiles.is_available`

```
         ┌───────────────┐
         │  UNAVAILABLE  │
         └───────┬───────┘
                 │
    Counselor sets available
    OR Admin sets available
                 │
                 ▼
         ┌───────────────┐
         │   AVAILABLE   │  ◄── Eligible for auto-assignment (PF-10)
         └───────┬───────┘
                 │
     ┌───────────┴───────────┐
     │                       │
Counselor sets         max_patient_load
unavailable            reached
     │                       │
     ▼                       ▼
┌───────────────┐     ┌───────────────┐
│  UNAVAILABLE  │     │  UNAVAILABLE  │
│  (manual)     │     │  (auto)       │
└───────────────┘     └───────────────┘
```

**Notes:**
- Auto-unavailability when `max_patient_load` is reached should be enforced in the `assign-counselor` Edge Function query, not via a trigger (to avoid race conditions).
- Counselors in an `active` session should be considered functionally unavailable for new assignments during that window.

---

## SM-06: Consent Record Lifecycle

Applies to: `consent_records.status`

```
         ┌─────────┐
         │ PENDING │  ◄── Record created on registration
         └────┬────┘
              │
    User completes and clicks
    "I Agree" on all modules
              │
              ▼
         ┌─────────┐
         │  AGREED │  ◄── Dashboard access granted
         └────┬────┘
              │
    ┌─────────┴─────────┐
    │                   │
User withdraws     New policy version
consent            deployed (new PENDING
    │               record created)
    ▼                   │
┌───────────┐           ▼
│ WITHDRAWN │      ┌─────────┐
│ (terminal)│      │ PENDING │  (new record, old AGREED remains)
└───────────┘      └─────────┘
```

**Notes:**
- Consent withdrawal (`WITHDRAWN`) should log the user out and block future login until a new agreement is recorded or an admin reviews the case.
- Old `AGREED` records are never deleted — they form the consent audit trail.
- When `CONSENT_VERSION` env var is bumped, `hooks.server.ts` checks if the user's latest `AGREED` record matches the current version. If not, they are redirected to `/consent` again.
