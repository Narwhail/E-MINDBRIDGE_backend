import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * Get all patients assigned to the authenticated counselor (paginated)
 * GET /api/patients?page=1&limit=10&search=<name>
 *
 * - page    (optional): Page number, 1-indexed. Default: 1
 * - limit   (optional): Number of patients per page. Default: 10, max: 50
 * - search  (optional): Filter by patient's full_name (case-insensitive)
 *
 * Returns patient profile details along with their latest mood and session info.
 */
router.get('/', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;

  const page  = Math.max(parseInt(req.query.page  as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const search = (req.query.search as string)?.trim() || '';
  const offset = (page - 1) * limit;

  // Step 1: Fetch active assignment IDs for this counselor
  const { data: assignments, error: assignError } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('patient_id')
    .eq('counselor_id', counselor.id)
    .eq('is_active', true);

  if (assignError) {
    res.status(500).json({ error: assignError.message });
    return;
  }

  if (!assignments || assignments.length === 0) {
    res.json({
      patients: [],
      pagination: { page, limit, total: 0, total_pages: 0, has_next: false, has_prev: false },
    });
    return;
  }

  const patientIds = assignments.map(a => a.patient_id);

  // Step 2: Build paginated profile query, with optional name search
  let profileQuery = supabaseAdmin
    .from('profiles')
    .select(
      'id, full_name, display_name, gender, section_or_grade, school_or_org, profile_photo_url, is_active, created_at',
      { count: 'exact' }
    )
    .in('id', patientIds)
    .order('full_name', { ascending: true })
    .range(offset, offset + limit - 1);

  if (search) {
    profileQuery = profileQuery.ilike('full_name', `%${search}%`);
  }

  const { data: patients, count, error: profileError } = await profileQuery;

  if (profileError) {
    res.status(500).json({ error: profileError.message });
    return;
  }

  const total       = count ?? 0;
  const total_pages = Math.ceil(total / limit);

  // Step 3: Enrich each patient with their latest mood log
  const enriched = await Promise.all(
    (patients || []).map(async (patient) => {
      const { data: latestMood } = await supabaseAdmin
        .from('mood_logs')
        .select('mood, logged_at')
        .eq('user_id', patient.id)
        .order('logged_at', { ascending: false })
        .limit(1)
        .single();

      const { data: activeSession } = await supabaseAdmin
        .from('counseling_sessions')
        .select('id, status, scheduled_at, request_type')
        .eq('patient_id', patient.id)
        .eq('counselor_id', counselor.id)
        .in('status', ['scheduled', 'active'])
        .order('scheduled_at', { ascending: true })
        .limit(1)
        .single();

      return {
        ...patient,
        latest_mood: latestMood || null,
        active_session: activeSession || null,
      };
    })
  );

  res.json({
    patients: enriched,
    pagination: {
      page,
      limit,
      total,
      total_pages,
      has_next: page < total_pages,
      has_prev: page > 1,
    },
  });
});

/**
 * Get a single assigned patient's full profile
 * GET /api/patients/:patientId
 *
 * Returns the patient's profile, recent mood logs, recent sessions,
 * and any AI reports associated with the patient.
 */
router.get('/:patientId', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const { patientId } = req.params;

  // Verify the counselor is actually assigned to this patient
  const { data: assignment, error: assignError } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('id, assigned_at')
    .eq('counselor_id', counselor.id)
    .eq('patient_id', patientId)
    .eq('is_active', true)
    .single();

  if (assignError || !assignment) {
    res.status(403).json({ error: 'You are not assigned to this patient.' });
    return;
  }

  // Fetch full profile
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, display_name, gender, date_of_birth, section_or_grade, school_or_org, profile_photo_url, is_active, created_at')
    .eq('id', patientId)
    .single();

  if (profileError || !profile) {
    res.status(404).json({ error: 'Patient profile not found.' });
    return;
  }

  // Fetch last 7 mood logs
  const { data: moodLogs } = await supabaseAdmin
    .from('mood_logs')
    .select('mood, note, logged_at')
    .eq('user_id', patientId)
    .order('logged_at', { ascending: false })
    .limit(7);

  // Fetch last 5 sessions with this counselor
  const { data: sessions } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, status, request_type, scheduled_at, started_at, ended_at, duration_minutes')
    .eq('patient_id', patientId)
    .eq('counselor_id', counselor.id)
    .order('scheduled_at', { ascending: false })
    .limit(5);

  // Fetch last 3 AI reports
  const { data: aiReports } = await supabaseAdmin
    .from('ai_reports')
    .select('id, report_reference_number, risk_level, sentiment, primary_category, self_harm_detected, suicidal_ideation_detected, generated_at')
    .eq('user_id', patientId)
    .order('generated_at', { ascending: false })
    .limit(3);

  res.json({
    patient: {
      ...profile,
      assigned_since: assignment.assigned_at,
    },
    recent_moods: moodLogs || [],
    recent_sessions: sessions || [],
    recent_ai_reports: aiReports || [],
  });
});

export default router;
