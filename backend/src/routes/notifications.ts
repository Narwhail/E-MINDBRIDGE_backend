import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const unreadOnly = req.query.unread === 'true';

  let query = supabaseAdmin
    .from('notifications')
    .select('id, type, title, body, is_read, read_at, created_at, related_session_id, related_report_id')
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.eq('is_read', false);

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ notifications: data });
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a notification as read
 */
router.patch('/:id/read', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const { id } = req.params;

  const { error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', id)
    .eq('recipient_id', user.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ message: 'Notification marked as read.' });
});

/**
 * PATCH /api/notifications/read-all
 * Mark all notifications as read for the authenticated user
 */
router.patch('/read-all', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;

  const { error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('recipient_id', user.id)
    .eq('is_read', false);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ message: 'All notifications marked as read.' });
});

export default router;
