import { q, withCtx } from '../db.js';
import { requireAuth } from '../auth.js';
import { audit } from './employees.routes.js';

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5) + 1;

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  // Повертає власні заяви, актуальну чергу користувача та вже опрацьовані ним.
  // Чужі заяви не потрапляють у відповідь, якщо користувач не є учасником погодження.
  app.get('/api/requests', async (req) =>
    withCtx(req.user, async (c) => {
      const { rows } = await c.query(
        `SELECT r.*, e.name, e.pos, e.pos_official, e.manager_id,
                mgr.email AS manager_email,
                coalesce(json_agg(json_build_object(
                  'stage',a.stage,
                  'decision',a.decision,
                  'by',decider.email,
                  'comment',a.comment,
                  'at',a.decided_at
                ) ORDER BY CASE a.stage WHEN 'manager' THEN 1 WHEN 'hr' THEN 2 ELSE 3 END)
                FILTER (WHERE a.id IS NOT NULL),'[]') AS approvals
         FROM requests r
         JOIN employees e ON e.id=r.employee_id
         LEFT JOIN employees mgr ON mgr.id=e.manager_id
         LEFT JOIN approvals a ON a.request_id=r.id
         LEFT JOIN employees decider ON decider.id=a.decided_by
         WHERE r.employee_id=$1
            OR (r.current_stage='manager' AND e.manager_id=$1)
            OR (r.current_stage='hr' AND $2 IN ('hr','hr_manager','admin')
                AND NOT EXISTS (
                  SELECT 1 FROM approvals apx
                  WHERE apx.request_id=r.id AND apx.decided_by=$1
                    AND apx.decision IN ('approved','rejected')
                ))
            OR ($2='management')
            OR (r.current_stage='accounting' AND $2 IN ('accountant','admin')
                AND NOT EXISTS (
                  SELECT 1 FROM approvals apx
                  WHERE apx.request_id=r.id AND apx.decided_by=$1
                    AND apx.decision IN ('approved','rejected')
                ))
            OR EXISTS (SELECT 1 FROM approvals ax WHERE ax.request_id=r.id AND ax.decided_by=$1)
         GROUP BY r.id, e.name, e.pos, e.pos_official, e.manager_id, mgr.email
         ORDER BY r.created_at DESC`,
        [req.user.id, req.user.role]);
      return rows;
    }));

  app.post('/api/requests', async (req, reply) => {
    const b = req.body || {};
    const type = b.type === 'unpaid' ? 'unpaid' : 'annual';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '') || b.end_date < b.start_date)
      return reply.code(400).send({ error: 'Перевірте дати' });

    const days = daysBetween(b.start_date, b.end_date);
    if (!Number.isInteger(days) || days < 1 || days > 366)
      return reply.code(400).send({ error: 'Некоректна тривалість заяви' });

    // Заявка подається щонайменше за 3 календарні дні до початку відсутності.
    // Використовуємо дату БД, щоб правило не залежало від часового поясу браузера.
    const minStart = (await q("SELECT to_char(current_date + 3, 'YYYY-MM-DD') AS d")).rows[0].d;
    if (b.start_date < minStart)
      return reply.code(400).send({ error: 'Заявку можна подати щонайменше за 3 дні до початку відсутності' });

    try {
      return await withCtx(req.user, async (c) => {
        const emp = (await c.query('SELECT manager_id, vacation_days FROM employees WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
        if (!emp) return reply.code(404).send({ error: 'Профіль не знайдено' });

        const firstStage = emp.manager_id ? 'manager' : 'hr';
        const { rows } = await c.query(
          `INSERT INTO requests(employee_id,type,start_date,end_date,days,status,current_stage)
           VALUES($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
          [req.user.id, type, b.start_date, b.end_date, days, firstStage]);
        const r = rows[0];
        const stages = emp.manager_id ? ['manager', 'hr', 'accounting'] : ['hr', 'accounting'];
        for (const stage of stages)
          await c.query(`INSERT INTO approvals(request_id,stage,decision) VALUES($1,$2,'pending')`, [r.id, stage]);
        await audit(req.user.id, 'request.create', 'request', r.id, { type, start_date: b.start_date, end_date: b.end_date, days }, c);
        return reply.code(201).send(r);
      });
    } catch (e) {
      if (e.code === '23P01') return reply.code(409).send({ error: 'Ці дати вже зарезервовано іншою заявкою' });
      throw e;
    }
  });
}
