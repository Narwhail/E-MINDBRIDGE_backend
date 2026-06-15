import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';

// ─── Jitsi Helper ─────────────────────────────────────────────────────────────

/**
 * Generates a unique, deterministic Jitsi Meet room URL for a session.
 * Uses the public meet.jit.si server (configurable via JITSI_DOMAIN env var).
 */
function generateRoomUrl(): string {
  const domain = process.env.JITSI_DOMAIN || 'meet.jit.si';
  const roomName = `EMindBridge-${uuidv4()}`;
  return `https://${domain}/${roomName}`;
}

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

  // INSERT counseling_sessions — status is pending_confirmation until counselor accepts
  // Room URL is NOT generated yet; it will be created when the counselor confirms.
  const { data: session, error } = await supabaseAdmin
    .from('counseling_sessions')
    .insert({
      patient_id: patient.id,
      counselor_id: counselorId,
      request_type: 'proactive',
      status: 'pending_confirmation',
      scheduled_at: preferred_date,
      low_bandwidth_mode: true,
      room_url: null,
      session_notes: notes || null,
    })
    .select('id, scheduled_at')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Notify counselor of the patient request — they must confirm or decline
  await supabaseAdmin.from('notifications').insert({
    recipient_id: counselorId,
    type: 'session_scheduled',
    title: '📅 Session Request — Confirmation Required',
    body: `A patient has requested a counseling session on ${new Date(preferred_date).toLocaleString()}. Please confirm or decline in your dashboard.`,
    related_session_id: session.id,
  });

  // Confirm to patient that the request was submitted and awaiting counselor
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient.id,
    type: 'session_scheduled',
    title: 'Session Request Submitted',
    body: `Your session request for ${new Date(preferred_date).toLocaleString()} has been submitted. You'll be notified once your counselor confirms.`,
    related_session_id: session.id,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: patient.id,
    action: 'session_requested',
    target_table: 'counseling_sessions',
    target_id: session.id,
    metadata: { type: 'proactive', counselor_id: counselorId },
  });

  res.status(201).json({
    message: 'Session requested successfully. Awaiting counselor confirmation.',
    session_id: session.id,
    counselor_id: counselorId,
    scheduled_at: session.scheduled_at,
    status: 'pending_confirmation',
    was_auto_assigned: !existingAssignment,
  });
});

/**
 * PF-09: Counselor confirms or declines a pending session request
 * PATCH /api/sessions/:sessionId/confirm
 * Body: { action: 'accept' | 'decline', decline_reason?: string }
 */
router.patch('/:sessionId/confirm', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const { sessionId } = req.params;
  const { action, decline_reason } = req.body;

  if (!['accept', 'decline'].includes(action)) {
    res.status(400).json({ error: 'action must be "accept" or "decline".' });
    return;
  }

  // Fetch the session and verify it belongs to this counselor and is pending
  const { data: session, error: fetchErr } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, patient_id, counselor_id, status, scheduled_at')
    .eq('id', sessionId)
    .eq('counselor_id', counselor.id)
    .single();

  if (fetchErr || !session) {
    res.status(404).json({ error: 'Session not found or does not belong to you.' });
    return;
  }

  if (session.status !== 'pending_confirmation') {
    res.status(409).json({ error: `Session is already in status "${session.status}" and cannot be confirmed or declined.` });
    return;
  }

  if (action === 'decline') {
    await supabaseAdmin
      .from('counseling_sessions')
      .update({ status: 'cancelled', cancellation_reason: decline_reason || 'Counselor declined the session.' })
      .eq('id', sessionId);

    await supabaseAdmin.from('notifications').insert({
      recipient_id: session.patient_id,
      sender_id: counselor.id,
      type: 'general',
      title: '❌ Session Request Declined',
      body: `Your session request for ${new Date(session.scheduled_at).toLocaleString()} was declined by your counselor${decline_reason ? `: ${decline_reason}` : '. Please request another time.'}.`,
      related_session_id: sessionId,
    });

    await supabaseAdmin.from('audit_logs').insert({
      actor_id: counselor.id,
      action: 'session_declined',
      target_table: 'counseling_sessions',
      target_id: sessionId,
      metadata: { patient_id: session.patient_id, reason: decline_reason || null },
    });

    res.json({ message: 'Session declined. Patient has been notified.' });
    return;
  }

  // ACCEPT: generate the Jitsi room URL now and mark as scheduled
  const roomUrl = generateRoomUrl();

  await supabaseAdmin
    .from('counseling_sessions')
    .update({ status: 'scheduled', room_url: roomUrl })
    .eq('id', sessionId);

  // Notify patient with the confirmed date and room link
  await supabaseAdmin.from('notifications').insert({
    recipient_id: session.patient_id,
    sender_id: counselor.id,
    type: 'session_scheduled',
    title: '✅ Session Confirmed!',
    body: `Your counseling session has been confirmed for ${new Date(session.scheduled_at).toLocaleString()}. Join here: ${roomUrl}`,
    related_session_id: sessionId,
  });

  // Also notify counselor themselves as a reminder
  await supabaseAdmin.from('notifications').insert({
    recipient_id: counselor.id,
    type: 'session_scheduled',
    title: '✅ You confirmed a session',
    body: `Session confirmed for ${new Date(session.scheduled_at).toLocaleString()}. Room: ${roomUrl}`,
    related_session_id: sessionId,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: counselor.id,
    action: 'session_confirmed',
    target_table: 'counseling_sessions',
    target_id: sessionId,
    metadata: { patient_id: session.patient_id, room_url: roomUrl },
  });

  res.json({
    message: 'Session confirmed. Jitsi room created and patient notified.',
    session_id: sessionId,
    scheduled_at: session.scheduled_at,
    room_url: roomUrl,
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

  const roomUrl = generateRoomUrl();
  const { data: session, error } = await supabaseAdmin
    .from('counseling_sessions')
    .insert({
      patient_id,
      counselor_id: counselor.id,
      ai_report_id: ai_report_id || null,
      evaluation_id: evaluation_id || null,
      request_type: 'reactive',
      status: 'pending_patient_confirmation',
      scheduled_at,
      low_bandwidth_mode: true,
      room_url: null,
      session_notes: notes || null,
    })
    .select('id, scheduled_at')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Notify patient — they must accept or decline
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient_id,
    sender_id: counselor.id,
    type: 'session_scheduled',
    title: '📅 Session Proposed — Your Confirmation Needed',
    body: `Your counselor has proposed a counseling session for ${new Date(scheduled_at).toLocaleString()}. Please confirm or decline in your dashboard.`,
    related_session_id: session.id,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: counselor.id,
    action: 'session_proposed',
    target_table: 'counseling_sessions',
    target_id: session.id,
    metadata: { type: 'reactive', patient_id },
  });

  res.status(201).json({
    message: 'Reactive session proposed. Awaiting patient confirmation.',
    session_id: session.id,
    scheduled_at: session.scheduled_at,
    status: 'pending_patient_confirmation',
  });
});

/**
 * PF-09: Patient confirms or declines a counselor-proposed reactive session
 * PATCH /api/sessions/:sessionId/patient-confirm
 * Body: { action: 'accept' | 'decline', decline_reason?: string }
 */
router.patch('/:sessionId/patient-confirm', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const patient = (req as any).user;
  const { sessionId } = req.params;
  const { action, decline_reason } = req.body;

  if (!['accept', 'decline'].includes(action)) {
    res.status(400).json({ error: 'action must be "accept" or "decline".' });
    return;
  }

  // Fetch the session and verify it belongs to this patient and is pending patient confirmation
  const { data: session, error: fetchErr } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, patient_id, counselor_id, status, scheduled_at')
    .eq('id', sessionId)
    .eq('patient_id', patient.id)
    .single();

  if (fetchErr || !session) {
    res.status(404).json({ error: 'Session not found or does not belong to you.' });
    return;
  }

  if (session.status !== 'pending_patient_confirmation') {
    res.status(409).json({ error: `Session is already in status "${session.status}" and cannot be confirmed or declined.` });
    return;
  }

  if (action === 'decline') {
    await supabaseAdmin
      .from('counseling_sessions')
      .update({ status: 'cancelled', cancellation_reason: decline_reason || 'Patient declined the proposed session.' })
      .eq('id', sessionId);

    await supabaseAdmin.from('notifications').insert({
      recipient_id: session.counselor_id,
      sender_id: patient.id,
      type: 'general',
      title: '❌ Proposed Session Declined',
      body: `Your patient declined the session proposed for ${new Date(session.scheduled_at).toLocaleString()}${decline_reason ? `: ${decline_reason}` : '. Please propose another time.'}.`,
      related_session_id: sessionId,
    });

    await supabaseAdmin.from('audit_logs').insert({
      actor_id: patient.id,
      action: 'session_declined',
      target_table: 'counseling_sessions',
      target_id: sessionId,
      metadata: { counselor_id: session.counselor_id, reason: decline_reason || null },
    });

    res.json({ message: 'Session declined. Your counselor has been notified.' });
    return;
  }

  // ACCEPT: generate the Jitsi room URL now and mark as scheduled
  const roomUrl = generateRoomUrl();

  await supabaseAdmin
    .from('counseling_sessions')
    .update({ status: 'scheduled', room_url: roomUrl })
    .eq('id', sessionId);

  // Notify counselor the patient accepted
  await supabaseAdmin.from('notifications').insert({
    recipient_id: session.counselor_id,
    sender_id: patient.id,
    type: 'session_scheduled',
    title: '✅ Patient Confirmed the Session',
    body: `Your patient has confirmed the session on ${new Date(session.scheduled_at).toLocaleString()}. Join here: ${roomUrl}`,
    related_session_id: sessionId,
  });

  // Confirm to patient with the link
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient.id,
    type: 'session_scheduled',
    title: '✅ Session Confirmed!',
    body: `You've confirmed your counseling session on ${new Date(session.scheduled_at).toLocaleString()}. Join here: ${roomUrl}`,
    related_session_id: sessionId,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: patient.id,
    action: 'session_confirmed',
    target_table: 'counseling_sessions',
    target_id: sessionId,
    metadata: { counselor_id: session.counselor_id, room_url: roomUrl },
  });

  res.json({
    message: 'Session confirmed. Jitsi room created and counselor notified.',
    session_id: sessionId,
    scheduled_at: session.scheduled_at,
    room_url: roomUrl,
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
