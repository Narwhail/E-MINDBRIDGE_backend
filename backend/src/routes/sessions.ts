import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// ─── Helper: Auto-Assign Counselor (PF-10) ──────────────────────────────────

async function autoAssignCounselor(patientId: string): Promise<string> {
  // 1. Read patient's most recent primary_category from ai_reports
  const { data: latestReport } = await supabaseAdmin
    .from('ai_reports')
    .select('primary_category')
    .eq('user_id', patientId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const primaryCategory = latestReport?.primary_category;

  // 2. Query all available counselors
  const { data: counselors, error: counselorError } = await supabaseAdmin
    .from('counselor_profiles')
    .select('id, specialties, max_patient_load')
    .eq('is_available', true);

  if (counselorError) throw counselorError;
  if (!counselors || counselors.length === 0) throw new Error('No available counselors.');

  // 3. Count active patients per counselor
  const { data: activeAssignments } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('counselor_id')
    .eq('is_active', true);

  const activeCounts: Record<string, number> = {};
  counselors.forEach(c => { activeCounts[c.id] = 0; });
  (activeAssignments || []).forEach(a => {
    if (activeCounts[a.counselor_id] !== undefined) activeCounts[a.counselor_id]++;
  });

  // 4. Filter out counselors at max capacity
  const eligible = counselors.filter(c => activeCounts[c.id] < c.max_patient_load);
  if (eligible.length === 0) throw new Error('All counselors are at maximum capacity.');

  // 5. Rank: specialty match first, then fewest patients
  let selectedId = '';
  if (primaryCategory) {
    const specialized = eligible
      .filter(c => c.specialties.includes(primaryCategory))
      .sort((a, b) => activeCounts[a.id] - activeCounts[b.id]);
    if (specialized.length > 0) selectedId = specialized[0].id;
  }

  // Fallback: counselor with fewest patients
  if (!selectedId) {
    const sorted = eligible.sort((a, b) => activeCounts[a.id] - activeCounts[b.id]);
    selectedId = sorted[0].id;
  }

  // 6. Deactivate any existing primary assignment for this patient
  await supabaseAdmin
    .from('counselor_patient_assignments')
    .update({ is_active: false, deactivated_reason: 'auto_reassigned' })
    .eq('patient_id', patientId)
    .eq('is_primary', true)
    .eq('is_active', true);

  // 7. INSERT new assignment
  const { error: insertError } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .insert({
      counselor_id: selectedId,
      patient_id: patientId,
      assignment_type: 'auto',
      is_primary: true,
      is_active: true,
    });

  if (insertError) throw insertError;

  await supabaseAdmin.from('audit_logs').insert({
    action: 'auto_assign_counselor',
    target_table: 'counselor_patient_assignments',
    metadata: { counselor_id: selectedId, patient_id: patientId, category_matched: primaryCategory },
  });

  return selectedId;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * PF-08 + PF-10: Patient requests a proactive session
 * POST /api/sessions/proactive
 * Body: { preferred_date: ISO string, notes?: string }
 */
router.post('/proactive', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const patient = (req as any).user;
  const { preferred_date, notes } = req.body;

  if (!preferred_date) {
    res.status(400).json({ error: 'preferred_date is required (ISO datetime string).' });
    return;
  }

  // Check for existing active primary counselor (PF-08)
  const { data: existingAssignment } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('counselor_id')
    .eq('patient_id', patient.id)
    .eq('is_primary', true)
    .eq('is_active', true)
    .maybeSingle();

  let counselorId: string;

  if (existingAssignment) {
    counselorId = existingAssignment.counselor_id;
  } else {
    // PF-10: Auto-assign a counselor
    try {
      counselorId = await autoAssignCounselor(patient.id);
    } catch (err: any) {
      res.status(503).json({ error: err.message });
      return;
    }
  }

  // INSERT counseling_sessions
  const { data: session, error } = await supabaseAdmin
    .from('counseling_sessions')
    .insert({
      patient_id: patient.id,
      counselor_id: counselorId,
      request_type: 'proactive',
      status: 'scheduled',
      scheduled_at: preferred_date,
      low_bandwidth_mode: true,
      session_notes: notes || null,
    })
    .select('id, scheduled_at')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Notify counselor of the patient request
  await supabaseAdmin.from('notifications').insert({
    recipient_id: counselorId,
    type: 'session_scheduled',
    title: 'Session Request from Patient',
    body: `A patient has requested a counseling session on ${new Date(preferred_date).toLocaleString()}.`,
    related_session_id: session.id,
  });

  // Confirm to patient
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient.id,
    type: 'session_scheduled',
    title: 'Session Request Submitted',
    body: `Your session request has been submitted for ${new Date(preferred_date).toLocaleString()}. Your counselor will confirm shortly.`,
    related_session_id: session.id,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: patient.id,
    action: 'session_scheduled',
    target_table: 'counseling_sessions',
    target_id: session.id,
    metadata: { type: 'proactive', counselor_id: counselorId },
  });

  res.status(201).json({
    message: 'Session requested successfully.',
    session_id: session.id,
    counselor_id: counselorId,
    scheduled_at: session.scheduled_at,
    was_auto_assigned: !existingAssignment,
  });
});

/**
 * PF-07: Counselor schedules a reactive session
 * POST /api/sessions/reactive
 * Body: { patient_id, scheduled_at, evaluation_id?, ai_report_id?, notes? }
 */
router.post('/reactive', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const { patient_id, scheduled_at, evaluation_id, ai_report_id, notes } = req.body;

  if (!patient_id || !scheduled_at) {
    res.status(400).json({ error: 'patient_id and scheduled_at are required.' });
    return;
  }

  // Verify assignment
  const { data: assignment } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('id')
    .eq('counselor_id', counselor.id)
    .eq('patient_id', patient_id)
    .eq('is_active', true)
    .maybeSingle();

  if (!assignment) {
    res.status(403).json({ error: 'You are not assigned to this patient.' });
    return;
  }

  const { data: session, error } = await supabaseAdmin
    .from('counseling_sessions')
    .insert({
      patient_id,
      counselor_id: counselor.id,
      ai_report_id: ai_report_id || null,
      evaluation_id: evaluation_id || null,
      request_type: 'reactive',
      status: 'scheduled',
      scheduled_at,
      low_bandwidth_mode: true,
      session_notes: notes || null,
    })
    .select('id, scheduled_at')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Notify patient
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient_id,
    sender_id: counselor.id,
    type: 'session_scheduled',
    title: 'Session Scheduled',
    body: `Your counselor has scheduled a session for you on ${new Date(scheduled_at).toLocaleString()}.`,
    related_session_id: session.id,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: counselor.id,
    action: 'session_scheduled',
    target_table: 'counseling_sessions',
    target_id: session.id,
    metadata: { type: 'reactive', patient_id },
  });

  res.status(201).json({
    message: 'Reactive session scheduled successfully.',
    session_id: session.id,
    scheduled_at: session.scheduled_at,
  });
});

/**
 * Update session status (active, completed, cancelled, no_show)
 * PATCH /api/sessions/:sessionId/status
 * Body: { status, session_notes?, cancellation_reason? }
 */
router.patch('/:sessionId/status', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { sessionId } = req.params;
  const { status, session_notes, cancellation_reason } = req.body;

  const validStatuses = ['active', 'completed', 'cancelled', 'no_show'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const updates: any = { status };
  if (status === 'active') updates.started_at = new Date().toISOString();
  if (status === 'completed') {
    updates.ended_at = new Date().toISOString();
    updates.session_notes = session_notes || null;
  }
  if (status === 'cancelled') updates.cancellation_reason = cancellation_reason || null;

  const { error } = await supabaseAdmin
    .from('counseling_sessions')
    .update(updates)
    .eq('id', sessionId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ message: `Session status updated to ${status}.` });
});

/**
 * Get sessions for the authenticated user
 * GET /api/sessions
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const column = user.role === 'counselor' ? 'counselor_id' : 'patient_id';

  const { data, error } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, patient_id, counselor_id, status, request_type, scheduled_at, started_at, ended_at, duration_minutes, low_bandwidth_mode, room_url')
    .eq(column, user.id)
    .order('scheduled_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ sessions: data });
});

/**
 * PF-11: Patient requests counselor reassignment
 * POST /api/sessions/reassign
 */
router.post('/reassign', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const patient = (req as any).user;

  // Deactivate current primary assignment
  const { error: deactivateError } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .update({ is_active: false, deactivated_reason: 'patient_requested' })
    .eq('patient_id', patient.id)
    .eq('is_primary', true)
    .eq('is_active', true);

  if (deactivateError) {
    res.status(500).json({ error: deactivateError.message });
    return;
  }

  // Notify all admins
  const { data: admins } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('role', 'admin')
    .eq('is_active', true);

  if (admins && admins.length > 0) {
    await supabaseAdmin.from('notifications').insert(
      admins.map(admin => ({
        recipient_id: admin.id,
        type: 'general',
        title: 'Patient Requested Counselor Reassignment',
        body: 'A patient has requested a different counselor. Please review and assign in the admin dashboard.',
      }))
    );
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: patient.id,
    action: 'counselor_reassignment_requested',
    target_table: 'counselor_patient_assignments',
    metadata: { patient_id: patient.id },
  });

  res.json({ message: 'Reassignment request submitted. An admin will assign your new counselor shortly.' });
});

/**
 * PF-11: Admin manually assigns or auto-assigns a counselor to a patient
 * POST /api/sessions/admin/assign
 * Body: { patient_id, counselor_id? } — if counselor_id omitted, uses auto-assign
 */
router.post('/admin/assign', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const { patient_id, counselor_id } = req.body;

  if (!patient_id) {
    res.status(400).json({ error: 'patient_id is required.' });
    return;
  }

  let assignedCounselorId: string;
  let assignmentType: string;

  if (counselor_id) {
    // Manual assignment
    await supabaseAdmin
      .from('counselor_patient_assignments')
      .update({ is_active: false, deactivated_reason: 'admin_reassigned' })
      .eq('patient_id', patient_id)
      .eq('is_primary', true)
      .eq('is_active', true);

    const { error: insertError } = await supabaseAdmin
      .from('counselor_patient_assignments')
      .insert({
        counselor_id,
        patient_id,
        assignment_type: 'manual',
        is_primary: true,
        is_active: true,
      });

    if (insertError) {
      res.status(500).json({ error: insertError.message });
      return;
    }

    assignedCounselorId = counselor_id;
    assignmentType = 'manual';
  } else {
    // Auto-assign
    try {
      assignedCounselorId = await autoAssignCounselor(patient_id);
      assignmentType = 'auto';
    } catch (err: any) {
      res.status(503).json({ error: err.message });
      return;
    }
  }

  // Notify patient
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient_id,
    type: 'general',
    title: 'New Counselor Assigned',
    body: 'A new counselor has been assigned to you. They will be in touch soon.',
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: admin.id,
    action: 'counselor_reassigned',
    target_table: 'counselor_patient_assignments',
    metadata: { patient_id, counselor_id: assignedCounselorId, assignment_type: assignmentType },
  });

  res.json({
    message: `Counselor assigned successfully (${assignmentType}).`,
    counselor_id: assignedCounselorId,
  });
});

export default router;
