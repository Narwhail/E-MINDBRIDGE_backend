import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';
import { analyzeSingleJournal } from '../services/gemini';

const router = Router();

router.use(authenticate);

/**
 * PF-03 + PF-04: Submit a journal entry and trigger AI analysis
 * POST /api/journal
 * Body: { content: string, language_code?: string }
 */
router.post('/', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { content, language_code = 'en' } = req.body;

  if (!content || content.trim().length === 0) {
    res.status(400).json({ error: 'Journal content cannot be empty.' });
    return;
  }

  // PF-03: INSERT journal_entries
  const { data: entry, error: entryError } = await supabaseAdmin
    .from('journal_entries')
    .insert({
      user_id: user.id,
      content: content.trim(),
      language_code,
      is_analyzed: false,
      analysis_queued_at: new Date().toISOString(),
    })
    .select('id, user_id, content, language_code, created_at')
    .single();

  if (entryError) {
    res.status(500).json({ error: entryError.message });
    return;
  }

  // Return immediately so the patient isn't waiting for AI
  res.status(201).json({
    message: 'Journal entry saved. AI analysis is processing in the background.',
    entry_id: entry.id,
  });

  // PF-04: Trigger AI analysis asynchronously (fire-and-forget)
  runAIAnalysis(entry.id, user.id, content, language_code).catch(err => {
    console.error(`[AI Analysis] Failed for entry ${entry.id}:`, err.message);
  });
});

/**
 * Get journal entries for the authenticated patient
 * GET /api/journal?limit=20
 */
router.get('/', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const { data, error } = await supabaseAdmin
    .from('journal_entries')
    .select('id, language_code, is_analyzed, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Note: raw content is not returned here intentionally (counselors can't see it, and the
  // patient-facing summary is the AI report per the architecture docs)
  res.json({ entries: data });
});

/**
 * PF-04 Implementation: Background AI analysis logic
 */
async function runAIAnalysis(
  entryId: string,
  userId: string,
  content: string,
  languageCode: string
): Promise<void> {
  // Fetch last 7 mood logs
  const { data: moodLogs } = await supabaseAdmin
    .from('mood_logs')
    .select('mood, logged_at')
    .eq('user_id', userId)
    .order('logged_at', { ascending: false })
    .limit(7);

  // Call Gemini (or simulated response)
  const analysis = await analyzeSingleJournal({
    journalContent: content,
    languageCode,
    moodHistory: moodLogs || [],
  });

  // INSERT ai_reports — trigger auto-generates report_reference_number
  const { data: report, error: reportError } = await supabaseAdmin
    .from('ai_reports')
    .insert({
      journal_entry_id: entryId,
      user_id: userId,
      platform_context: 'Web App',
      ...analysis,
    })
    .select('id, risk_level, self_harm_detected, suicidal_ideation_detected')
    .single();

  if (reportError) throw reportError;

  // UPDATE journal_entries.is_analyzed = TRUE
  await supabaseAdmin
    .from('journal_entries')
    .update({ is_analyzed: true })
    .eq('id', entryId);

  // INSERT audit_logs
  await supabaseAdmin.from('audit_logs').insert({
    action: 'ai_report_generated',
    target_table: 'ai_reports',
    target_id: report.id,
    metadata: {
      trigger: 'journal_submission',
      ai_model: analysis.ai_model_version,
      risk_level: analysis.risk_level,
    },
  });

  // Notify assigned counselors if high risk or threat detected
  const isHighRisk = report.risk_level === 'high' || report.risk_level === 'critical';
  const hasThreat =
    report.self_harm_detected === 'detected' ||
    report.suicidal_ideation_detected === 'detected';

  if (isHighRisk || hasThreat) {
    const { data: assignments } = await supabaseAdmin
      .from('counselor_patient_assignments')
      .select('counselor_id')
      .eq('patient_id', userId)
      .eq('is_active', true);

    if (assignments && assignments.length > 0) {
      const notifications = assignments.map(a => ({
        recipient_id: a.counselor_id,
        type: 'risk_alert',
        title: hasThreat ? '⚠️ Threat Detected in Journal Analysis' : '⚠️ High Risk Alert',
        body: `A recent journal entry analysis has flagged ${hasThreat ? 'potential self-harm or suicidal ideation' : 'high risk level'}. Immediate review recommended.`,
        related_report_id: report.id,
      }));
      await supabaseAdmin.from('notifications').insert(notifications);
    }
  }
}

export default router;
