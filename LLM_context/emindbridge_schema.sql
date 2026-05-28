-- ============================================================
-- E-MindBridge: Mental Health Counseling Application
-- Supabase PostgreSQL Schema
-- Compatible with Supabase Auth (auth.users)
-- ============================================================

-- ============================================================
-- SECTION 0: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for text search on journal entries


-- ============================================================
-- SECTION 1: ENUMS
-- ============================================================

CREATE TYPE user_role AS ENUM ('patient', 'counselor', 'admin');

CREATE TYPE mood_level AS ENUM ('great', 'good', 'okay', 'low', 'struggling');

CREATE TYPE risk_level AS ENUM ('low', 'moderate', 'high', 'critical');

CREATE TYPE sentiment_type AS ENUM ('positive', 'neutral', 'negative');

CREATE TYPE session_status AS ENUM ('scheduled', 'active', 'completed', 'cancelled', 'no_show');

CREATE TYPE session_request_type AS ENUM ('proactive', 'reactive'); -- User-initiated vs counselor-initiated

CREATE TYPE primary_category AS ENUM ('academic', 'personal', 'grief', 'career', 'family', 'social', 'health', 'other');

CREATE TYPE threat_detection_status AS ENUM ('detected', 'not_detected');

CREATE TYPE ai_recommendation_status AS ENUM ('approved', 'modified', 'rejected', 'pending');

CREATE TYPE next_step_type AS ENUM ('schedule_session', 'refer_external', 'monitor_only', 'emergency_referral');

CREATE TYPE notification_type AS ENUM ('session_scheduled', 'session_reminder', 'risk_alert', 'general');

CREATE TYPE consent_status AS ENUM ('pending', 'agreed', 'withdrawn');


-- ============================================================
-- SECTION 2: USER PROFILES
-- Extends Supabase auth.users (never modify auth.users directly)
-- ============================================================

CREATE TABLE public.profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role            user_role NOT NULL DEFAULT 'patient',
    full_name       TEXT,
    display_name    TEXT,
    date_of_birth   DATE,
    gender          TEXT,
    contact_number  TEXT,
    school_or_org   TEXT,           -- e.g. school name, department
    section_or_grade TEXT,          -- applicable for students
    profile_photo_url TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_anonymous    BOOLEAN NOT NULL DEFAULT FALSE, -- for reports using Anonymous ID
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.profiles IS 'Extended user profile linked to Supabase auth.users.';
COMMENT ON COLUMN public.profiles.is_anonymous IS 'If true, reports will use an anonymous ID instead of full name.';


-- ============================================================
-- SECTION 3: ETHICS & PRIVACY CONSENT
-- Users must agree before accessing the dashboard
-- ============================================================

CREATE TABLE public.consent_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    consent_version TEXT NOT NULL,              -- e.g. "v1.0", "v1.2" for policy versioning
    terms_agreed    BOOLEAN NOT NULL DEFAULT FALSE,
    privacy_agreed  BOOLEAN NOT NULL DEFAULT FALSE,
    ai_analysis_agreed BOOLEAN NOT NULL DEFAULT FALSE,
    disclosure_agreed BOOLEAN NOT NULL DEFAULT FALSE, -- confidentiality/harm disclosure clause
    status          consent_status NOT NULL DEFAULT 'pending',
    agreed_at       TIMESTAMPTZ,
    withdrawn_at    TIMESTAMPTZ,
    ip_address      INET,                       -- for audit trail
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.consent_records IS 'Tracks user consent to Ethics & Privacy modules. A valid agreed record is required before dashboard access.';
COMMENT ON COLUMN public.consent_records.consent_version IS 'Version of the consent document signed. Increment when policy changes to re-prompt users.';


-- ============================================================
-- SECTION 4: DAILY MOOD TRACKING
-- ============================================================

CREATE TABLE public.mood_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    mood            mood_level NOT NULL,
    note            TEXT,                       -- optional short note with the mood
    logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Prevent duplicate entries for the same calendar day (enforced via unique index below)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mood_logs_user_date ON public.mood_logs (user_id, logged_at DESC);
CREATE UNIQUE INDEX uq_mood_per_day ON public.mood_logs (user_id, ((logged_at AT TIME ZONE 'UTC')::DATE));
CREATE INDEX idx_mood_logs_mood ON public.mood_logs (mood);

COMMENT ON TABLE public.mood_logs IS 'Daily mood check-in by patient. One entry per user per day enforced via unique constraint.';


-- ============================================================
-- SECTION 5: JOURNAL ENTRIES (The Sanctuary)
-- Entries are stored; encryption at rest handled by Supabase/Postgres
-- ============================================================

CREATE TABLE public.journal_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,              -- raw journal text
    language_code   TEXT DEFAULT 'en',          -- supports multilingual entries (e.g., 'fil', 'ilo')
    is_analyzed     BOOLEAN NOT NULL DEFAULT FALSE,
    analysis_queued_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_journal_entries_user ON public.journal_entries (user_id, created_at DESC);
CREATE INDEX idx_journal_entries_unanalyzed ON public.journal_entries (is_analyzed) WHERE is_analyzed = FALSE;

COMMENT ON TABLE public.journal_entries IS 'Patient journal entries. Content should be stored encrypted at the application or Supabase storage level. Queued for AI analysis after save.';


-- ============================================================
-- SECTION 6: AI ANALYSIS REPORTS (MindProfile)
-- One report can cover one journal entry or a longitudinal period
-- ============================================================

CREATE TABLE public.ai_reports (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id        UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
    user_id                 UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    report_reference_number TEXT UNIQUE,        -- auto-generated readable ID, e.g. "RPT-20250513-001"
    analysis_period_start   DATE,               -- for longitudinal reports
    analysis_period_end     DATE,
    platform_context        TEXT DEFAULT 'Mobile App',

    -- II. AI Triage & Diagnostic Overview
    risk_level              risk_level NOT NULL DEFAULT 'low',
    sentiment               sentiment_type NOT NULL DEFAULT 'neutral',
    primary_category        primary_category NOT NULL DEFAULT 'other',

    -- IV. AI Analytical Summary
    longitudinal_pattern    TEXT,
    emotional_markers       TEXT[],             -- array of marker strings
    behavioral_tendencies   TEXT,

    -- Critical Threat Check
    self_harm_detected      threat_detection_status NOT NULL DEFAULT 'not_detected',
    suicidal_ideation_detected threat_detection_status NOT NULL DEFAULT 'not_detected',
    specific_triggers       TEXT[],             -- identified names, places, events

    -- V. AI-Generated Recommendations
    immediate_action        TEXT,
    self_help_suggestion    TEXT,
    clinical_goal           TEXT,

    -- Metadata
    ai_model_version        TEXT,               -- track which AI model generated this
    generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_reports_user ON public.ai_reports (user_id, generated_at DESC);
CREATE INDEX idx_ai_reports_risk ON public.ai_reports (risk_level);
CREATE INDEX idx_ai_reports_threats ON public.ai_reports (self_harm_detected, suicidal_ideation_detected);

COMMENT ON TABLE public.ai_reports IS 'AI-generated MindProfile report for a journal entry or period. Feeds into counselor dashboard.';


-- ============================================================
-- SECTION 7: COUNSELOR EVALUATIONS
-- Counselor human-validation layer on top of AI reports
-- ============================================================

CREATE TABLE public.counselor_evaluations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ai_report_id                UUID NOT NULL REFERENCES public.ai_reports(id) ON DELETE CASCADE,
    counselor_id                UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    patient_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- VI. Counselor's Evaluation
    clinical_impression         TEXT,
    ai_recommendation_status    ai_recommendation_status NOT NULL DEFAULT 'pending',
    modification_reason         TEXT,           -- required if status = 'modified' or 'rejected'
    next_step                   next_step_type NOT NULL DEFAULT 'monitor_only',
    external_referral_name      TEXT,           -- if next_step = 'refer_external'
    counselor_notes             TEXT,

    evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_evaluations_counselor ON public.counselor_evaluations (counselor_id);
CREATE INDEX idx_evaluations_patient ON public.counselor_evaluations (patient_id);
CREATE INDEX idx_evaluations_report ON public.counselor_evaluations (ai_report_id);

COMMENT ON TABLE public.counselor_evaluations IS 'Counselor professional assessment layered over AI reports. Ensures AI is a tool, not a replacement for clinical judgment.';


-- ============================================================
-- SECTION 8: TELE-COUNSELING SESSIONS
-- ============================================================

CREATE TABLE public.counseling_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    counselor_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    ai_report_id        UUID REFERENCES public.ai_reports(id) ON DELETE SET NULL, -- if session triggered by a report
    evaluation_id       UUID REFERENCES public.counselor_evaluations(id) ON DELETE SET NULL,

    request_type        session_request_type NOT NULL DEFAULT 'proactive',
    status              session_status NOT NULL DEFAULT 'scheduled',

    scheduled_at        TIMESTAMPTZ NOT NULL,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_minutes    INTEGER GENERATED ALWAYS AS (
                            EXTRACT(EPOCH FROM (ended_at - started_at)) / 60
                        ) STORED,

    -- Low-bandwidth mode flag for the video/audio room
    low_bandwidth_mode  BOOLEAN NOT NULL DEFAULT TRUE,
    room_url            TEXT,                   -- generated video room link (e.g., Daily.co, Jitsi)
    session_notes       TEXT,                   -- counselor's post-session notes
    cancellation_reason TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_patient ON public.counseling_sessions (patient_id, scheduled_at DESC);
CREATE INDEX idx_sessions_counselor ON public.counseling_sessions (counselor_id, scheduled_at DESC);
CREATE INDEX idx_sessions_status ON public.counseling_sessions (status);
CREATE INDEX idx_sessions_scheduled ON public.counseling_sessions (scheduled_at);

COMMENT ON TABLE public.counseling_sessions IS 'Tele-counseling session records. Supports both patient-initiated (proactive) and counselor-scheduled (reactive) sessions.';


-- ============================================================
-- SECTION 9: NOTIFICATIONS & ALERTS
-- ============================================================

CREATE TABLE public.notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    sender_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- null = system notification
    type            notification_type NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    related_session_id UUID REFERENCES public.counseling_sessions(id) ON DELETE SET NULL,
    related_report_id  UUID REFERENCES public.ai_reports(id) ON DELETE SET NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON public.notifications (recipient_id, is_read, created_at DESC);

COMMENT ON TABLE public.notifications IS 'In-app notifications for session alerts, risk flags, and general messages.';


-- ============================================================
-- SECTION 10: WELLNESS RESOURCES (Wellness Compass)
-- Self-help modules referenced in AI recommendations
-- ============================================================

CREATE TABLE public.wellness_resources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    description     TEXT,
    category        primary_category NOT NULL DEFAULT 'other',
    resource_type   TEXT NOT NULL,              -- e.g. 'breathing_exercise', 'cbt_module', 'article'
    content_url     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.wellness_resources IS 'Self-help modules and resources available via the Wellness Compass feature.';


-- ============================================================
-- SECTION 11: COUNSELOR–PATIENT ASSIGNMENTS
-- Tracks which counselors oversee which patients
-- ============================================================

CREATE TABLE public.counselor_patient_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counselor_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    patient_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_counselor_patient UNIQUE (counselor_id, patient_id)
);

CREATE INDEX idx_assignments_counselor ON public.counselor_patient_assignments (counselor_id) WHERE is_active = TRUE;
CREATE INDEX idx_assignments_patient ON public.counselor_patient_assignments (patient_id) WHERE is_active = TRUE;


-- ============================================================
-- SECTION 12: AGGREGATE ANALYTICS SNAPSHOTS
-- Pre-computed for counselor macro dashboard (Group-level view)
-- ============================================================

CREATE TABLE public.analytics_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date   DATE NOT NULL,
    counselor_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- scope: counselor's patient group
    total_users     INTEGER NOT NULL DEFAULT 0,
    mood_great_pct  NUMERIC(5,2),
    mood_good_pct   NUMERIC(5,2),
    mood_okay_pct   NUMERIC(5,2),
    mood_low_pct    NUMERIC(5,2),
    mood_struggling_pct NUMERIC(5,2),
    global_risk_level risk_level NOT NULL DEFAULT 'low',
    high_risk_count INTEGER NOT NULL DEFAULT 0,
    top_category    primary_category,
    trend_notes     TEXT,                       -- e.g. "Spike in Academic Crisis this week"
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_snapshot_date_counselor UNIQUE (snapshot_date, counselor_id)
);

COMMENT ON TABLE public.analytics_snapshots IS 'Materialized daily aggregate snapshots for counselor macro dashboard. Generated by a scheduled function or cron job.';


-- ============================================================
-- SECTION 13: AUDIT LOG
-- Tracks sensitive actions for accountability
-- ============================================================

CREATE TABLE public.audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,              -- e.g. 'viewed_report', 'triggered_ai_analysis', 'scheduled_session'
    target_table    TEXT,
    target_id       UUID,
    metadata        JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_actor ON public.audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON public.audit_logs (action);

COMMENT ON TABLE public.audit_logs IS 'Immutable audit trail for sensitive operations (report views, AI triggers, session scheduling). Critical for compliance.';


-- ============================================================
-- SECTION 14: HELPER FUNCTIONS
-- ============================================================

-- Auto-generate report reference numbers: RPT-YYYYMMDD-XXX
CREATE OR REPLACE FUNCTION generate_report_reference()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    today_str TEXT := TO_CHAR(NOW(), 'YYYYMMDD');
    seq_val   INTEGER;
    ref       TEXT;
BEGIN
    SELECT COUNT(*) + 1
    INTO seq_val
    FROM public.ai_reports
    WHERE DATE(generated_at) = CURRENT_DATE;

    ref := 'RPT-' || today_str || '-' || LPAD(seq_val::TEXT, 3, '0');
    RETURN ref;
END;
$$;

-- Auto-update `updated_at` timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


-- ============================================================
-- SECTION 15: TRIGGERS
-- ============================================================

-- profiles.updated_at
CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- journal_entries.updated_at
CREATE TRIGGER trg_journal_entries_updated_at
    BEFORE UPDATE ON public.journal_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- counselor_evaluations.updated_at
CREATE TRIGGER trg_evaluations_updated_at
    BEFORE UPDATE ON public.counselor_evaluations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- counseling_sessions.updated_at
CREATE TRIGGER trg_sessions_updated_at
    BEFORE UPDATE ON public.counseling_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-set report reference number on insert
CREATE OR REPLACE FUNCTION set_report_reference()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.report_reference_number IS NULL THEN
        NEW.report_reference_number := generate_report_reference();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_reports_reference
    BEFORE INSERT ON public.ai_reports
    FOR EACH ROW EXECUTE FUNCTION set_report_reference();

-- Auto-create profile after Supabase auth user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, role)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
        COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'patient')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- SECTION 16: ROW LEVEL SECURITY (RLS)
-- Critical for Supabase: patients can only see their own data
-- ============================================================

-- Enable RLS on all sensitive tables
ALTER TABLE public.profiles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consent_records               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mood_logs                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reports                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselor_evaluations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counseling_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselor_patient_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_snapshots           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wellness_resources            ENABLE ROW LEVEL SECURITY;

-- ---- profiles ----
CREATE POLICY "Users can view their own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

CREATE POLICY "Counselors can view assigned patient profiles"
    ON public.profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.counselor_patient_assignments cpa
            WHERE cpa.counselor_id = auth.uid()
              AND cpa.patient_id = profiles.id
              AND cpa.is_active = TRUE
        )
    );

-- ---- consent_records ----
CREATE POLICY "Users can manage their own consent"
    ON public.consent_records FOR ALL
    USING (auth.uid() = user_id);

-- ---- mood_logs ----
CREATE POLICY "Patients can manage their own mood logs"
    ON public.mood_logs FOR ALL
    USING (auth.uid() = user_id);

CREATE POLICY "Counselors can view assigned patient mood logs"
    ON public.mood_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.counselor_patient_assignments cpa
            WHERE cpa.counselor_id = auth.uid()
              AND cpa.patient_id = mood_logs.user_id
              AND cpa.is_active = TRUE
        )
    );

-- ---- journal_entries ----
CREATE POLICY "Patients can manage their own journal entries"
    ON public.journal_entries FOR ALL
    USING (auth.uid() = user_id);

CREATE POLICY "Counselors cannot read raw journal entries"
    ON public.journal_entries FOR SELECT
    USING (FALSE); -- Counselors access journals only through AI summary reports

-- ---- ai_reports ----
CREATE POLICY "Patients can view their own AI reports"
    ON public.ai_reports FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Counselors can view assigned patient AI reports"
    ON public.ai_reports FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.counselor_patient_assignments cpa
            WHERE cpa.counselor_id = auth.uid()
              AND cpa.patient_id = ai_reports.user_id
              AND cpa.is_active = TRUE
        )
    );

-- ---- counselor_evaluations ----
CREATE POLICY "Counselors can manage their own evaluations"
    ON public.counselor_evaluations FOR ALL
    USING (auth.uid() = counselor_id);

CREATE POLICY "Patients can view their own evaluations"
    ON public.counselor_evaluations FOR SELECT
    USING (auth.uid() = patient_id);

-- ---- counseling_sessions ----
CREATE POLICY "Patients can view their own sessions"
    ON public.counseling_sessions FOR SELECT
    USING (auth.uid() = patient_id);

CREATE POLICY "Counselors can manage sessions they own"
    ON public.counseling_sessions FOR ALL
    USING (auth.uid() = counselor_id);

CREATE POLICY "Patients can insert session requests"
    ON public.counseling_sessions FOR INSERT
    WITH CHECK (auth.uid() = patient_id);

-- ---- notifications ----
CREATE POLICY "Users can view their own notifications"
    ON public.notifications FOR SELECT
    USING (auth.uid() = recipient_id);

CREATE POLICY "Users can mark their notifications as read"
    ON public.notifications FOR UPDATE
    USING (auth.uid() = recipient_id);

-- ---- wellness_resources ----
CREATE POLICY "All authenticated users can view active resources"
    ON public.wellness_resources FOR SELECT
    USING (is_active = TRUE AND auth.role() = 'authenticated');

-- ---- analytics_snapshots ----
CREATE POLICY "Counselors can view their own snapshots"
    ON public.analytics_snapshots FOR SELECT
    USING (auth.uid() = counselor_id);

-- ---- audit_logs ----
CREATE POLICY "Admins can view all audit logs"
    ON public.audit_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'admin'
        )
    );

CREATE POLICY "Users can view their own audit logs"
    ON public.audit_logs FOR SELECT
    USING (auth.uid() = actor_id);


-- ============================================================
-- SECTION 17: SEED DATA — Wellness Resources
-- ============================================================

INSERT INTO public.wellness_resources (title, description, category, resource_type) VALUES
    ('Deep Breathing Exercise', '4-7-8 breathing technique for acute anxiety relief.', 'personal', 'breathing_exercise'),
    ('Cognitive Behavioral Therapy: Thought Log', 'Identify and reframe negative automatic thoughts.', 'personal', 'cbt_module'),
    ('Grief Processing Journal Prompts', 'Structured prompts for processing loss and bereavement.', 'grief', 'journaling_guide'),
    ('Academic Stress Management', 'Time management and study habits for reducing academic pressure.', 'academic', 'article'),
    ('Grounding Technique: 5-4-3-2-1', 'Sensory grounding exercise for dissociation and panic.', 'personal', 'interactive_exercise'),
    ('Career Anxiety Worksheet', 'Clarifying values and next steps under career uncertainty.', 'career', 'cbt_module');


-- ============================================================
-- ============================================================
-- SECTION 18: WELLNESS QUOTES
-- Daily inspirational quotes shown on the patient dashboard.
-- Tags align with primary_category enum so quotes can be
-- filtered dynamically based on trending patient concerns.
-- ============================================================

CREATE TABLE public.wellness_quotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    content         TEXT NOT NULL,                  -- the quote text
    author          TEXT,                           -- attribution; NULL = anonymous/unknown

    -- Tags stored as a text array so a quote can belong to
    -- multiple categories (e.g. '{academic, personal}').
    -- Values should match primary_category enum labels for
    -- trend-filter queries to work cleanly.
    tags            TEXT[] NOT NULL DEFAULT '{}',

    -- Optional mood-level hints — lets the system surface
    -- uplifting quotes specifically when a patient logs 'low'
    -- or 'struggling' moods.
    mood_targets    mood_level[] NOT NULL DEFAULT '{}',

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup for active quotes filtered by tag
CREATE INDEX idx_quotes_tags   ON public.wellness_quotes USING GIN (tags);
-- Fast lookup by mood target
CREATE INDEX idx_quotes_moods  ON public.wellness_quotes USING GIN (mood_targets);
CREATE INDEX idx_quotes_active ON public.wellness_quotes (is_active) WHERE is_active = TRUE;

COMMENT ON TABLE public.wellness_quotes IS
    'Inspirational quotes shown on the patient dashboard. '
    'Tags mirror primary_category values so the backend can JOIN '
    'against analytics_snapshots.top_category or recent ai_reports.primary_category '
    'to surface contextually relevant quotes in real time.';

COMMENT ON COLUMN public.wellness_quotes.tags IS
    'Array of category labels (e.g. academic, grief, personal). '
    'Use ANY(tags) in queries to filter. Should align with primary_category enum.';

COMMENT ON COLUMN public.wellness_quotes.mood_targets IS
    'Optional mood levels this quote is best suited for (e.g. {low, struggling}). '
    'Empty array means the quote is shown regardless of current mood.';

-- Auto-update updated_at
CREATE TRIGGER trg_quotes_updated_at
    BEFORE UPDATE ON public.wellness_quotes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- RLS ----
ALTER TABLE public.wellness_quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view active quotes"
    ON public.wellness_quotes FOR SELECT
    USING (is_active = TRUE AND auth.role() = 'authenticated');

CREATE POLICY "Admins and counselors can manage quotes"
    ON public.wellness_quotes FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('admin', 'counselor')
        )
    );


-- ============================================================
-- SECTION 18a: TREND-BASED QUOTE FILTER HELPER FUNCTION
-- Call this from your Svelte backend / Edge Function to get
-- quotes that match the current trending category for a
-- counselor's patient group, or a patient's own mood today.
-- ============================================================

CREATE OR REPLACE FUNCTION get_quotes_for_patient(
    p_patient_id    UUID,
    p_limit         INTEGER DEFAULT 3,
    p_override_tag  TEXT    DEFAULT NULL
)
RETURNS SETOF public.wellness_quotes
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_tag   TEXT;
    v_mood  mood_level;
BEGIN
    IF p_override_tag IS NOT NULL THEN
        v_tag := p_override_tag;
    ELSIF p_patient_id IS NOT NULL THEN
        SELECT ar.primary_category::TEXT
        INTO   v_tag
        FROM   public.ai_reports ar
        WHERE  ar.user_id = p_patient_id
        ORDER  BY ar.generated_at DESC
        LIMIT  1;

        SELECT ml.mood
        INTO   v_mood
        FROM   public.mood_logs ml
        WHERE  ml.user_id = p_patient_id
          AND  ml.logged_at::DATE = CURRENT_DATE
        LIMIT  1;
    END IF;

    RETURN QUERY
        SELECT q.*
        FROM   public.wellness_quotes q
        WHERE  q.is_active = TRUE
          AND  (
                  (v_tag  IS NOT NULL AND v_tag  = ANY(q.tags))
               OR (v_mood IS NOT NULL AND v_mood = ANY(q.mood_targets))
               OR (v_tag IS NULL AND v_mood IS NULL)
              )
        ORDER  BY RANDOM()
        LIMIT  p_limit;
END;
$$;

COMMENT ON FUNCTION get_quotes_for_patient IS
    'Returns N random quotes matched to a patient''s latest AI report category '
    'and today''s mood. Falls back to any active quote if no context is found.';


-- ============================================================
-- SECTION 18b: SEED DATA — Wellness Quotes
-- ============================================================

INSERT INTO public.wellness_quotes (content, author, tags, mood_targets) VALUES
    ('You don''t have to control your thoughts. You just have to stop letting them control you.',
     'Dan Millman', ARRAY['personal'], ARRAY['low','struggling']::mood_level[]),
    ('Grades do not define your intelligence, and age does not define your maturity.',
     NULL, ARRAY['academic'], ARRAY['low','struggling','okay']::mood_level[]),
    ('Grief is the price we pay for love — and it is always worth it.',
     'Queen Elizabeth II', ARRAY['grief','personal'], ARRAY['struggling','low']::mood_level[]),
    ('Your career is a marathon, not a sprint. Pace yourself.',
     NULL, ARRAY['career'], ARRAY['okay','low']::mood_level[]),
    ('Rest if you must, but do not quit.',
     'Edgar A. Guest', ARRAY['personal','academic','career'], ARRAY['struggling','low']::mood_level[]),
    ('Small progress is still progress.',
     NULL, ARRAY['academic','personal','career'], ARRAY['okay','low','struggling']::mood_level[]),
    ('You are allowed to be both a masterpiece and a work in progress simultaneously.',
     'Sophia Bush', ARRAY['personal'], ARRAY['great','good','okay']::mood_level[]),
    ('Family is not an important thing. It''s everything.',
     'Michael J. Fox', ARRAY['family','personal'], ARRAY[]::mood_level[]),
    ('Healing takes time, and asking for help is a courageous step.',
     NULL, ARRAY['health','personal','grief'], ARRAY['struggling','low']::mood_level[]),
    ('You belong here. Your presence matters.',
     NULL, ARRAY['social','personal'], ARRAY['struggling','low','okay']::mood_level[]);


-- ============================================================
-- END OF SCHEMA
-- ============================================================

-- ============================================================
-- SECTION 19: COUNSELOR PROFILES
-- One-to-one extension of profiles for role = 'counselor'.
-- Stores professional metadata and specialty tags used for
-- smart patient auto-assignment.
-- ============================================================

CREATE TYPE assignment_type AS ENUM ('auto', 'manual', 'patient_requested');

CREATE TABLE public.counselor_profiles (
    id                  UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- Professional credentials
    license_number      TEXT,
    years_of_experience INTEGER,
    bio                 TEXT,

    -- Specialty tags — values should mirror primary_category enum
    -- e.g. ARRAY['academic', 'grief', 'career']
    -- Used by assign-counselor Edge Function to rank matches
    specialties         TEXT[] NOT NULL DEFAULT '{}',

    -- Availability flag — toggled by counselor or system
    -- Set to FALSE automatically when active patient count >= max_patient_load
    is_available        BOOLEAN NOT NULL DEFAULT TRUE,

    -- Soft cap on concurrent active patient assignments
    max_patient_load    INTEGER NOT NULL DEFAULT 10,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_counselor_profiles_specialties ON public.counselor_profiles USING GIN (specialties);
CREATE INDEX idx_counselor_profiles_available   ON public.counselor_profiles (is_available) WHERE is_available = TRUE;

COMMENT ON TABLE public.counselor_profiles IS
    'Professional extension of profiles for counselors. '
    'specialties[] mirrors primary_category enum values and drives '
    'the auto-assignment ranking in the assign-counselor Edge Function.';

COMMENT ON COLUMN public.counselor_profiles.specialties IS
    'Array of primary_category labels this counselor is trained in. '
    'e.g. {academic, grief, career}. Used for patient-counselor matching.';

COMMENT ON COLUMN public.counselor_profiles.is_available IS
    'FALSE when counselor is on leave, deactivated, or at max_patient_load. '
    'Counselors toggle this manually; the system also checks load at assignment time.';

-- Auto-update updated_at
CREATE TRIGGER trg_counselor_profiles_updated_at
    BEFORE UPDATE ON public.counselor_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- RLS ----
ALTER TABLE public.counselor_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Counselors can manage their own profile"
    ON public.counselor_profiles FOR ALL
    USING (auth.uid() = id);

CREATE POLICY "Admins can manage all counselor profiles"
    ON public.counselor_profiles FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'admin'
        )
    );

-- Patients should NOT see specialty tags — only name/availability
-- This is enforced at the application layer; no RLS read grant for patients.


-- ============================================================
-- SECTION 20: REPORT REQUESTS
-- Counselor-initiated requests for AI reports over a date range.
-- Must be approved by admin before the AI pipeline fires.
-- ============================================================

CREATE TYPE request_status AS ENUM ('pending', 'approved', 'rejected', 'fulfilled');

CREATE TABLE public.report_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,  -- counselor
    patient_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reviewed_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,          -- admin

    date_range_start    DATE NOT NULL,
    date_range_end      DATE NOT NULL,
    reason              TEXT NOT NULL,          -- counselor's justification

    status              request_status NOT NULL DEFAULT 'pending',
    rejection_reason    TEXT,                   -- populated when status = 'rejected'

    -- Set when status transitions to 'fulfilled'
    fulfilled_report_id UUID REFERENCES public.ai_reports(id) ON DELETE SET NULL,

    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at         TIMESTAMPTZ,
    fulfilled_at        TIMESTAMPTZ,

    CONSTRAINT chk_date_range CHECK (date_range_end >= date_range_start)
);

CREATE INDEX idx_report_requests_status      ON public.report_requests (status);
CREATE INDEX idx_report_requests_counselor   ON public.report_requests (requested_by, requested_at DESC);
CREATE INDEX idx_report_requests_patient     ON public.report_requests (patient_id);
CREATE INDEX idx_report_requests_pending     ON public.report_requests (status) WHERE status = 'pending';

COMMENT ON TABLE public.report_requests IS
    'Counselor-submitted requests for an AI MindProfile report over a specific date range. '
    'Admin must approve before the fulfill-report-request Edge Function fires. '
    'Provides a full audit trail of every non-automatic AI generation event.';

-- ---- RLS ----
ALTER TABLE public.report_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Counselors can view and insert their own requests"
    ON public.report_requests FOR SELECT
    USING (auth.uid() = requested_by);

CREATE POLICY "Counselors can insert requests"
    ON public.report_requests FOR INSERT
    WITH CHECK (auth.uid() = requested_by);

CREATE POLICY "Admins can view and update all requests"
    ON public.report_requests FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'admin'
        )
    );


-- ============================================================
-- SECTION 20a: REPORT REQUEST AUDIT TRIGGER
-- Automatically logs status changes to audit_logs
-- ============================================================

CREATE OR REPLACE FUNCTION log_report_request_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO public.audit_logs (actor_id, action, target_table, target_id, metadata)
        VALUES (
            auth.uid(),
            'report_request_status_changed',
            'report_requests',
            NEW.id,
            jsonb_build_object(
                'from_status', OLD.status,
                'to_status',   NEW.status,
                'patient_id',  NEW.patient_id,
                'counselor_id', NEW.requested_by
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_report_request_audit
    AFTER UPDATE ON public.report_requests
    FOR EACH ROW EXECUTE FUNCTION log_report_request_status_change();


-- ============================================================
-- SECTION 21: COUNSELOR_PATIENT_ASSIGNMENTS — REVISED
-- Drop and recreate with assignment_type and is_primary fields.
-- (If applying to an existing DB, use ALTER TABLE instead.)
-- ============================================================

-- Add new columns to existing counselor_patient_assignments
ALTER TABLE public.counselor_patient_assignments
    ADD COLUMN IF NOT EXISTS assignment_type   assignment_type NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS is_primary        BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;   -- e.g. 'patient_requested', 'admin_reassigned'

COMMENT ON COLUMN public.counselor_patient_assignments.assignment_type IS
    'How this assignment was created: auto (system), manual (admin), patient_requested (reassignment).';

COMMENT ON COLUMN public.counselor_patient_assignments.is_primary IS
    'TRUE for the patient''s main counselor. A patient may have only one active primary at a time.';

-- Enforce: a patient can only have one active primary counselor
CREATE UNIQUE INDEX uq_one_primary_counselor_per_patient
    ON public.counselor_patient_assignments (patient_id)
    WHERE is_active = TRUE AND is_primary = TRUE;

