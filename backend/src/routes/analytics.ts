import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * PF-09: Generate analytics snapshots for all counselors
 * POST /api/analytics/snapshot
 * Typically called by a cron job or admin trigger.
 */
router.post('/snapshot', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  const today = new Date().toISOString().split('T')[0];

  const { data: counselors, error: counselorError } = await supabaseAdmin
    .from('counselor_profiles')
    .select('id');

  if (counselorError) {
    res.status(500).json({ error: counselorError.message });
    return;
  }

  if (!counselors || counselors.length === 0) {
    res.json({ message: 'No counselors found.', snapshots_generated: 0 });
    return;
  }

  let snapshotsGenerated = 0;

  for (const counselor of counselors) {
    const { data: assignments } = await supabaseAdmin
      .from('counselor_patient_assignments')
      .select('patient_id')
      .eq('counselor_id', counselor.id)
      .eq('is_active', true);

    if (!assignments || assignments.length === 0) continue;

    const patientIds = assignments.map(a => a.patient_id);
    const totalUsers = patientIds.length;

    // Mood data for today
    const { data: moods } = await supabaseAdmin
      .from('mood_logs')
      .select('mood')
      .in('user_id', patientIds)
      .gte('logged_at', `${today}T00:00:00Z`)
      .lte('logged_at', `${today}T23:59:59Z`);

    const moodCounts = { great: 0, good: 0, okay: 0, low: 0, struggling: 0 };
    let totalMoods = 0;
    (moods || []).forEach(log => {
      if (log.mood in moodCounts) {
        moodCounts[log.mood as keyof typeof moodCounts]++;
        totalMoods++;
      }
    });

    const pct = (count: number) => totalMoods > 0 ? parseFloat(((count / totalMoods) * 100).toFixed(2)) : 0;

    // AI reports this week for risk and category
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: reports } = await supabaseAdmin
      .from('ai_reports')
      .select('risk_level, primary_category')
      .in('user_id', patientIds)
      .gte('generated_at', `${weekAgo}T00:00:00Z`);

    const riskOrder: Record<string, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
    let globalRisk = 'low';
    let highRiskCount = 0;
    const categoryCounts: Record<string, number> = {};

    (reports || []).forEach(r => {
      if ((riskOrder[r.risk_level] ?? 0) > (riskOrder[globalRisk] ?? 0)) globalRisk = r.risk_level;
      if (['high', 'critical'].includes(r.risk_level)) highRiskCount++;
      categoryCounts[r.primary_category] = (categoryCounts[r.primary_category] || 0) + 1;
    });

    const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    await supabaseAdmin
      .from('analytics_snapshots')
      .upsert({
        snapshot_date: today,
        counselor_id: counselor.id,
        total_users: totalUsers,
        mood_great_pct: pct(moodCounts.great),
        mood_good_pct: pct(moodCounts.good),
        mood_okay_pct: pct(moodCounts.okay),
        mood_low_pct: pct(moodCounts.low),
        mood_struggling_pct: pct(moodCounts.struggling),
        global_risk_level: globalRisk,
        high_risk_count: highRiskCount,
        top_category: topCategory,
        trend_notes: `Auto-generated on ${today}.`,
      }, { onConflict: 'snapshot_date,counselor_id' });

    snapshotsGenerated++;
  }

  res.json({ message: 'Analytics snapshots generated.', snapshots_generated: snapshotsGenerated });
});

/**
 * GET /api/analytics/snapshot/me
 * Get today's snapshot for the authenticated counselor
 */
router.get('/snapshot/me', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('analytics_snapshots')
    .select('*')
    .eq('counselor_id', counselor.id)
    .eq('snapshot_date', today)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ snapshot: data });
});

/**
 * GET /api/analytics/snapshot/history
 * Get last N snapshots for the authenticated counselor
 */
router.get('/snapshot/history', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 90);

  const { data, error } = await supabaseAdmin
    .from('analytics_snapshots')
    .select('*')
    .eq('counselor_id', counselor.id)
    .order('snapshot_date', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ snapshots: data });
});

export default router;
