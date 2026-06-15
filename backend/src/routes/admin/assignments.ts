import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../supabase';

const router = Router();

/**
 * GET /api/admin/assignments
 * List all counselor-patient assignments.
 * ?is_active= ?search= ?page= ?limit=
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const page  = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;
  const search = (req.query.search as string)?.trim() || '';

  // If searching by name or UUID
  let profileFilter: string[] | null = null;
  const isUuidFormat = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(search);
  
  if (search) {
    const { data: matched } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .ilike('full_name', `%${search}%`);
    profileFilter = (matched || []).map(p => p.id);
  }

  let query = supabaseAdmin
    .from('counselor_patient_assignments')
    .select(`
      id,
      counselor_id,
      patient_id,
      assignment_type,
      is_primary,
      is_active,
      deactivated_reason,
      assigned_at,
      counselor:profiles!counselor_patient_assignments_counselor_id_fkey (
        full_name
      ),
      patient:profiles!counselor_patient_assignments_patient_id_fkey (
        full_name
      )
    `, { count: 'exact' })
    .order('assigned_at', { ascending: false })
    .range(from, to);

  if (req.query.is_active !== undefined && req.query.is_active !== '') {
    query = query.eq('is_active', req.query.is_active === 'true');
  }
  
  if (search) {
    let orConditions = [];
    if (isUuidFormat) {
      orConditions.push(`patient_id.eq.${search}`);
      orConditions.push(`counselor_id.eq.${search}`);
    }
    if (profileFilter && profileFilter.length > 0) {
      orConditions.push(`patient_id.in.(${profileFilter.join(',')})`);
      orConditions.push(`counselor_id.in.(${profileFilter.join(',')})`);
    }
    
    if (orConditions.length > 0) {
      query = query.or(orConditions.join(','));
    } else {
      // If there's a search but no matches for name and it's not a UUID, return 0 results
      res.json({ assignments: [], pagination: { page, limit, total_count: 0, total_pages: 0 } });
      return;
    }
  }

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Fetch emails from auth.users
  const { data: authData } = await supabaseAdmin.auth.admin.listUsers();
  const assignmentsWithEmails = (data || []).map(a => {
    const pEmail = authData?.users.find(au => au.id === a.patient_id)?.email || '';
    const cEmail = authData?.users.find(au => au.id === a.counselor_id)?.email || '';
    return {
      ...a,
      patient:  { ...(a.patient  as any), email: pEmail },
      counselor: { ...(a.counselor as any), email: cEmail },
    };
  });

  const total_count = count ?? 0;
  res.json({
    assignments: assignmentsWithEmails,
    pagination: { page, limit, total_count, total_pages: Math.ceil(total_count / limit) },
  });
});

/**
 * GET /api/admin/assignments/users
 * Returns lightweight lists of active patients and counselors for dropdowns.
 * Response: { patients: [{id, full_name}], counselors: [{id, full_name, specialties, is_available}] }
 */
router.get('/users', async (_req: Request, res: Response): Promise<void> => {
  const [patientsResult, counselorsResult, authResult] = await Promise.all([
    supabaseAdmin
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'patient')
      .eq('is_active', true)
      .order('full_name'),

    supabaseAdmin
      .from('profiles')
      .select('id, full_name, counselor_profiles(is_available, specialties)')
      .eq('role', 'counselor')
      .eq('is_active', true)
      .order('full_name'),

    supabaseAdmin.auth.admin.listUsers(),
  ]);

  if (patientsResult.error || counselorsResult.error) {
    res.status(500).json({ error: patientsResult.error?.message || counselorsResult.error?.message });
    return;
  }

  const authUsers = authResult.data?.users || [];

  const patients = (patientsResult.data || []).map(p => ({
    id: p.id,
    full_name: p.full_name,
    email: authUsers.find(u => u.id === p.id)?.email || '',
  }));

  const counselors = (counselorsResult.data || []).map(c => ({
    id: c.id,
    full_name: c.full_name,
    email: authUsers.find(u => u.id === c.id)?.email || '',
    is_available: (c.counselor_profiles as any)?.is_available ?? true,
    specialties: (c.counselor_profiles as any)?.specialties || [],
  }));

  res.json({ patients, counselors });
});

/**
 * POST /api/admin/assignments
 * Manually assign a counselor to a patient.
 * Body: { patient_id, counselor_id }
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const { patient_id, counselor_id } = req.body;

  if (!patient_id || !counselor_id) {
    res.status(400).json({ error: 'patient_id and counselor_id are required.' });
    return;
  }

  // Verify counselor exists and is available
  const { data: counselor } = await supabaseAdmin
    .from('counselor_profiles')
    .select('id, is_available, max_patient_load')
    .eq('id', counselor_id)
    .maybeSingle();

  if (!counselor) {
    res.status(404).json({ error: 'Counselor not found or does not have a counselor profile.' });
    return;
  }

  if (!counselor.is_available) {
    res.status(409).json({ error: 'Selected counselor is currently marked as unavailable.' });
    return;
  }

  // Check if patient already has an active primary assignment
  const { data: existingAssignment } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('id, counselor_id')
    .eq('patient_id', patient_id)
    .eq('is_primary', true)
    .eq('is_active', true)
    .maybeSingle();

  if (existingAssignment) {
    // Enforce: patient must have completed at least one session before reassignment
    const { data: completedSession } = await supabaseAdmin
      .from('counseling_sessions')
      .select('id')
      .eq('patient_id', patient_id)
      .eq('counselor_id', existingAssignment.counselor_id)
      .eq('status', 'completed')
      .limit(1)
      .maybeSingle();

    if (!completedSession) {
      res.status(409).json({
        error: 'This patient has not yet completed their first session with their current counselor. Reassignment is not allowed until the first session is done.',
      });
      return;
    }

    // Deactivate the existing primary assignment
    await supabaseAdmin
      .from('counselor_patient_assignments')
      .update({ is_active: false, deactivated_reason: 'admin_reassigned' })
      .eq('patient_id', patient_id)
      .eq('is_primary', true)
      .eq('is_active', true);
  }

  // Create the new manual assignment
  const { data, error } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .insert({
      counselor_id,
      patient_id,
      assignment_type: 'manual',
      is_primary: true,
      is_active: true,
    })
    .select('*')
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Notify patient
  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient_id,
    type: 'general',
    title: 'New Counselor Assigned',
    body: 'A counselor has been assigned to you by an administrator.',
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: admin.id,
    action: 'admin_manual_assignment',
    target_table: 'counselor_patient_assignments',
    target_id: data.id,
    metadata: { patient_id, counselor_id },
  });

  res.status(201).json({ message: 'Counselor manually assigned to patient.', assignment: data });
});

/**
 * PATCH /api/admin/assignments/:assignmentId/deactivate
 * Body: { reason? }
 */
router.patch('/:assignmentId/deactivate', async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const { assignmentId } = req.params;
  const { reason } = req.body;

  const { error } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .update({ is_active: false, deactivated_reason: reason || 'admin_deactivated' })
    .eq('id', assignmentId);

  if (error) { res.status(500).json({ error: error.message }); return; }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: admin.id,
    action: 'admin_deactivated_assignment',
    target_table: 'counselor_patient_assignments',
    target_id: assignmentId,
    metadata: { reason: reason || 'admin_deactivated' },
  });

  res.json({ message: 'Assignment deactivated successfully.' });
});

/**
 * PATCH /api/admin/assignments/:assignmentId/reassign
 * Change the counselor on an existing assignment.
 * Deactivates old, creates new with same patient.
 * Body: { new_counselor_id }
 */
router.patch('/:assignmentId/reassign', async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const { assignmentId } = req.params;
  const { new_counselor_id } = req.body;

  if (!new_counselor_id) {
    res.status(400).json({ error: 'new_counselor_id is required.' });
    return;
  }

  // Get existing assignment to find patient and current counselor
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select('patient_id, counselor_id, is_active')
    .eq('id', assignmentId)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ error: 'Assignment not found.' });
    return;
  }

  // Enforce first-session rule: patient must have completed at least one session
  // with their CURRENT counselor before they can be reassigned
  const { data: completedSession } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id')
    .eq('patient_id', existing.patient_id)
    .eq('counselor_id', existing.counselor_id)
    .eq('status', 'completed')
    .limit(1)
    .maybeSingle();

  if (!completedSession) {
    res.status(409).json({
      error: 'This patient has not yet completed their first session with their current counselor. Reassignment is not allowed until the first session is done.',
    });
    return;
  }

  // Verify new counselor
  const { data: counselor } = await supabaseAdmin
    .from('counselor_profiles')
    .select('id, is_available')
    .eq('id', new_counselor_id)
    .maybeSingle();

  if (!counselor) {
    res.status(404).json({ error: 'Counselor not found or has no counselor profile.' });
    return;
  }
  if (!counselor.is_available) {
    res.status(409).json({ error: 'Selected counselor is currently marked as unavailable.' });
    return;
  }

  const { patient_id } = existing;

  // Deactivate all active assignments for this patient
  await supabaseAdmin
    .from('counselor_patient_assignments')
    .update({ is_active: false, deactivated_reason: 'admin_reassigned' })
    .eq('patient_id', patient_id)
    .eq('is_active', true);

  // Create the new assignment
  const { data: newAssignment, error: insertErr } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .insert({
      counselor_id: new_counselor_id,
      patient_id,
      assignment_type: 'manual',
      is_primary: true,
      is_active: true,
    })
    .select('*')
    .single();

  if (insertErr) { res.status(500).json({ error: insertErr.message }); return; }

  await supabaseAdmin.from('notifications').insert({
    recipient_id: patient_id,
    type: 'general',
    title: 'Counselor Reassigned',
    body: 'Your counselor has been changed by an administrator.',
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: admin.id,
    action: 'admin_reassigned_counselor',
    target_table: 'counselor_patient_assignments',
    target_id: newAssignment.id,
    metadata: { patient_id, old_assignment_id: assignmentId, new_counselor_id },
  });

  res.json({ message: 'Counselor reassigned successfully.', assignment: newAssignment });
});

export default router;
