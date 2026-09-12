import { q } from '../db.js';
import * as A from '../auth.js';

const clean = (u) => u && ({
  id: u.id, name: u.name, email: u.email, pos: u.pos, pos_official: u.pos_official,
  dept: u.dept, role: u.role, manager_id: u.manager_id, bday: u.bday, hire_date: u.hire_date,
  prob_end: u.prob_end, vacation_days: u.vacation_days, activation: u.activation,
  presence: u.presence, photo: u.photo, about: u.about, permissions: u.permissions || {}, permission_grants: u.permission_grants || {},
});
const byEmail = async (email) =>
  (await q('SELECT * FROM employees WHERE lower(email)=lower($1) AND term_date IS NULL', [email])).rows[0];
const withPermissions = async (u) => u ? ({...u, permissions: await A.effectivePermissions(u), permission_grants: await A.explicitPermissions(u)}) : null;

export default async function (app) {

  app.get('/api/auth/config', async () => ({
    google_enabled: Boolean(process.env.GOOGLE_CLIENT_ID),
    google_client_id: process.env.GOOGLE_CLIENT_ID || '',
    environment: process.env.APP_ENV || process.env.NODE_ENV || 'development'
  }));

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // самостійна реєстрація: будь-яка коректна пошта (напр. звичайна @gmail.com)
  app.post('/api/auth/register', async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!name) return reply.code(400).send({ error: 'Вкажіть ПІБ' });
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Некоректна електронна пошта' });
    const policy = A.validatePassword(password);
    if (!policy.ok) return reply.code(400).send({ error: A.passwordPolicyMessage(password) });
    if (await byEmail(email)) return reply.code(409).send({ error: 'Акаунт із такою поштою вже існує' });
    const hash = await A.hashPassword(password);
    const row = (await q(
      `INSERT INTO employees(name,email,pos,pos_official,dept,role,hire_date,vacation_days,activation,password_hash,vacation_accrual_start)
       VALUES($1,$2,'—','—','—','user',current_date,0,'active',$3,current_date)
       RETURNING *`, [name, email, hash])).rows[0];
    await A.registerSuccess(row, req, 'register');
    await A.createSession(reply, row, req);
    return reply.code(201).send({ user: clean(await withPermissions(row)) });
  });

  // вхід за паролем (запасний спосіб)
  app.post('/api/auth/login', async (req, reply) => {
    const { email = '', password = '' } = req.body || {};
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Некоректна електронна пошта' });
    const u = await byEmail(email);
    if (!u) { await A.registerFail(null, email, req, 'Немає користувача'); return reply.code(401).send({ error: 'Невірні дані' }); }
    if (A.isLocked(u)) return reply.code(423).send({ error: 'Акаунт тимчасово заблоковано. Зверніться до HR.' });
    if (u.password_reset_required) return reply.code(403).send({ error: 'Потрібно встановити новий пароль за посиланням із листа.' });
    if (u.activation !== 'active' || !u.password_hash)
      return reply.code(403).send({ error: 'Акаунт ще не активовано — перейдіть за посиланням із листа.' });
    if (!(await A.verifyPassword(password, u.password_hash))) {
      await A.registerFail(u, email, req, 'Невірний пароль');
      return reply.code(401).send({ error: 'Невірні дані' });
    }
    await A.registerSuccess(u, req);
    await A.createSession(reply, u, req);
    return { user: clean(await withPermissions(u)) };
  });

  // вхід через Google (опційно, якщо в .env задано GOOGLE_CLIENT_ID)
  app.post('/api/auth/google', async (req, reply) => {
    const { id_token } = req.body || {};
    let p;
    try { p = await A.verifyGoogle(id_token); }
    catch (e) { return reply.code(401).send({ error: 'Google: ' + e.message }); }
    const u = await byEmail(p.email);
    if (!u) return reply.code(403).send({ error: 'Цієї пошти немає в системі. Зверніться до HR.' });
    if (A.isLocked(u)) return reply.code(423).send({ error: 'Акаунт тимчасово заблоковано. Зверніться до HR.' });
    if (u.password_reset_required) return reply.code(403).send({ error: 'Спочатку встановіть новий пароль за посиланням із листа.' });
    if (u.activation !== 'active') // перший вхід через Google активує акаунт
      await q("UPDATE employees SET activation='active' WHERE id=$1", [u.id]);
    await A.registerSuccess(u, req, 'Google');
    await A.createSession(reply, u, req);
    return { user: clean(await withPermissions({ ...u, activation: 'active' })) };
  });

  // активація за листом-запрошенням: задати пароль
  app.post('/api/auth/activate', async (req, reply) => {
    const { token, password } = req.body || {};
    if (!token || !password) return reply.code(400).send({ error: 'Вкажіть пароль' });
    const policy = A.validatePassword(password);
    if (!policy.ok) return reply.code(400).send({ error: A.passwordPolicyMessage(password) });
    const { rows } = await q(
      `SELECT * FROM auth_tokens WHERE token_hash=$1 AND kind='invite' AND used_at IS NULL AND expires_at>now()`,
      [A.tokenHash(token)]);
    const t = rows[0];
    if (!t) return reply.code(400).send({ error: 'Посилання недійсне або застаріло' });
    const hash = await A.hashPassword(password);
    await q("UPDATE employees SET password_hash=$1, activation='active' WHERE id=$2", [hash, t.employee_id]);
    await q('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id]);
    const u = (await q('SELECT * FROM employees WHERE id=$1', [t.employee_id])).rows[0];
    await A.createSession(reply, u, req);
    return { user: clean(await withPermissions(u)) };
  });

  // «Забули пароль?»
  app.post('/api/auth/forgot', async (req, reply) => {
    const { email = '' } = req.body || {};
    const u = await byEmail(email);
    if (u) {
      const raw = A.newToken();
      await q(`INSERT INTO auth_tokens(employee_id,kind,token_hash,expires_at)
               VALUES($1,'reset',$2, now() + interval '30 minutes')`, [u.id, A.tokenHash(raw)]);
      const { sendReset } = await import('../mail.js');
      await sendReset(u.email, u.name, raw);
    }
    return { ok: true }; // не розкриваємо, чи існує адреса
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const { token, password } = req.body || {};
    if (!token || !password) return reply.code(400).send({ error: 'Вкажіть пароль' });
    const policy = A.validatePassword(password);
    if (!policy.ok) return reply.code(400).send({ error: A.passwordPolicyMessage(password) });
    const { rows } = await q(
      `SELECT * FROM auth_tokens WHERE token_hash=$1 AND kind='reset' AND used_at IS NULL AND expires_at>now()`,
      [A.tokenHash(token)]);
    const t = rows[0];
    if (!t) return reply.code(400).send({ error: 'Посилання недійсне або застаріло' });
    await q("UPDATE employees SET password_hash=$1, activation='active', password_reset_required=false, failed_logins=0, locked_until=NULL WHERE id=$2",
      [await A.hashPassword(password), t.employee_id]);
    await q('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [t.id]);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => { const u=await A.currentUser(req); await A.destroySession(req, reply); if(u) await A.logSecurityEvent(u,'logout','Вихід із системи',req); return { ok: true }; });

  // зміна пароля залогіненим користувачем
  app.post('/api/auth/change-password', async (req, reply) => {
    const u = await A.currentUser(req);
    if (!u) return reply.code(401).send({ error: 'Не авторизовано' });
    const { old_password, new_password } = req.body || {};
    if (!new_password) return reply.code(400).send({ error: 'Вкажіть новий пароль' });
    const policy = A.validatePassword(new_password);
    if (!policy.ok) return reply.code(400).send({ error: A.passwordPolicyMessage(new_password) });
    if (u.password_hash && !(await A.verifyPassword(old_password || '', u.password_hash)))
      return reply.code(403).send({ error: 'Поточний пароль невірний' });
    await q("UPDATE employees SET password_hash=$1, activation='active', password_reset_required=false WHERE id=$2",
      [await A.hashPassword(new_password), u.id]);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const u = await A.currentUser(req);
    return { user: clean(await withPermissions(u)) };
  });
}
