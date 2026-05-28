import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../supabase';

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

  // If registering as counselor, also create counselor_profiles record
  if (role === 'counselor' && data.user) {
    await supabaseAdmin.from('counselor_profiles').insert({
      id: data.user.id,
      specialties: [],
      is_available: true,
      max_patient_load: 10,
    });
  }

  await supabaseAdmin.from('audit_logs').insert({
    actor_id: data.user?.id,
    action: 'user_registered',
    target_table: 'profiles',
    target_id: data.user?.id,
    metadata: { role },
  });

  res.status(201).json({
    message: 'User registered successfully.',
    user_id: data.user?.id,
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

export default router;
