import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * GET /api/dashboard/patient
 * Patient dashboard data: today's mood, wellness quotes, recent reports
 */
router.get('/patient', requireRole('patient'), async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const today = new Date().toISOString().split('T')[0];

  // Today's mood
  const { data: todayMood } = await supabaseAdmin
    .from('mood_logs')
    .select('mood, note, logged_at')
    .eq('user_id', user.id)
    .gte('logged_at', `${today}T00:00:00Z`)
    .lte('logged_at', `${today}T23:59:59Z`)
    .maybeSingle();

  // Last 7 moods for chart
  const { data: moodHistory } = await supabaseAdmin
    .from('mood_logs')
    .select('mood, logged_at')
    .eq('user_id', user.id)
    .order('logged_at', { ascending: false })
    .limit(7);

  // Latest AI report (simplified for patient view — no threat flags per architecture docs)
  const { data: latestReport } = await supabaseAdmin
    .from('ai_reports')
    .select('id, risk_level, sentiment, primary_category, self_help_suggestion, generated_at')
    .eq('user_id', user.id)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Wellness quotes using the DB function
  const { data: quotes } = await supabaseAdmin.rpc('get_quotes_for_patient', {
    p_patient_id: user.id,
    p_limit: 3,
  });

  // Upcoming sessions
  const { data: upcomingSessions } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, scheduled_at, status, counselor_id')
    .eq('patient_id', user.id)
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(3);

  // Unread notification count
  const { count: unreadCount } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', user.id)
    .eq('is_read', false);

  res.json({
    today_mood: todayMood,
    mood_history: moodHistory,
    latest_report: latestReport,
    wellness_quotes: quotes,
    upcoming_sessions: upcomingSessions,
    unread_notifications: unreadCount || 0,
  });
});

/**
 * GET /api/dashboard/counselor
 * Counselor dashboard: macro analytics, patient list with risk flags
 */
router.get('/counselor', requireRole('counselor'), async (req: Request, res: Response): Promise<void> => {
  const counselor = (req as any).user;
  const today = new Date().toISOString().split('T')[0];

  // Today's analytics snapshot
  const { data: snapshot } = await supabaseAdmin
    .from('analytics_snapshots')
    .select('*')
    .eq('counselor_id', counselor.id)
    .eq('snapshot_date', today)
    .maybeSingle();

  // Assigned patients with their latest AI report
  const { data: assignments } = await supabaseAdmin
    .from('counselor_patient_assignments')
    .select(`
      patient_id,
      is_primary,
      assigned_at
    `)
    .eq('counselor_id', counselor.id)
    .eq('is_active', true);

  const patientIds = (assignments || []).map(a => a.patient_id);

  let patientSummaries: any[] = [];
  if (patientIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, display_name, school_or_org')
      .in('id', patientIds);

    const { data: latestReports } = await supabaseAdmin
      .from('ai_reports')
      .select('user_id, risk_level, primary_category, self_harm_detected, suicidal_ideation_detected, generated_at')
      .in('user_id', patientIds)
      .order('generated_at', { ascending: false });

    // Map latest report per patient (first occurrence due to ordering)
    const reportMap: Record<string, any> = {};
    (latestReports || []).forEach(r => {
      if (!reportMap[r.user_id]) reportMap[r.user_id] = r;
    });

    patientSummaries = (profiles || []).map(p => ({
      ...p,
      latest_report: reportMap[p.id] || null,
      assignment: assignments?.find(a => a.patient_id === p.id),
    }));
  }

  // Upcoming sessions
  const { data: upcomingSessions } = await supabaseAdmin
    .from('counseling_sessions')
    .select('id, patient_id, scheduled_at, status, request_type')
    .eq('counselor_id', counselor.id)
    .eq('status', 'scheduled')
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(5);

  // Unread notifications
  const { count: unreadCount } = await supabaseAdmin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', counselor.id)
    .eq('is_read', false);

  res.json({
    analytics_snapshot: snapshot,
    patients: patientSummaries,
    upcoming_sessions: upcomingSessions,
    unread_notifications: unreadCount || 0,
  });
});

/**
 * GET /api/dashboard/admin
 * Admin dashboard: pending report requests, user counts, audit summary
 */
router.get('/admin', requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  // Pending report requests count
  const { count: pendingRequests } = await supabaseAdmin
    .from('report_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  // Total user counts by role
  const { data: userCounts } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('is_active', true);

  const counts = { patient: 0, counselor: 0, admin: 0 };
  (userCounts || []).forEach(u => { counts[u.role as keyof typeof counts]++; });

  // High risk patients in last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: highRiskCount } = await supabaseAdmin
    .from('ai_reports')
    .select('id', { count: 'exact', head: true })
    .in('risk_level', ['high', 'critical'])
    .gte('generated_at', weekAgo);

  // Recent audit log entries
  const { data: recentAuditLogs } = await supabaseAdmin
    .from('audit_logs')
    .select('id, actor_id, action, target_table, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  res.json({
    pending_report_requests: pendingRequests || 0,
    user_counts: counts,
    high_risk_last_7_days: highRiskCount || 0,
    recent_audit_logs: recentAuditLogs,
  });
});

export default router;
