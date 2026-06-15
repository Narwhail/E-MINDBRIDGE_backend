import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * PF-03: Submit a journal entry
 * POST /api/journal
 * Body: { content: string, language_code?: string }
 *
 * Stores the journal entry only. AI analysis is NOT triggered automatically.
 * Analysis only occurs when a counselor submits a report request (POST /api/reports/request)
 * and the admin approves it (PATCH /api/reports/admin/:requestId).
 */
router.post('/', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { content, language_code = 'en' } = req.body;

  if (!content || content.trim().length === 0) {
    res.status(400).json({ error: 'Journal content cannot be empty.' });
    return;
  }

  // PF-03: INSERT journal_entries — stored but not analyzed yet
  const { data: entry, error: entryError } = await supabaseAdmin
    .from('journal_entries')
    .insert({
      user_id: user.id,
      content: content.trim(),
      language_code,
      is_analyzed: false,
    })
    .select('id, user_id, language_code, created_at')
    .single();

  if (entryError) {
    res.status(500).json({ error: entryError.message });
    return;
  }

  res.status(201).json({
    message: 'Journal entry saved successfully.',
    entry_id: entry.id,
  });
});

/**
 * Get journal entries for the authenticated patient
 * GET /api/journal?limit=20
 *
 * Note: Raw journal content is intentionally not returned here.
 * Counselors access patient data only through approved AI reports.
 */
router.get('/', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const { data, error } = await supabaseAdmin
    .from('journal_entries')
    .select('id, content, language_code, is_analyzed, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ entries: data });
});

export default router;
