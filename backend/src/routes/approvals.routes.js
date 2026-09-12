import { withCtx } from '../db.js';
import { requireAuth } from '../auth.js';
import { audit } from './employees.routes.js';

const NEXT = { manager: 'hr', hr: 'accounting', accounting: null };

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/requests/:id/decide', async (req, reply) => {
    const { decision, comment } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) return reply.code(400).send({ error: 'Некоректне рішення' });
    if (decision === 'reject' && !(comment || '').trim())
      return reply.code(400).send({ error: 'Вкажіть причину відхилення' });

    return withCtx(req.user, async (c) => {
      const r = (await c.query('SELECT * FROM requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!r || r.status !== 'pending') return reply.code(404).send({ error: 'Заявку не знайдено або її вже закрито' });
      if (r.employee_id === req.user.id) return reply.code(403).send({ error: 'Не можна погоджувати власну заяву' });

      const author = (await c.query('SELECT manager_id, vacation_days FROM employees WHERE id=$1 FOR UPDATE', [r.employee_id])).rows[0];
      const stage = r.current_stage;

      // Одна людина може прийняти рішення лише на ОДНОМУ етапі конкретної заявки.
      // Напр.: HR-керівник спочатку погоджує заявку свого підлеглого як «Керівник»,
      // після чого HR-етап має виконати інший HR. Те саме правило діє для admin/accounting.
      const alreadyDecided = (await c.query(
        `SELECT 1 FROM approvals
         WHERE request_id=$1 AND decided_by=$2 AND decision IN ('approved','rejected')
         LIMIT 1`,
        [r.id, req.user.id]
      )).rowCount > 0;
      if (alreadyDecided)
        return reply.code(403).send({ error: 'Ви вже опрацювали інший етап цієї заявки. Наступний етап має погодити інша людина.' });

      const canManager = stage === 'manager' && author.manager_id === req.user.id;
      const canHR = stage === 'hr' && ['hr', 'hr_manager', 'admin'].includes(req.user.role);
      const canAcc = stage === 'accounting' && ['accountant', 'admin'].includes(req.user.role);
      if (!(canManager || canHR || canAcc)) return reply.code(403).send({ error: 'Не ваш етап погодження' });

      const changed = await c.query(
        `UPDATE approvals SET decision=$1, decided_by=$2, comment=$3, decided_at=now()
         WHERE request_id=$4 AND stage=$5 AND decision='pending' RETURNING id`,
        [decision === 'reject' ? 'rejected' : 'approved', req.user.id, (comment || '').trim() || null, r.id, stage]);
      if (!changed.rowCount) return reply.code(409).send({ error: 'Цей етап уже опрацьовано' });

      if (decision === 'reject') {
        await c.query("UPDATE approvals SET decision='skipped', decided_at=now() WHERE request_id=$1 AND decision='pending'", [r.id]);
        await c.query("UPDATE requests SET status='rejected', current_stage=NULL WHERE id=$1", [r.id]);
        await audit(req.user.id, 'request.reject', 'request', r.id, { stage, comment: (comment || '').trim() }, c);
        return { ok: true, status: 'rejected' };
      }

      const next = NEXT[stage];
      if (next) {
        await c.query('UPDATE requests SET current_stage=$1 WHERE id=$2', [next, r.id]);
        await audit(req.user.id, 'request.approve.stage', 'request', r.id, { stage }, c);
        return { ok: true, status: 'pending', next };
      }

      if (r.type === 'annual') {
        await c.query('UPDATE employees SET vacation_days=vacation_days-$1 WHERE id=$2', [r.days, r.employee_id]);
        await c.query(`INSERT INTO vacation_accruals(employee_id,accrual_date,days,source,note,created_by)
          VALUES($1,current_date,$2,'request',$3,$4)`,[r.employee_id,-r.days,`Списання за погоджену відпустку ${r.start_date} – ${r.end_date}`,req.user.id]);
      }
      await c.query("UPDATE requests SET status='approved', current_stage=NULL WHERE id=$1", [r.id]);
      await audit(req.user.id, 'request.approve.final', 'request', r.id, { days: r.days, type: r.type }, c);
      return { ok: true, status: 'approved' };
    });
  });
}
