import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';
import { analyzeLongitudinal } from '../services/gemini';

const router = Router();

router.use(authenticate);

/**
 * PF-05: Counselor submits an on-request AI report
 * POST /api/reports/request
 * Body: { patient_id, date_range_start, date_range_end, reason }
 */
router.post('/request', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const { patient_id, date_range_start, date_range_end, reason } = req.body;

  if (!patient_id || !date_range_start || !date_range_end || !reason) {
    res.status(400).json({ error: 'patient_id, date_range_start, date_range_end, and reason are required.' });
    return;
  }

  if (new Date(date_range_end) < new Date(date_range_start)) {
    res.status(400).json({ error: 'date_range_end must be on or after date_range_start.' });
    return;
  }

  // Verify the counselor is assigned to this patient
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

  // INSERT report_requests
  const { data: request, error } = await supabaseAdmin
    .from('report_requests')
    .insert({
      requested_by: counselor.id,
      patient_id,
      date_range_start,
      date_range_end,
      reason,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
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
        title: 'New AI Report Request Pending Review',
        body: `A counselor has submitted a report request for a patient. Please review in the admin dashboard.`,
      }))
    );
  }

  res.status(201).json({
    message: 'Report request submitted successfully. Awaiting admin approval.',
    request_id: request.id,
  });
});

/**
 * Get all report requests for the authenticated counselor
 * GET /api/reports/requests
 */
router.get('/requests', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;

  const { data, error } = await supabaseAdmin
    .from('report_requests')
    .select('id, patient_id, date_range_start, date_range_end, reason, status, rejection_reason, requested_at, reviewed_at, fulfilled_at, fulfilled_report_id')
    .eq('requested_by', counselor.id)
    .order('requested_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ requests: data });
});

/**
 * PF-05: Admin: Get all pending report requests
 * GET /api/reports/admin/pending
 */
router.get('/admin/pending', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from('report_requests')
    .select(`
      id,
      reason,
      date_range_start,
      date_range_end,
      status,
      requested_at,
      requested_by,
      patient_id
    `)
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ requests: data });
});

/**
 * PF-05: Admin: Approve or reject a report request
 * PATCH /api/reports/admin/:requestId
 * Body: { action: 'approve' | 'reject', rejection_reason?: string }
 */
router.patch('/admin/:requestId', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const admin = (req as any).user;
  const { requestId } = req.params;
  const { action, rejection_reason } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    res.status(400).json({ error: 'action must be "approve" or "reject".' });
    return;
  }

  if (action === 'reject' && !rejection_reason) {
    res.status(400).json({ error: 'rejection_reason is required when rejecting.' });
    return;
  }

  // Fetch the request record
  const { data: requestRecord, error: fetchError } = await supabaseAdmin
    .from('report_requests')
    .select('*')
    .eq('id', requestId)
    .eq('status', 'pending')
    .single();

  if (fetchError || !requestRecord) {
    res.status(404).json({ error: 'Report request not found or not in pending state.' });
    return;
  }

  if (action === 'reject') {
    await supabaseAdmin
      .from('report_requests')
      .update({
        status: 'rejected',
        rejection_reason,
        reviewed_by: admin.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', requestId);

    // Notify counselor of rejection
    await supabaseAdmin.from('notifications').insert({
      recipient_id: requestRecord.requested_by,
      type: 'general',
      title: 'Report Request Rejected',
      body: `Your report request has been rejected. Reason: ${rejection_reason}`,
    });

    await supabaseAdmin.from('audit_logs').insert({
      actor_id: admin.id,
      action: 'report_request_rejected',
      target_table: 'report_requests',
      target_id: requestId,
      metadata: { rejection_reason },
    });

    res.json({ message: 'Report request rejected.' });
    return;
  }

  // APPROVE: Update status then fire longitudinal AI analysis
  await supabaseAdmin
    .from('report_requests')
    .update({
      status: 'approved',
      reviewed_by: admin.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  res.json({ message: 'Report request approved. AI analysis is processing.' });

  // PF-05: Fire longitudinal analysis asynchronously
  fulfillReportRequest(requestId, requestRecord, admin.id).catch(err => {
    console.error(`[Fulfill Report] Failed for request ${requestId}:`, err.message);
  });
});

/**
 * Get AI reports for a patient (counselor must be assigned)
 * GET /api/reports/patient/:patientId
 */
router.get('/patient/:patientId', requireRole('counselor', 'admin'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { patientId } = req.params;

  if (user.role === 'counselor') {
    const { data: assignment } = await supabaseAdmin
      .from('counselor_patient_assignments')
      .select('id')
      .eq('counselor_id', user.id)
      .eq('patient_id', patientId)
      .eq('is_active', true)
      .maybeSingle();

    if (!assignment) {
      res.status(403).json({ error: 'You are not assigned to this patient.' });
      return;
    }
  }

  // Log report view in audit
  await supabaseAdmin.from('audit_logs').insert({
    actor_id: user.id,
    action: 'viewed_report',
    target_table: 'ai_reports',
    metadata: { patient_id: patientId },
  });

  const { data, error } = await supabaseAdmin
    .from('ai_reports')
    .select('*')
    .eq('user_id', patientId)
    .order('generated_at', { ascending: false })
    .limit(20);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ reports: data });
});

/**
 * PF-05 Implementation: Longitudinal AI analysis
 */
async function fulfillReportRequest(
  requestId: string,
  requestRecord: any,
  adminId: string
): Promise<void> {
  const { patient_id, date_range_start, date_range_end, requested_by } = requestRecord;

  // Fetch all journal entries in date range
  const { data: journalEntries } = await supabaseAdmin
    .from('journal_entries')
    .select('content, created_at, language_code')
    .eq('user_id', patient_id)
    .gte('created_at', `${date_range_start}T00:00:00Z`)
    .lte('created_at', `${date_range_end}T23:59:59Z`)
    .order('created_at', { ascending: true });

  // Fetch all mood logs in date range
  const { data: moodLogs } = await supabaseAdmin
    .from('mood_logs')
    .select('mood, logged_at')
    .eq('user_id', patient_id)
    .gte('logged_at', `${date_range_start}T00:00:00Z`)
    .lte('logged_at', `${date_range_end}T23:59:59Z`)
    .order('logged_at', { ascending: true });

  // Run longitudinal AI analysis
  const analysis = await analyzeLongitudinal({
    journalEntries: journalEntries || [],
    moodHistory: moodLogs || [],
    dateRangeStart: date_range_start,
    dateRangeEnd: date_range_end,
  });

  // INSERT ai_reports
  const { data: report } = await supabaseAdmin
    .from('ai_reports')
    .insert({
      user_id: patient_id,
      analysis_period_start: date_range_start,
      analysis_period_end: date_range_end,
      platform_context: 'Web App',
      ...analysis,
    })
    .select('id')
    .single();

  // UPDATE report_requests to 'fulfilled'
  await supabaseAdmin
    .from('report_requests')
    .update({
      status: 'fulfilled',
      fulfilled_report_id: report?.id,
      fulfilled_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  // Notify the requesting counselor
  await supabaseAdmin.from('notifications').insert({
    recipient_id: requested_by,
    type: 'general',
    title: 'AI Report Ready',
    body: 'Your requested AI MindProfile report has been generated and is ready for review.',
    related_report_id: report?.id,
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: adminId,
    action: 'report_request_fulfilled',
    target_table: 'report_requests',
    target_id: requestId,
    metadata: { report_id: report?.id, ai_model: analysis.ai_model_version },
  });
}

export default router;
