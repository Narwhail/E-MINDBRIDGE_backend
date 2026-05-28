import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';

/**
 * Middleware to validate a JWT from the Authorization header.
 * Attaches the decoded user to req.user.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  // Fetch role from profiles table
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    res.status(401).json({ error: 'User profile not found.' });
    return;
  }

  if (!profile.is_active) {
    res.status(403).json({ error: 'Account is deactivated.' });
    return;
  }

  (req as any).user = { id: user.id, role: profile.role };
  next();
}

/**
 * Middleware factory to restrict access to specific roles.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}.` });
      return;
    }
    next();
  };
}
