# E-MindBridge — Permissions Matrix

## Legend
- ✅ Full access
- 🔒 Own records only
- 👁 Read-only
- 🚫 No access
- 🔑 Via assignment (counselor must be assigned to the patient)

---

## Table-Level Permissions

| Table | Patient | Counselor | Admin |
|---|---|---|---|
| `profiles` (own) | 🔒 R/W | 🔒 R/W | ✅ |
| `profiles` (others) | 🚫 | 🔑 R only | ✅ |
| `counselor_profiles` (own) | 🚫 | 🔒 R/W | ✅ |
| `counselor_profiles` (others) | 🚫 | 👁 limited | ✅ |
| `consent_records` | 🔒 R/W | 🚫 | ✅ |
| `mood_logs` (own) | 🔒 R/W | 🚫 direct | ✅ |
| `mood_logs` (patient's) | — | 🔑 R only | ✅ |
| `journal_entries` (own) | 🔒 R/W | 🚫 | ✅ |
| `journal_entries` (patient's) | — | 🚫 (by design) | ✅ |
| `ai_reports` (own) | 🔒 R only | 🚫 direct | ✅ |
| `ai_reports` (patient's) | — | 🔑 R only | ✅ |
| `report_requests` | 🚫 | 🔒 own requests | ✅ |
| `counselor_evaluations` (own) | 🔒 R only | 🔒 R/W | ✅ |
| `counseling_sessions` (own) | 🔒 R + INSERT | 🔒 R/W | ✅ |
| `notifications` (own) | 🔒 R + mark read | 🔒 R + mark read | ✅ |
| `counselor_patient_assignments` | 🚫 | 🔑 R only | ✅ |
| `analytics_snapshots` | 🚫 | 🔒 own group | ✅ |
| `wellness_quotes` | 👁 active only | 👁 + R/W manage | ✅ |
| `wellness_resources` | 👁 active only | 👁 active only | ✅ |
| `audit_logs` | 🔒 own entries | 🚫 | ✅ |

---

## Feature-Level Permissions

| Feature | Patient | Counselor | Admin |
|---|---|---|---|
| View own dashboard | ✅ | ✅ | ✅ |
| Submit daily mood | ✅ | 🚫 | 🚫 |
| Write journal entry | ✅ | 🚫 | 🚫 |
| Read raw journal entries | 🔒 own | 🚫 | ✅ |
| View AI report summary | 🔒 own | 🔑 assigned patients | ✅ |
| Trigger automatic AI analysis | System only | 🚫 | 🚫 |
| Submit on-request AI report | 🚫 | ✅ (pending admin) | ✅ |
| Approve / reject report request | 🚫 | 🚫 | ✅ |
| Submit counselor evaluation | 🚫 | 🔑 assigned patients | 🚫 |
| Schedule session (proactive) | ✅ | 🚫 | 🚫 |
| Schedule session (reactive) | 🚫 | 🔑 assigned patients | ✅ |
| Join tele-counseling room | ✅ own sessions | ✅ own sessions | 👁 audit only |
| Request counselor reassignment | ✅ | 🚫 | ✅ |
| Manually assign counselor | 🚫 | 🚫 | ✅ |
| View counselor dashboard (macro) | 🚫 | ✅ own group | ✅ |
| View patient MindProfile | 🚫 | 🔑 assigned only | ✅ |
| Manage wellness quotes | 🚫 | ✅ | ✅ |
| Manage wellness resources | 🚫 | 🚫 | ✅ |
| Manage user accounts | 🚫 | 🚫 | ✅ |
| View audit logs | 🔒 own only | 🚫 | ✅ |
| View analytics snapshots | 🚫 | 🔒 own group | ✅ |
| Update counselor specialties | 🚫 | 🔒 own | ✅ |
| Toggle counselor availability | 🚫 | 🔒 own | ✅ |
| Withdraw consent | ✅ | 🚫 | 🚫 |

---

## RLS Policy Summary

### Policies that block by design (not by accident)

| Policy | Table | Reason |
|---|---|---|
| `USING (FALSE)` for counselors | `journal_entries` | Patient privacy — counselors must never read raw text |
| No INSERT policy for patients | `ai_reports` | Reports are only written by the system (service role) |
| No DELETE policy | `consent_records` | Consent history is immutable for compliance |
| No DELETE policy | `audit_logs` | Audit trail is append-only |
| Admin role check via subquery | Multiple | Admin role cannot be self-granted; only set via Supabase dashboard or protected server action |

---

## Route-Level Guards (hooks.server.ts)

Every authenticated route checks these in order:

```
1. Is the user authenticated?          → NO  → redirect /login
2. Does the user have a profile?       → NO  → redirect /register (edge case)
3. Does the user have valid consent    → NO  → redirect /consent
   for the current CONSENT_VERSION?
4. Does the route require a role?      → YES → check profiles.role
   (e.g. /admin/* requires 'admin')          → mismatch → 403
   (e.g. /counselor/* requires 'counselor')
```

---

## Notes on Sensitive Boundaries

**Patients and AI reports:** Patients can see that their data has been analyzed, and may see a simplified summary (e.g. "Your recent entries suggest academic stress"), but should NOT see the full threat detection flags or clinical recommendations in the patient-facing UI. The full `ai_reports` record is for counselors only.

**Counselor specialty visibility:** A patient should not be able to see a counselor's specialty tags — only their name and availability. Specialty is an internal routing mechanism.

**Admin and raw journals:** Admin technically has RLS access to `journal_entries` but this access should be gated behind a separate UI confirmation step in the application layer and logged to `audit_logs` every time.
