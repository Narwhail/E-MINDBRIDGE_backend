import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';

import authRoutes from './routes/auth';
import moodRoutes from './routes/mood';
import journalRoutes from './routes/journal';
import reportRoutes from './routes/reports';
import evaluationRoutes from './routes/evaluations';
import sessionRoutes from './routes/sessions';
import analyticsRoutes from './routes/analytics';
import notificationRoutes from './routes/notifications';
import dashboardRoutes from './routes/dashboard';
import patientRoutes from './routes/patients';

// Admin Console API routes
import { authenticate, requireRole } from './middleware/auth';
import adminUsersRoutes from './routes/admin/users';
import adminQuotesRoutes from './routes/admin/quotes';
import adminAssignmentsRoutes from './routes/admin/assignments';
import adminAuditRoutes from './routes/admin/audit';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json;
  let responseBody: any = null;

  // Intercept res.json to capture response bodies (especially error messages)
  res.json = function (body) {
    responseBody = body;
    return originalJson.call(this, body);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    let logMsg = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`;

    if (res.statusCode >= 400 && responseBody) {
      const errorMsg = responseBody.error || responseBody.message || JSON.stringify(responseBody);
      logMsg += ` ⚠️ Error: "${errorMsg}"`;
    }

    console.log(logMsg);
  });
  next();
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'E-MindBridge API', timestamp: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/mood', moodRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/patients', patientRoutes);

// ─── Admin Console Routes (API) ───────────────────────────────────────────────
app.use('/api/admin/users',       authenticate, requireRole('admin'), adminUsersRoutes);
app.use('/api/admin/quotes',      authenticate, requireRole('admin'), adminQuotesRoutes);
app.use('/api/admin/assignments', authenticate, requireRole('admin'), adminAssignmentsRoutes);
app.use('/api/admin/audit',       authenticate, requireRole('admin'), adminAuditRoutes);

// ─── Admin Console UI ─────────────────────────────────────────────────────────
// Serves the self-contained Admin Console SPA at http://localhost:<PORT>/admin
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ E-MindBridge API running on http://localhost:${PORT}`);
  console.log(`   Health check:   http://localhost:${PORT}/health`);
  console.log(`   Admin console:  http://localhost:${PORT}/admin`);
  console.log(`   Gemini API:     ${process.env.GEMINI_API_KEY ? '✅ Configured' : '⚠️  Not set — using simulated responses'}`);
  console.log(`   Supabase URL:   ${process.env.SUPABASE_URL || '❌ MISSING'}`);
  console.log(`   Jitsi Domain:   ${process.env.JITSI_DOMAIN || 'meet.jit.si (default)'}`);
});
