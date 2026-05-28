import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * PF-06: Counselor submits an evaluation on an AI report
 * POST /api/evaluations
 * Body: { ai_report_id, patient_id, clinical_impression, ai_recommendation_status,
 *         modification_reason?, next_step, external_referral_name?, counselor_notes? }
 */
router.post('/', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const {
    ai_report_id,
    patient_id,
    clinical_impression,
    ai_recommendation_status,
    modification_reason,
    next_step,
    external_referral_name,
    counselor_notes,
  } = req.body;

  if (!ai_report_id || !patient_id || !clinical_impression || !ai_recommendation_status || !next_step) {
    res.status(400).json({
      error: 'ai_report_id, patient_id, clinical_impression, ai_recommendation_status, and next_step are required.',
    });
    return;
  }

  const validStatuses = ['approved', 'modified', 'rejected'];
  const validNextSteps = ['schedule_session', 'refer_external', 'monitor_only', 'emergency_referral'];

  if (!validStatuses.includes(ai_recommendation_status)) {
    res.status(400).json({ error: `ai_recommendation_status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  if (!validNextSteps.includes(next_step)) {
    res.status(400).json({ error: `next_step must be one of: ${validNextSteps.join(', ')}` });
    return;
  }

  if (['modified', 'rejected'].includes(ai_recommendation_status) && !modification_reason) {
    res.status(400).json({ error: 'modification_reason is required when status is modified or rejected.' });
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

  // Log the report view in audit
  await supabaseAdmin.from('audit_logs').insert({
    actor_id: counselor.id,
    action: 'viewed_report',
    target_table: 'ai_reports',
    target_id: ai_report_id,
    metadata: { patient_id },
  });

  // INSERT counselor_evaluations
  const { data: evaluation, error } = await supabaseAdmin
    .from('counselor_evaluations')
    .insert({
      ai_report_id,
      counselor_id: counselor.id,
      patient_id,
      clinical_impression,
      ai_recommendation_status,
      modification_reason: modification_reason || null,
      next_step,
      external_referral_name: external_referral_name || null,
      counselor_notes: counselor_notes || null,
    })
    .select('id, next_step')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // PF-06: Handle next_step outcomes
  let nextStepMessage = '';
  if (next_step === 'emergency_referral') {
    // Notify patient immediately
    await supabaseAdmin.from('notifications').insert({
      recipient_id: patient_id,
      sender_id: counselor.id,
      type: 'risk_alert',
      title: '🚨 Emergency Referral',
      body: 'Your counselor has flagged this as an emergency. Please contact emergency services or a crisis hotline immediately.',
      related_report_id: ai_report_id,
    });

    await supabaseAdmin.from('audit_logs').insert({
      actor_id: counselor.id,
      action: 'emergency_referral_triggered',
      target_table: 'counselor_evaluations',
      target_id: evaluation.id,
      metadata: { patient_id, ai_report_id },
    });

    nextStepMessage = 'Emergency referral notification sent to patient.';
  } else if (next_step === 'refer_external') {
    await supabaseAdmin.from('notifications').insert({
      recipient_id: patient_id,
      sender_id: counselor.id,
      type: 'general',
      title: 'External Referral',
      body: `Your counselor has recommended an external referral${external_referral_name ? ` to ${external_referral_name}` : ''}. Please follow up with your counselor for details.`,
      related_report_id: ai_report_id,
    });
    nextStepMessage = 'External referral notification sent to patient.';
  } else if (next_step === 'schedule_session') {
    nextStepMessage = 'Evaluation saved. You can now schedule a reactive session for this patient.';
  } else {
    nextStepMessage = 'Evaluation saved. Patient will be monitored.';
  }

  res.status(201).json({
    message: `Evaluation submitted. ${nextStepMessage}`,
    evaluation_id: evaluation.id,
    next_step,
  });
});

/**
 * GET /api/evaluations/patient/:patientId
 * Get all evaluations for a patient (counselor must be assigned, or admin)
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

  const { data, error } = await supabaseAdmin
    .from('counselor_evaluations')
    .select('*')
    .eq('patient_id', patientId)
    .order('evaluated_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ evaluations: data });
});

export default router;
