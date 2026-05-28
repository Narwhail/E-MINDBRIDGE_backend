import { Router, Request, Response } from 'express';
import { supabaseAdmin, supabaseClient } from '../supabase';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * PF-01: User Registration
 * POST /api/auth/register
 * 
 * Creates a new auth user. The handle_new_user DB trigger automatically
 * creates the profile record with the role from metadata.
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password, full_name, role = 'patient' } = req.body;

  if (!email || !password || !full_name) {
    res.status(400).json({ error: 'email, password, and full_name are required.' });
    return;
  }

  // Only allow patient and counselor self-registration. Admin must be assigned manually.
  if (!['patient', 'counselor'].includes(role)) {
    res.status(400).json({ error: 'Role must be patient or counselor.' });
    return;
  }

  // Step 1: Disable the DB trigger temporarily to avoid double-insert conflicts,
  // then create the auth user.
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role },
  });

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const userId = data.user?.id;

  // Step 2: Manually upsert into profiles. Using upsert so it works whether
  // the DB trigger fired or not.
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: userId,
      full_name,
      role,
    }, { onConflict: 'id' });

  if (profileError) {
    // Clean up: delete the orphaned auth user if profile creation fails
    if (userId) await supabaseAdmin.auth.admin.deleteUser(userId);
    res.status(500).json({ error: `Profile creation failed: ${profileError.message}` });
    return;
  }

  // Step 3: If registering as counselor, also create counselor_profiles record
  if (role === 'counselor' && userId) {
    const { error: counselorProfileError } = await supabaseAdmin
      .from('counselor_profiles')
      .upsert({
        id: userId,
        specialties: [],
        is_available: true,
        max_patient_load: 10,
      }, { onConflict: 'id' });

    if (counselorProfileError) {
      console.warn('[register] counselor_profiles upsert warning:', counselorProfileError.message);
    }
  }

  // Step 4: Audit log
  await supabaseAdmin.from('audit_logs').insert({
    actor_id: userId,
    action: 'user_registered',
    target_table: 'profiles',
    target_id: userId,
    metadata: { role },
  });

  res.status(201).json({
    message: 'User registered successfully.',
    user_id: userId,
  });
});

/**
 * PF-01: Submit Consent Record
 * POST /api/auth/consent
 * Body: { user_id, terms_agreed, privacy_agreed, ai_analysis_agreed, disclosure_agreed }
 *
 * Creates a versioned consent record. Must be called before dashboard access.
 */
router.post('/consent', async (req: Request, res: Response): Promise<void> => {
  const {
    user_id,
    terms_agreed,
    privacy_agreed,
    ai_analysis_agreed,
    disclosure_agreed,
  } = req.body;

  if (!user_id) {
    res.status(400).json({ error: 'user_id is required.' });
    return;
  }

  const allAgreed = terms_agreed && privacy_agreed && ai_analysis_agreed && disclosure_agreed;

  const { data, error } = await supabaseAdmin.from('consent_records').insert({
    user_id,
    consent_version: process.env.CONSENT_VERSION || '1.0',
    terms_agreed: Boolean(terms_agreed),
    privacy_agreed: Boolean(privacy_agreed),
    ai_analysis_agreed: Boolean(ai_analysis_agreed),
    disclosure_agreed: Boolean(disclosure_agreed),
    status: allAgreed ? 'agreed' : 'pending',
    agreed_at: allAgreed ? new Date().toISOString() : null,
    ip_address: req.ip,
    user_agent: req.headers['user-agent'],
  }).select('id').single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(201).json({
    message: allAgreed ? 'Consent recorded. Access granted.' : 'Consent pending — all fields must be agreed.',
    consent_id: data.id,
    status: allAgreed ? 'agreed' : 'pending',
  });
});

/**
 * PF-01: User Login
 * POST /api/auth/login
 * Body: { email, password }
 *
 * Authenticates the user and returns a JWT access token + their role.
 * Use the returned access_token as: Authorization: Bearer <access_token>
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required.' });
    return;
  }

  // Sign in via Supabase Auth to get a JWT
  const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });

  if (authError || !authData.session) {
    res.status(401).json({ error: authError?.message || 'Invalid email or password.' });
    return;
  }

  // Fetch the user's role and active status from profiles
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, is_active')
    .eq('id', authData.user.id)
    .single();

  if (profileError || !profile) {
    res.status(401).json({ error: 'User profile not found.' });
    return;
  }

  if (!profile.is_active) {
    res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
    return;
  }

  res.status(200).json({
    message: 'Login successful.',
    access_token: authData.session.access_token,
    refresh_token: authData.session.refresh_token,
    expires_at: authData.session.expires_at,
    user: {
      id: profile.id,
      full_name: profile.full_name,
      role: profile.role,
      email: authData.user.email,
    },
  });
});

/**
 * PF-01: Get Current User Profile
 * GET /api/auth/me
 * Header: Authorization: Bearer <access_token>
 *
 * Returns the authenticated user's profile and role.
 */
router.get('/me', authenticate, async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, role, full_name, display_name, is_active, created_at')
    .eq('id', user.id)
    .single();

  if (error || !profile) {
    res.status(404).json({ error: 'Profile not found.' });
    return;
  }

  res.status(200).json({ user: profile });
});

/**
 * PF-01: Logout
 * POST /api/auth/logout
 * Header: Authorization: Bearer <access_token>
 *
 * Invalidates the current session token.
 */
router.post('/logout', authenticate, async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  const { error } = await supabaseClient.auth.admin.signOut(token);

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  res.status(200).json({ message: 'Logged out successfully.' });
});

export default router;
