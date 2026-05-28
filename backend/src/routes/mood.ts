import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// All mood routes require authentication
router.use(authenticate);

/**
 * PF-02: Get today's mood log for the authenticated patient
 * GET /api/mood/today
 */
router.get('/today', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('mood_logs')
    .select('*')
    .eq('user_id', user.id)
    .gte('logged_at', `${today}T00:00:00Z`)
    .lte('logged_at', `${today}T23:59:59Z`)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ logged_today: !!data, entry: data });
});

/**
 * PF-02: Get mood history for the authenticated patient
 * GET /api/mood/history?limit=30
 */
router.get('/history', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 90);

  const { data, error } = await supabaseAdmin
    .from('mood_logs')
    .select('id, mood, note, logged_at')
    .eq('user_id', user.id)
    .order('logged_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ moods: data });
});

/**
 * PF-02: Submit or update daily mood log
 * POST /api/mood
 * Body: { mood: 'great'|'good'|'okay'|'low'|'struggling', note?: string }
 */
router.post('/', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { mood, note } = req.body;

  const validMoods = ['great', 'good', 'okay', 'low', 'struggling'];
  if (!mood || !validMoods.includes(mood)) {
    res.status(400).json({ error: `mood must be one of: ${validMoods.join(', ')}` });
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  // Check if already logged today
  const { data: existing } = await supabaseAdmin
    .from('mood_logs')
    .select('id')
    .eq('user_id', user.id)
    .gte('logged_at', `${today}T00:00:00Z`)
    .lte('logged_at', `${today}T23:59:59Z`)
    .maybeSingle();

  if (existing) {
    // Update existing entry
    const { data, error } = await supabaseAdmin
      .from('mood_logs')
      .update({ mood, note: note || null })
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: "Today's mood updated.", entry: data });
    return;
  }

  // Insert new entry
  const { data, error } = await supabaseAdmin
    .from('mood_logs')
    .insert({ user_id: user.id, mood, note: note || null })
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json({ message: 'Mood logged successfully.', entry: data });
});

export default router;
