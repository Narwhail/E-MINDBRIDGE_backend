import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../supabase';

const router = Router();

/**
 * GET /api/admin/audit
 * Returns recent audit log entries.
 * ?limit=20  ?page=1  ?search=action_name
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const page   = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const from   = (page - 1) * limit;
  const to     = from + limit - 1;
  const search = (req.query.search as string)?.trim() || '';

  let query = supabaseAdmin
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) query = query.ilike('action', `%${search}%`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Enrich with actor name + role from profiles
  const actorIds = [...new Set((data || []).map(l => l.actor_id).filter(Boolean))];
  let actorMap: Record<string, { name: string; role: string }> = {};

  if (actorIds.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role')
      .in('id', actorIds);
    (profiles || []).forEach(p => {
      actorMap[p.id] = { name: p.full_name || p.id, role: p.role || 'unknown' };
    });
  }

  const enriched = (data || []).map(log => ({
    ...log,
    actor_name: actorMap[log.actor_id]?.name || log.actor_id || 'System',
    actor_role: actorMap[log.actor_id]?.role || null,
  }));

  const total_count = count ?? 0;
  res.json({
    logs: enriched,
    pagination: { page, limit, total_count, total_pages: Math.ceil(total_count / limit) },
  });
});

export default router;
