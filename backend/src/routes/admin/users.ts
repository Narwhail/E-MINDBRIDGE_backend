import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../supabase';

const router = Router();

// All routes in this file are already guarded by authenticate + requireRole('admin')
// at the index.ts mount point.

/**
 * GET /api/admin/users
 * List all user profiles.
 * Supports query params: ?role=patient|counselor|admin  ?is_active=true|false
 * ?page=1 &limit=20 &search=name
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from('profiles')
    .select(`
      id,
      full_name,
      role,
      is_active,
      is_anonymous,
      school_or_org,
      created_at,
      counselor_profiles (
        specialties,
        is_available,
        max_patient_load,
        license_number,
        years_of_experience
      )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (req.query.role) {
    query = query.eq('role', req.query.role as string);
  }
  if (req.query.is_active !== undefined) {
    query = query.eq('is_active', req.query.is_active === 'true');
  }
  if (req.query.search) {
    const searchVal = req.query.search as string;
    const isUuidFormat = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(searchVal);
    if (isUuidFormat) {
      query = query.eq('id', searchVal);
    } else {
      query = query.ilike('full_name', `%${searchVal}%`);
    }
  }

  const { data, count, error } = await query;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Fetch emails from auth.users (since profiles doesn't have an email column)
  const { data: authData } = await supabaseAdmin.auth.admin.listUsers();
  const usersWithEmails = (data || []).map(u => {
    const authUser = authData?.users.find(au => au.id === u.id);
    return { ...u, email: authUser?.email || '' };
  });

  res.json({ users: usersWithEmails, count });
});

/**
 * GET /api/admin/users/list
 * Returns a lightweight list of users (id and name) for dropdowns.
 */
router.get('/list', async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name')
    .eq('is_active', true)
    .order('full_name');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ users: data });
});

/**
 * GET /api/admin/users/:userId
 * Fetch a single user's full profile.
 */
router.get('/:userId', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select(`
      id,
      full_name,
      role,
      is_active,
      is_anonymous,
      school_or_org,
      created_at,
      counselor_profiles (
        specialties,
        is_available,
        max_patient_load,
        license_number,
        years_of_experience
      )
    `)
    .eq('id', userId)
    .single();

  if (error) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
  const userWithEmail = { ...data, email: authData?.user?.email || '' };

  res.json({ user: userWithEmail });
});

/**
 * POST /api/admin/users
 * Create a new user account directly (admin, counselor, or patient).
 * Uses the Supabase Service Role Key to bypass email confirmation.
 * Body: { email, password, full_name, role, school_or_org?, specialties? }
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { email, password, full_name, role, school_or_org, specialties } = req.body;

  if (!email || !password || !full_name || !role) {
    res.status(400).json({ error: 'email, password, full_name, and role are required.' });
    return;
  }

  const validRoles = ['patient', 'counselor', 'admin'];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    return;
  }

  // 1. Create the auth.users record via Service Role API (no email confirmation needed)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // auto-confirm so the admin-created account is immediately active
  });

  if (authError || !authData.user) {
    res.status(400).json({ error: authError?.message || 'Failed to create auth user.' });
    return;
  }

  const userId = authData.user.id;

  // 2. Upsert the profiles record with the correct role
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: userId,
      full_name,
      role,
      school_or_org: school_or_org || null,
      is_active: true,
      is_anonymous: false,
    });

  if (profileError) {
    // Rollback: delete the auth user to avoid orphans
    await supabaseAdmin.auth.admin.deleteUser(userId);
    res.status(500).json({ error: profileError.message });
    return;
  }

  // 3. If creating a counselor, automatically initialize counselor_profiles
  if (role === 'counselor') {
    await supabaseAdmin.from('counselor_profiles').insert({
      id: userId,
      specialties: specialties || [],
      is_available: true,
      max_patient_load: 10,
    });
  }

  // 4. Auto-confirm consent for admin-created accounts so they can log in immediately
  await supabaseAdmin.from('consent_records').insert({
    user_id: userId,
    consent_version: process.env.CONSENT_VERSION || '1.0',
    status: 'agreed',
    ip_address: 'admin-created',
  });

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: (req as any).user.id,
    action: 'admin_created_user',
    target_table: 'profiles',
    target_id: userId,
    metadata: { role, email },
  });

  res.status(201).json({
    message: `${role} account created successfully.`,
    user_id: userId,
    email,
    role,
  });
});

/**
 * PATCH /api/admin/users/:userId/role
 * Change a user's role. Automatically creates counselor_profiles if promoting to counselor.
 * Body: { role, specialties? }
 */
router.patch('/:userId/role', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const { role, specialties } = req.body;

  const validRoles = ['patient', 'counselor', 'admin'];
  if (!role || !validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    return;
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', userId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Auto-create counselor_profiles row if promoting to counselor
  if (role === 'counselor') {
    const { data: existing } = await supabaseAdmin
      .from('counselor_profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!existing) {
      await supabaseAdmin.from('counselor_profiles').insert({
        id: userId,
        specialties: specialties || [],
        is_available: true,
        max_patient_load: 10,
      });
    }
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: (req as any).user.id,
    action: 'admin_changed_user_role',
    target_table: 'profiles',
    target_id: userId,
    metadata: { new_role: role },
  });

  res.json({ message: `User role updated to ${role}.` });
});

/**
 * PATCH /api/admin/users/:userId/status
 * Suspend or reactivate a user account.
 * Body: { is_active: boolean }
 */
router.patch('/:userId/status', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    res.status(400).json({ error: 'is_active (boolean) is required.' });
    return;
  }

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ is_active })
    .eq('id', userId);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: (req as any).user.id,
    action: is_active ? 'admin_reactivated_user' : 'admin_suspended_user',
    target_table: 'profiles',
    target_id: userId,
    metadata: { is_active },
  });

  res.json({ message: `Account ${is_active ? 'reactivated' : 'suspended'} successfully.` });
});

export default router;
