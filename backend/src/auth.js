import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { q, systemQ } from './db.js';

const COOKIE = 'hrm_session';
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const LOCK_MIN = 15;

const HR_SUITE_SECTIONS=['analytics','recruiting','performance','onboarding'];

export const DEFAULT_PERMISSIONS = {
  user:{employees:'view',requests:'edit',calendar:'view',org:'view',kb:'view',onboarding:'view'},
  manager:{employees:'view',requests:'edit',calendar:'view',org:'view',kb:'view',performance:'view',onboarding:'edit'},
  management:{employees:'view',requests:'edit',calendar:'view',org:'view',kb:'view',analytics:'view',recruiting:'view',performance:'view',onboarding:'view'},
  accountant:{employees:'view',requests:'edit',calendar:'view',org:'view',kb:'view',onboarding:'view'},
  hr:{employees:'full',requests:'full',calendar:'full',org:'full',kb:'full',analytics:'full',recruiting:'full',performance:'full',onboarding:'full',permissions:'full',personal_docs:'full',employee_guid:'full',onboarding_services:'full',onboarding_deleted:'full',account_activation:'full'},
  hr_manager:{employees:'full',requests:'full',calendar:'full',org:'full',kb:'full',analytics:'full',recruiting:'full',performance:'full',onboarding:'full',permissions:'full',personal_docs:'full',employee_guid:'full',onboarding_services:'full',onboarding_deleted:'full',account_activation:'full'},
  // Адміністратор керує системою, але за замовчуванням не отримує HR-доступ до даних співробітників.
  // Додаткові бізнес-права можна видати явно через «Видачу прав».
  admin:{employees:'view',requests:'edit',calendar:'view',org:'view',kb:'view',onboarding:'view',employee_guid:'full',onboarding_services:'full',security:'full',permissions:'full',role_edit:'full'}
};
const ACCESS_RANK={none:0,view:1,edit:2,full:3};
export function defaultPermissionsForRole(role){
  return {...(DEFAULT_PERMISSIONS[role]||{})};
}
export function accessRank(level){ return ACCESS_RANK[level]||0; }
export async function effectivePermissions(user){
  const base={...(DEFAULT_PERMISSIONS[user?.role]||{})};
  if(!user?.id) return base;
  const {rows}=await q('SELECT section,access_level FROM employee_permissions WHERE employee_id=$1',[user.id]);
  const overrides=Object.fromEntries(rows.map(r=>[r.section,r.access_level]));

  // Матриця «Видача прав» є ДОДАТКОВИМ шаром до базових прав ролі.
  // Вона може лише розширити доступ, але не забрати те, що вже дає базова роль.
  // Це важливо для гнучкого адміністрування: базові права ролі + індивідуальні права.
  const maxLevel=(a='none',b='none') => accessRank(a) >= accessRank(b) ? a : b;
  for(const [section,level] of Object.entries(overrides)) {
    if (section === 'permissions' || section === 'hr_suite') continue;
    base[section]=maxLevel(base[section] || 'none', level);
  }
  const suiteLevel=overrides.hr_suite || 'none';
  base.hr_suite=maxLevel(base.hr_suite || 'none', suiteLevel);
  // Групове право HR та аналітики задає мінімальний рівень для дочірніх розділів,
  // але окреме право дочірнього розділу може бути вищим.
  if(suiteLevel !== 'none') {
    for(const section of HR_SUITE_SECTIONS) base[section]=maxLevel(base[section] || 'none', suiteLevel);
  }

  // «Видача прав» — захищений системний виняток: лише HR / HR-керівник / адміністратор.
  base.permissions=['hr','hr_manager','admin'].includes(user.role)?'full':'none';
  if(user.role==='admin') base.security='full';
  // Корпоративний GUID — захищене службове поле: тільки HR / HR-керівник / Адміністратор.
  base.employee_guid=['hr','hr_manager','admin'].includes(user.role)?'full':'none';
  return base;
}
export async function explicitPermissions(user){
  if(!user?.id) return {};
  const {rows}=await q('SELECT section,access_level FROM employee_permissions WHERE employee_id=$1',[user.id]);
  return Object.fromEntries(rows.map(r=>[r.section,r.access_level]));
}
export async function accessLevel(user, section){
  const p=await effectivePermissions(user);
  return p[section] || 'none';
}
export async function hasAccess(user, section, needed='view'){
  const level=await accessLevel(user,section);
  return (ACCESS_RANK[level]||0)>=(ACCESS_RANK[needed]||1);
}
export async function hasExplicitAccess(user, section, needed='view'){
  const p=await explicitPermissions(user);
  return (ACCESS_RANK[p[section]]||0)>=(ACCESS_RANK[needed]||1);
}



export function validatePassword(p = '') {
  const errors = [];
  if (String(p).length < 8) errors.push('мінімум 8 символів');
  if (!/[0-9]/.test(p)) errors.push('мінімум 1 цифра');
  if (!/[A-ZА-ЯІЇЄҐ]/.test(p)) errors.push('мінімум 1 велика літера');
  if (!/[a-zа-яіїєґ]/.test(p)) errors.push('мінімум 1 мала літера');
  if (!/[^A-Za-zА-Яа-яІіЇїЄєҐґ0-9]/.test(p)) errors.push('мінімум 1 спецсимвол');
  return { ok: errors.length === 0, errors };
}
export const passwordPolicyMessage = (p = '') => {
  const r = validatePassword(p);
  return r.ok ? '' : 'Пароль має містити: ' + r.errors.join(', ') + '.';
};

export const hashPassword = (p) => bcrypt.hash(p, 12);
export const verifyPassword = (p, h) => (h ? bcrypt.compare(p, h) : Promise.resolve(false));

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('hex');
export const tokenHash = sha;

// ── сесії (httpOnly-cookie; у БД лише хеш) ──────────────────────────────────
export async function createSession(reply, user, req) {
  const raw = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await q(`INSERT INTO sessions(employee_id, token_hash, ip, user_agent, expires_at)
           VALUES($1,$2,$3,$4,$5)`,
    [user.id, sha(raw), req.ip, req.headers['user-agent'] || '', expires]);
  reply.setCookie(COOKIE, raw, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires,
  });
}
export async function destroySession(req, reply) {
  const raw = req.cookies?.[COOKIE];
  if (raw) await q('DELETE FROM sessions WHERE token_hash=$1', [sha(raw)]);
  reply.clearCookie(COOKIE, { path: '/' });
}
export async function currentUser(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const { rows } = await q(
    `SELECT e.* FROM sessions s JOIN employees e ON e.id=s.employee_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND e.term_date IS NULL`, [sha(raw)]);
  return rows[0] || null;
}

// ── preHandler-и ────────────────────────────────────────────────────────────
export async function requireAuth(req, reply) {
  const u = await currentUser(req);
  if (!u) return reply.code(401).send({ error: 'Не авторизовано' });
  req.user = u;
}
// накопичувальні ролі: адмін/hr бачать усе; список — мінімально потрібні ролі
const RANK = { user: 0, manager: 1, accountant: 2, management: 2, hr: 3, hr_manager: 3, admin: 4 };
export const isHR = (u) => ['hr', 'hr_manager', 'admin'].includes(u?.role);
export const isManager = (u) => ['manager', 'management', 'hr_manager', 'admin'].includes(u?.role);
export function requireRole(...roles) {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Не авторизовано' });
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'Немає прав' });
  };
}

// ── блокування після невдалих спроб ────────────────────────────────────────
export async function registerFail(user, email, req, reason) {
  await systemQ(`INSERT INTO security_log(employee_id,email,event_type,reason,ip,user_agent)
           VALUES($1,$2,'login_fail',$3,$4,$5)`,
    [user?.id || null, email, reason, req.ip, req.headers['user-agent'] || '']);
  if (!user) return;
  const fails = user.failed_logins + 1;
  const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000) : null;
  await q('UPDATE employees SET failed_logins=$1, locked_until=$2 WHERE id=$3',
    [fails, lock, user.id]);
}
export async function registerSuccess(user, req, method = 'password') {
  await q('UPDATE employees SET failed_logins=0, locked_until=NULL WHERE id=$1', [user.id]);
  await systemQ(`INSERT INTO security_log(employee_id,email,event_type,reason,ip,user_agent)
           VALUES($1,$2,'login_success',$3,$4,$5)`,
    [user.id, user.email, method, req.ip, req.headers['user-agent'] || '']);
}
export const isLocked = (u) => u.locked_until && new Date(u.locked_until) > new Date();

export async function logSecurityEvent(user, eventType, reason, req, metadata = {}) {
  await systemQ(`INSERT INTO security_log(employee_id,email,event_type,reason,ip,user_agent,metadata)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [user?.id || null, user?.email || null, eventType, reason || '', req?.ip || null,
     req?.headers?.['user-agent'] || '', metadata]);
}


// ── Google Workspace / особистий Google-акаунт SSO ─────────────────────────
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
export async function verifyGoogle(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken, audience: process.env.GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  // Домен НЕ обмежуємо: вхід дозволений будь-якому Google-акаунту (включно зі
  // звичайною @gmail.com), але лише якщо ця пошта вже є в базі співробітників
  // (перевірка — у auth.routes.js, byEmail). Так самореєстрація і Google-вхід
  // лишаються двома незалежними, безпечними шляхами.
  return p; // { email, name, picture, ... }
}
