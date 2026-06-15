import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../supabase';

const router = Router();

/**
 * GET /api/admin/quotes
 * List wellness quotes. ?search= ?page= ?limit=
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const page   = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const from   = (page - 1) * limit;
  const to     = from + limit - 1;
  const search = (req.query.search as string)?.trim() || '';

  let query = supabaseAdmin
    .from('wellness_quotes')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) query = query.ilike('content', `%${search}%`);

  const { data, error, count } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }

  const total_count = count ?? 0;
  res.json({
    quotes: data,
    pagination: { page, limit, total_count, total_pages: Math.ceil(total_count / limit) },
  });
});

/**
 * GET /api/admin/quotes/:quoteId
 * Fetch a single quote.
 */
router.get('/:quoteId', async (req: Request, res: Response): Promise<void> => {
  const { quoteId } = req.params;

  const { data, error } = await supabaseAdmin
    .from('wellness_quotes')
    .select('*')
    .eq('id', quoteId)
    .single();

  if (error) {
    res.status(404).json({ error: 'Quote not found.' });
    return;
  }

  res.json({ quote: data });
});

/**
 * POST /api/admin/quotes
 * Create a new wellness quote.
 * Body: { content, author?, mood_targets, tags, is_active? }
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { content, author, mood_targets, tags, is_active } = req.body;

  if (!content || !mood_targets || !tags) {
    res.status(400).json({ error: 'content, mood_targets, and tags are required.' });
    return;
  }

  if (!Array.isArray(mood_targets) || !Array.isArray(tags)) {
    res.status(400).json({ error: 'mood_targets and tags must be arrays.' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('wellness_quotes')
    .insert({
      content,
      author: author || null,
      mood_targets,
      tags,
      is_active: is_active !== undefined ? is_active : true,
    })
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: (req as any).user.id,
    action: 'admin_created_quote',
    target_table: 'wellness_quotes',
    target_id: data.id,
    metadata: { content: content.substring(0, 80) },
  });

  res.status(201).json({ message: 'Quote created successfully.', quote: data });
});

/**
 * PATCH /api/admin/quotes/:quoteId
 * Update an existing wellness quote.
 * Body: any subset of { content, author, mood_targets, tags, is_active }
 */
router.patch('/:quoteId', async (req: Request, res: Response): Promise<void> => {
  const { quoteId } = req.params;
  const { content, author, mood_targets, tags, is_active } = req.body;

  const updates: Record<string, any> = {};
  if (content !== undefined) updates.content = content;
  if (author !== undefined) updates.author = author;
  if (mood_targets !== undefined) updates.mood_targets = mood_targets;
  if (tags !== undefined) updates.tags = tags;
  if (is_active !== undefined) updates.is_active = is_active;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'At least one field must be provided to update.' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('wellness_quotes')
    .update(updates)
    .eq('id', quoteId)
    .select('*')
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ message: 'Quote updated successfully.', quote: data });
});

/**
 * DELETE /api/admin/quotes/:quoteId
 * Permanently delete a wellness quote.
 */
router.delete('/:quoteId', async (req: Request, res: Response): Promise<void> => {
  const { quoteId } = req.params;

  const { error } = await supabaseAdmin
    .from('wellness_quotes')
    .delete()
    .eq('id', quoteId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: (req as any).user.id,
    action: 'admin_deleted_quote',
    target_table: 'wellness_quotes',
    target_id: quoteId,
    metadata: {},
  });

  res.json({ message: 'Quote deleted successfully.' });
});

export default router;
