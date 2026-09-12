import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runMigrations } from './migrate.js';

import authRoutes from './routes/auth.routes.js';
import employeeRoutes from './routes/employees.routes.js';
import requestRoutes from './routes/requests.routes.js';
import approvalRoutes from './routes/approvals.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import importRoutes from './routes/import.routes.js';
import securityRoutes from './routes/security.routes.js';
import recruitingRoutes from './routes/recruiting.routes.js';
import onboardingRoutes from './routes/onboarding.routes.js';
import permissionsRoutes from './routes/permissions.routes.js';
import personalRoutes from './routes/personal.routes.js';
import aiRoutes from './routes/ai.routes.js';
import { startProbationReminderJob } from './probation.js';
import { startVacationJobs } from './vacation-accrual.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(__dir, '..', 'frontend');   // том із погодженим HTML

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });

// Завжди працюємо з UTF-8, незалежно від локалі контейнера/Windows-хоста.
process.env.PGCLIENTENCODING = 'UTF8';

await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(multipart, { limits: { fileSize: 6 * 1024 * 1024 } });

// API
await app.register(authRoutes);
await app.register(employeeRoutes);
await app.register(requestRoutes);
await app.register(approvalRoutes);
await app.register(catalogRoutes);
await app.register(importRoutes);
await app.register(securityRoutes);
await app.register(recruitingRoutes);
await app.register(onboardingRoutes);
await app.register(permissionsRoutes);
await app.register(personalRoutes);
await app.register(aiRoutes);

// швидка перевірка «живе/не живе» (для тебе під час налаштування)
import { q as _q } from './db.js';
app.get('/api/health', async () => {
  try { await _q('SELECT 1'); return { ok: true, db: 'connected' }; }
  catch (e) { return { ok: false, db: 'error', error: String(e.message) }; }
});

// статичний фронтенд (наш HTML) — HTML не кешуємо, щоб оновлення завжди підхоплювались
await app.register(fstatic, { root: FRONTEND, prefix: '/', setHeaders(res, p){ if(p.endsWith('.html')) res.setHeader('Cache-Control','no-store'); } });
// маршрути активації/скидання відкривають той самий застосунок
for (const p of ['/activate', '/reset'])
  app.get(p, (req, reply) => reply.sendFile('index.html'));

const start = async () => {
  try {
    await runMigrations();                          // застосувати схему/нові міграції
    if(String(process.env.DEMO_SEED||'').toLowerCase()==='true'){ const { seedLocalDemo }=await import('./seed-local.js'); await seedLocalDemo(app.log); }
    await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3000) });
    startProbationReminderJob(app.log);
    startVacationJobs(app.log);
  } catch (e) { app.log.error(e); process.exit(1); }
};
start();
