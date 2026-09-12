import { q, systemQ } from '../db.js';
import { requireAuth, hasAccess } from '../auth.js';
import { audit } from './employees.routes.js';


function parseRange(query = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : from;
  if (to < from) return { from: to, to: from };
  return { from, to };
}

function logFilters(query = {}, alias = 's') {
  const { from, to } = parseRange(query);
  const params = [from, to];
  const where = [
    `${alias}.created_at >= $1::date`,
    `${alias}.created_at < ($2::date + interval '1 day')`,
  ];
  if (query.type && query.type !== 'all') {
    params.push(query.type);
    where.push(`${alias}.event_type = $${params.length}`);
  }
  if (query.user) {
    params.push(`%${String(query.user).trim()}%`);
    where.push(`(coalesce(${alias}.email,'') ILIKE $${params.length} OR coalesce(e.name,'') ILIKE $${params.length})`);
  }
  return { from, to, params, where: where.join(' AND ') };
}

function auditFilters(query = {}, alias = 'a') {
  const { from, to } = parseRange(query);
  const params = [from, to];
  const where = [
    `${alias}.created_at >= $1::date`,
    `${alias}.created_at < ($2::date + interval '1 day')`,
  ];
  if (query.user) {
    params.push(`%${String(query.user).trim()}%`);
    where.push(`(coalesce(e.email,'') ILIKE $${params.length} OR coalesce(e.name,'') ILIKE $${params.length})`);
  }
  return { from, to, params, where: where.join(' AND ') };
}

async function ensureDerivedAlerts() {
  await systemQ(`INSERT INTO security_alerts(alert_key,level,category,title,detail,employee_id,metadata)
    SELECT 'login-fail:'||coalesce(lower(email),'unknown')||':'||to_char(date_trunc('hour',max(created_at)),'YYYYMMDDHH24'),
           'critical','authentication','Можливий підбір пароля: '||coalesce(max(email),'невідома адреса'),
           count(*)||' невдалих спроб входу протягом останньої години.', max(employee_id::text)::uuid,
           jsonb_build_object('fails',count(*),'email',max(email))
    FROM security_log
    WHERE event_type='login_fail' AND created_at > now()-interval '1 hour'
    GROUP BY lower(email)
    HAVING count(*) >= 4
    ON CONFLICT DO NOTHING`);

  await systemQ(`INSERT INTO security_alerts(alert_key,level,category,title,detail,employee_id,metadata)
    SELECT 'locked:'||e.id||':'||to_char(date_trunc('day',now()),'YYYYMMDD'),
           'warning','authentication','Акаунт заблоковано: '||e.name,
           'Перевищено кількість невдалих спроб входу.', e.id,
           jsonb_build_object('email',e.email,'locked_until',e.locked_until)
    FROM employees e
    WHERE e.locked_until > now()
      AND NOT EXISTS (SELECT 1 FROM security_alerts a WHERE a.alert_key='locked:'||e.id||':'||to_char(date_trunc('day',now()),'YYYYMMDD'))`);
}

async function ensureDerivedAlertsSafe(app) {
  try { await ensureDerivedAlerts(); }
  catch (error) { app.log.error({ err: error }, 'Не вдалося сформувати похідні алерти; журнал буде показано без них'); }
}

let lastRetentionRun = 0;
async function applyRetentionSafe(app) {
  const now = Date.now();
  if (now - lastRetentionRun < 24 * 60 * 60 * 1000) return;
  lastRetentionRun = now;
  const days = Math.max(30, Number(process.env.SECURITY_LOG_RETENTION_DAYS || 365));
  try {
    await systemQ(`DELETE FROM security_log WHERE created_at < now() - ($1::int * interval '1 day')`, [days]);
    await systemQ(`DELETE FROM audit_log WHERE created_at < now() - ($1::int * interval '1 day')`, [days]);
    await systemQ(`DELETE FROM security_alerts WHERE status='resolved' AND created_at < now() - ($1::int * interval '1 day')`, [days]);
  } catch (error) {
    app.log.error({ err: error }, 'Не вдалося застосувати строк зберігання журналів');
  }
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/security/summary', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    await ensureDerivedAlertsSafe(app);
    await applyRetentionSafe(app);
    const [today, alerts, auditCount, checks] = await Promise.all([
      systemQ(`SELECT count(*) FILTER(WHERE event_type='login_success')::int AS success,
                count(*) FILTER(WHERE event_type='login_fail')::int AS failed,
                count(*) FILTER(WHERE event_type='locked')::int AS locked
         FROM security_log WHERE created_at >= current_date`),
      systemQ(`SELECT count(*)::int AS total,
                count(*) FILTER(WHERE level='critical')::int AS critical
         FROM security_alerts WHERE status <> 'resolved'`),
      systemQ(`SELECT count(*)::int AS total FROM audit_log WHERE created_at >= current_date`),
      systemQ(`SELECT DISTINCT ON (component) component,status,detail,checked_at
         FROM system_checks ORDER BY component,checked_at DESC`)
    ]);
    return { login: today.rows[0], alerts: alerts.rows[0], audit_today: auditCount.rows[0].total, checks: checks.rows };
  });

  app.get('/api/security/log', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    const f = logFilters(req.query);
    const { rows } = await systemQ(
      `SELECT s.id,s.created_at,s.email,s.event_type,s.reason,s.metadata,e.name
       FROM security_log s LEFT JOIN employees e ON e.id=s.employee_id
       WHERE ${f.where}
       ORDER BY s.created_at DESC LIMIT 1000`, f.params);
    return rows;
  });

  app.get('/api/security/audit', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    const f = auditFilters(req.query);
    const { rows } = await systemQ(
      `SELECT a.id,a.created_at,a.action,a.entity,a.entity_id,a.details,a.result,
              e.name AS actor_name,e.email AS actor_email
       FROM audit_log a LEFT JOIN employees e ON e.id=a.actor_id
       WHERE ${f.where}
       ORDER BY a.created_at DESC LIMIT 1000`, f.params);
    return rows;
  });

  app.get('/api/security/alerts', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    await ensureDerivedAlertsSafe(app);
    const { rows } = await systemQ(
      `SELECT a.*,e.name,e.email FROM security_alerts a
       LEFT JOIN employees e ON e.id=a.employee_id
       ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                a.created_at DESC LIMIT 500`);
    return rows;
  });

  app.patch('/api/security/alerts/:id', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','edit'))) return reply.code(403).send({ error: 'Потрібне право редагування розділу «Безпека»' });
    const status=req.body?.status;
    if(!['reviewed','resolved'].includes(status)) return reply.code(400).send({error:'Некоректний статус'});
    const {rows}=await systemQ(`UPDATE security_alerts SET status=$1,
      reviewed_at=CASE WHEN $1='reviewed' THEN now() ELSE reviewed_at END,
      reviewed_by=CASE WHEN $1='reviewed' THEN $2 ELSE reviewed_by END,
      resolved_at=CASE WHEN $1='resolved' THEN now() ELSE resolved_at END,
      resolved_by=CASE WHEN $1='resolved' THEN $2 ELSE resolved_by END
      WHERE id=$3 RETURNING *`,[status,req.user.id,req.params.id]);
    if(!rows[0]) return reply.code(404).send({error:'Алерт не знайдено'});
    await audit(req.user.id,'security.alert.'+status,'security_alert',null,{alert_id:req.params.id},null,req);
    return rows[0];
  });

  app.get('/api/security/dashboard', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    await ensureDerivedAlertsSafe(app);
    await applyRetentionSafe(app);
    const lf = logFilters(req.query);
    const af = auditFilters(req.query);
    const month = /^\d{4}-\d{2}$/.test(req.query?.month || '') ? req.query.month : lf.from.slice(0, 7);
    const [logs, alerts, audits, period, checks, calendar] = await Promise.all([
      systemQ(`SELECT s.id,s.created_at,s.email,s.event_type,s.reason,s.metadata,e.name
               FROM security_log s LEFT JOIN employees e ON e.id=s.employee_id
               WHERE ${lf.where}
               ORDER BY s.created_at DESC LIMIT 1000`, lf.params),
      systemQ(`SELECT a.*,e.name,e.email FROM security_alerts a
               LEFT JOIN employees e ON e.id=a.employee_id
               ORDER BY CASE a.status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
                        CASE a.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                        a.created_at DESC LIMIT 500`),
      systemQ(`SELECT a.id,a.created_at,a.action,a.entity,a.entity_id,a.details,a.result,
                      e.name AS actor_name,e.email AS actor_email
               FROM audit_log a LEFT JOIN employees e ON e.id=a.actor_id
               WHERE ${af.where}
               ORDER BY a.created_at DESC LIMIT 1000`, af.params),
      systemQ(`SELECT count(*) FILTER(WHERE event_type='login_success')::int AS success,
                      count(*) FILTER(WHERE event_type='login_fail')::int AS failed,
                      count(*) FILTER(WHERE event_type='logout')::int AS logout
               FROM security_log s LEFT JOIN employees e ON e.id=s.employee_id
               WHERE ${lf.where}`, lf.params),
      systemQ(`SELECT DISTINCT ON (component) component,status,detail,checked_at
               FROM system_checks ORDER BY component,checked_at DESC`),
      systemQ(`WITH days AS (
                 SELECT generate_series(($1||'-01')::date,
                   (($1||'-01')::date + interval '1 month - 1 day')::date,
                   interval '1 day')::date AS day
               ), lc AS (
                 SELECT created_at::date AS day, count(*)::int AS logs,
                        count(*) FILTER(WHERE event_type='login_fail')::int AS failed
                 FROM security_log
                 WHERE created_at >= ($1||'-01')::date
                   AND created_at < (($1||'-01')::date + interval '1 month')
                 GROUP BY created_at::date
               ), ac AS (
                 SELECT created_at::date AS day, count(*)::int AS audits
                 FROM audit_log
                 WHERE created_at >= ($1||'-01')::date
                   AND created_at < (($1||'-01')::date + interval '1 month')
                 GROUP BY created_at::date
               ), al AS (
                 SELECT created_at::date AS day, count(*)::int AS alerts
                 FROM security_alerts
                 WHERE created_at >= ($1||'-01')::date
                   AND created_at < (($1||'-01')::date + interval '1 month')
                 GROUP BY created_at::date
               )
               SELECT d.day,coalesce(lc.logs,0)::int AS logs,coalesce(lc.failed,0)::int AS failed,
                      coalesce(ac.audits,0)::int AS audits,coalesce(al.alerts,0)::int AS alerts
               FROM days d LEFT JOIN lc USING(day) LEFT JOIN ac USING(day) LEFT JOIN al USING(day)
               ORDER BY d.day`, [month])
    ]);
    return { logs: logs.rows, alerts: alerts.rows, audit: audits.rows,
             calendar: calendar.rows, range: { from: lf.from, to: lf.to, month },
             summary: { login: period.rows[0], checks: checks.rows } };
  });

  app.get('/api/security/export.csv', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    const lf = logFilters(req.query);
    const af = auditFilters(req.query);
    const [logs, audits] = await Promise.all([
      systemQ(`SELECT s.created_at,e.name,s.email,s.event_type,s.reason
               FROM security_log s LEFT JOIN employees e ON e.id=s.employee_id
               WHERE ${lf.where} ORDER BY s.created_at DESC`, lf.params),
      systemQ(`SELECT a.created_at,e.name AS actor_name,e.email AS actor_email,a.action,a.entity,a.result
               FROM audit_log a LEFT JOIN employees e ON e.id=a.actor_id
               WHERE ${af.where} ORDER BY a.created_at DESC`, af.params)
    ]);
    const lines = [
      ['Розділ','Дата й час','Користувач','Email','Подія/дія','Об’єкт/причина','Результат'].map(csvCell).join(','),
      ...logs.rows.map(r => ['Вхід',r.created_at?.toISOString?.() || r.created_at,r.name,r.email,r.event_type,r.reason,''].map(csvCell).join(',')),
      ...audits.rows.map(r => ['Адміністративна дія',r.created_at?.toISOString?.() || r.created_at,r.actor_name,r.actor_email,r.action,r.entity,r.result].map(csvCell).join(',')),
    ];
    const name = `security-logs-${lf.from}-${lf.to}.csv`;
    reply.header('Content-Type','text/csv; charset=utf-8');
    reply.header('Content-Disposition',`attachment; filename="${name}"`);
    return '\uFEFF' + lines.join('\r\n');
  });

  app.post('/api/security/checks/run', async (req, reply) => {
    if (!(await hasAccess(req.user,'security','view'))) return reply.code(403).send({ error: 'Немає доступу до розділу «Безпека»' });
    const results=[];
    try { await q('SELECT 1'); results.push(['database','ok','PostgreSQL відповідає']); }
    catch(e){ results.push(['database','error',e.message]); }
    const smtp = process.env.SMTP_HOST ? ['mail','ok','SMTP налаштовано'] : ['mail','warning','SMTP ще не налаштовано'];
    const google = process.env.GOOGLE_CLIENT_ID ? ['google_sso','ok','Google Client ID налаштовано'] : ['google_sso','warning','Google SSO ще не налаштовано'];
    results.push(smtp,google);
    for(const r of results) await systemQ('INSERT INTO system_checks(component,status,detail) VALUES($1,$2,$3)',r);
    return {ok:true,results:results.map(([component,status,detail])=>({component,status,detail}))};
  });
}
