import { q, withCtx, systemQ } from '../db.js';
import { requireAuth, isHR, hasAccess, newToken, tokenHash } from '../auth.js';
import { sendInvite, sendReset } from '../mail.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = new Set(['user','manager','management','hr','hr_manager','accountant','admin']);
const PRESENCE = new Set(['none','remote','sick','vacation']);

function monthDay(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : null;
}

// Серверна приватність: рік народження бачить лише власник профілю та HR.
// Поля блокування ніколи не віддаємо звичайним користувачам.
function view(e, viewer, { managerOfTarget = false, readAllOverride = false } = {}) {
  const hr = ['hr','hr_manager'].includes(viewer?.role);
  const readAll = readAllOverride || hr || viewer?.role === 'management';
  const self = e.id === viewer.id;
  const o = { ...e };
  delete o.password_hash;
  if (!readAll) {
    delete o.failed_logins;
    delete o.locked_until;
  }
  if (!readAll && !self) {
    o.bday_md = monthDay(o.bday);
    delete o.bday;
  }
  // Телефон є корпоративним контактним полем і доступний усім авторизованим співробітникам.
  // Інші службові дати доступні лише власнику, HR та прямому керівнику.
  if (!readAll && !self && !managerOfTarget) {
    delete o.hire_date;
    delete o.prob_end;
    delete o.vacation_days;
    delete o.activation;
  }
  return o;
}

async function targetAndRelation(id, viewer) {
  const { rows } = await q('SELECT * FROM employees WHERE id=$1', [id]);
  const e = rows[0];
  return { e, managerOfTarget: Boolean(e && e.manager_id === viewer.id) };
}

async function assertManagerIsValid(targetId, managerId) {
  if (!managerId) return;
  if (targetId && targetId === managerId) {
    const err = new Error('Співробітник не може бути власним керівником');
    err.statusCode = 400; throw err;
  }
  const exists = (await q('SELECT 1 FROM employees WHERE id=$1 AND term_date IS NULL', [managerId])).rowCount;
  if (!exists) { const err = new Error('Керівника не знайдено або його акаунт деактивовано'); err.statusCode = 400; throw err; }
  // Для нового співробітника targetId ще не існує, тож перевіряти цикл немає сенсу.
  if (!targetId) return;
  const cycle = (await q(
    `WITH RECURSIVE chain AS (
       SELECT id, manager_id FROM employees WHERE id=$1
       UNION ALL
       SELECT e.id, e.manager_id FROM employees e JOIN chain c ON e.id=c.manager_id
     ) SELECT 1 FROM chain WHERE id=$2 LIMIT 1`, [managerId, targetId])).rowCount;
  if (cycle) { const err = new Error('Ця зміна створить цикл в оргструктурі'); err.statusCode = 400; throw err; }
}

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/employees', async (req) => {
    // Індивідуальний доступ до HR-аналітики має вищий пріоритет за роль:
    // для розрахунків аналітики потрібні також деактивовані працівники та службові дати.
    const analyticsAccess = await hasAccess(req.user,'analytics','view');
    const employeesEdit = await hasAccess(req.user,'employees','edit');
    const readAll = employeesEdit || analyticsAccess;
    const sql = readAll ? 'SELECT * FROM employees ORDER BY name' : 'SELECT * FROM employees WHERE term_date IS NULL ORDER BY name';
    const { rows } = await q(sql);
    return rows.map(e => view(e, req.user, { managerOfTarget: e.manager_id === req.user.id, readAllOverride: readAll }));
  });

  app.get('/api/employees/:id', async (req, reply) => {
    const { e, managerOfTarget } = await targetAndRelation(req.params.id, req.user);
    if (!e) return reply.code(404).send({ error: 'Не знайдено' });
    const readAllOverride = await hasAccess(req.user,'employees','edit') || await hasAccess(req.user,'analytics','view');
    return view(e, req.user, { managerOfTarget, readAllOverride });
  });

  // Самостійне редагування — обмежений набір. HR може змінювати кадрові поля.
  app.patch('/api/employees/:id', async (req, reply) => {
    const target = req.params.id;
    const self = target === req.user.id;
    const hr = isHR(req.user);
    const canEdit = await hasAccess(req.user,'employees','edit');
    if (!self && !canEdit) return reply.code(403).send({ error: 'Немає прав' });

    const b = req.body || {};
    const selfFields = ['name', 'pos', 'pos_official', 'phone', 'bday', 'about', 'photo', 'presence'];
    const editorFields = [...selfFields, 'dept', 'manager_id', 'prob_end', 'vacation_days', 'hire_date', 'term_date'];
    const hrFields = [...editorFields, 'role'];
    const canFull = await hasAccess(req.user,'employees','full');
    const allowed = canFull ? hrFields : (canEdit ? editorFields : selfFields);

    if ('role' in b && !ROLES.has(b.role)) return reply.code(400).send({ error: 'Некоректна роль' });
    if ('role' in b && !(await hasAccess(req.user,'role_edit','edit'))) return reply.code(403).send({ error: 'Немає права «Редагування ролей користувачів»' });
    if ('role' in b && b.role === 'admin' && req.user.role !== 'admin') return reply.code(403).send({ error: 'Роль адміністратора призначає лише адміністратор' });
    if ('presence' in b && !PRESENCE.has(b.presence)) return reply.code(400).send({ error: 'Некоректний статус' });
    for (const k of ['bday','prob_end','hire_date','term_date']) {
      if (k in b && b[k] !== null && b[k] !== '' && !DATE_RE.test(String(b[k])))
        return reply.code(400).send({ error: `Некоректна дата: ${k}` });
    }
    if ('vacation_days' in b && (!Number.isInteger(Number(b.vacation_days)) || Number(b.vacation_days) < -365 || Number(b.vacation_days) > 365))
      return reply.code(400).send({ error: 'Некоректний залишок відпустки' });
    if ((hr || canEdit) && 'manager_id' in b) await assertManagerIsValid(target, b.manager_id || null);

    const sets = [], vals = []; let i = 1;
    for (const k of allowed) {
      if (!(k in b)) continue;
      let v = b[k];
      if (['bday','prob_end','hire_date','term_date','manager_id'].includes(k) && v === '') v = null;
      if (k === 'vacation_days') v = Number(v);
      sets.push(`${k}=$${i++}`); vals.push(v);
    }
    if (!sets.length) return { ok: true };
    const oldVacation = 'vacation_days' in b ? (await q('SELECT vacation_days FROM employees WHERE id=$1',[target])).rows[0]?.vacation_days : null;
    vals.push(target);
    const { rows } = await q(`UPDATE employees SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows[0]) return reply.code(404).send({ error: 'Співробітника не знайдено' });
    if ('vacation_days' in b && oldVacation !== null && Number(rows[0].vacation_days)!==Number(oldVacation)) {
      const delta=Number(rows[0].vacation_days)-Number(oldVacation);
      await q(`INSERT INTO vacation_accruals(employee_id,accrual_date,days,source,note,created_by)
               VALUES($1,current_date,$2,'manual','Ручне коригування HR',$3)`,[target,delta,req.user.id]);
      await audit(req.user.id,'vacation.accrual.manual','employee',target,{days:delta,balance:rows[0].vacation_days});
    }
    await audit(req.user.id, 'employee.update', 'employee', target, { fields: sets.map(s => s.split('=')[0]) });
    return view(rows[0], req.user, { managerOfTarget: rows[0].manager_id === req.user.id });
  });

  // HR додає профіль. Лист активації НЕ надсилається автоматично — лише окремою дією «Активувати».
  app.post('/api/employees', async (req, reply) => {
    if (!(await hasAccess(req.user,'employees','full'))) return reply.code(403).send({ error: 'Потрібен повний доступ до розділу «Співробітники»' });
    const b = req.body || {};
    if (!b.name?.trim()) return reply.code(400).send({ error: 'Вкажіть ПІБ' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email || '')) return reply.code(400).send({ error: 'Некоректна електронна пошта' });
    if (b.manager_id) await assertManagerIsValid(null, b.manager_id);
    const role = ROLES.has(b.role) ? b.role : 'user';
    try {
      const existing = (await q('SELECT * FROM employees WHERE lower(email)=lower($1)', [b.email])).rows[0];
      if (existing && !existing.term_date)
        return reply.code(409).send({ error: 'Активний співробітник із такою поштою вже існує' });

      let row, reactivated = false;
      if (existing) {
        reactivated = true;
        row = (await q(
          `UPDATE employees SET
             name=$1,pos=$2,pos_official=$3,dept=$4,manager_id=$5,bday=$6,
             hire_date=coalesce($7,current_date),prob_end=$8,vacation_days=coalesce($9,vacation_days),role=$10,
             phone=$11,about=$12,term_date=NULL,presence='none',failed_logins=0,locked_until=NULL,
             activation=CASE WHEN password_hash IS NULL THEN 'invited'::activation_status ELSE 'active'::activation_status END, invite_sent_at=NULL
           WHERE id=$13 RETURNING *`,
          [b.name.trim(), b.pos || '—', b.pos_official || b.pos || '—', b.dept || '—', b.manager_id || null,
           b.bday || null, b.hire_date || null, b.prob_end || null, b.vacation_days, role, b.phone || '', b.about || '', existing.id])).rows[0];
      } else {
        row = (await q(
          `INSERT INTO employees(name,email,pos,pos_official,dept,manager_id,bday,hire_date,prob_end,vacation_days,role,activation,phone,about,vacation_accrual_start)
           VALUES($1,lower($2),$3,$4,$5,$6,$7,coalesce($8,current_date),$9,coalesce($10,0),$11,'invited',$12,$13,coalesce($8,current_date))
           RETURNING *`,
          [b.name.trim(), b.email, b.pos || '—', b.pos_official || b.pos || '—', b.dept || '—', b.manager_id || null,
           b.bday || null, b.hire_date || null, b.prob_end || null, b.vacation_days, role, b.phone || '', b.about || ''])).rows[0];
      }
      await audit(req.user.id, reactivated ? 'employee.reactivate' : 'employee.create', 'employee', row.id, { email: row.email });
      return reply.code(reactivated ? 200 : 201).send({ ...view(row, req.user), reactivated });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Співробітник із такою поштою вже існує' });
      throw e;
    }
  });

  // Керована активація: спочатку HR заповнює стать та паспортні дані.
  app.post('/api/employees/:id/activate-invite', async (req, reply) => {
    if (!(await hasAccess(req.user,'account_activation','edit')))
      return reply.code(403).send({error:'Немає права активувати акаунти'});
    const e=(await q('SELECT * FROM employees WHERE id=$1 AND term_date IS NULL',[req.params.id])).rows[0];
    if(!e) return reply.code(404).send({error:'Співробітника не знайдено'});
    if(e.activation==='active') return reply.code(409).send({error:'Акаунт уже активований'});
    const p=(await q('SELECT * FROM employee_personal_data WHERE employee_id=$1',[e.id])).rows[0];
    if(!p?.sex) return reply.code(422).send({error:'Перед активацією вкажіть стать у профілі співробітника',code:'PROFILE_REQUIRED'});
    if(!p.passport_type || !p.passport_number || !p.passport_issue_date || !p.passport_issuer || !p.tax_id)
      return reply.code(422).send({error:'Перед активацією заповніть паспортні дані та РНОКПП',code:'PROFILE_REQUIRED'});
    if((p.passport_type==='booklet'||p.passport_type==='residence_permit') && !p.passport_series)
      return reply.code(422).send({error:'Для обраного документа вкажіть серію',code:'PROFILE_REQUIRED'});
    await inviteEmployee(e);
    await audit(req.user.id,'employee.activation_invite','employee',e.id,{email:e.email});
    return {ok:true,email:e.email};
  });

  // Деактивація в одній транзакції: підлеглі переходять до керівника деактивованої людини.
  app.post('/api/employees/:id/deactivate', async (req, reply) => {
    if (!(await hasAccess(req.user,'employees','full'))) return reply.code(403).send({ error: 'Потрібен повний доступ до розділу «Співробітники»' });
    const id = req.params.id;
    if (id === req.user.id) return reply.code(400).send({ error: 'Не можна деактивувати власний акаунт' });
    return withCtx(req.user, async (c) => {
      const target = (await c.query('SELECT manager_id, term_date FROM employees WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!target) return reply.code(404).send({ error: 'Співробітника не знайдено' });
      if (target.term_date) return { ok: true };
      await c.query('UPDATE employees SET manager_id=$1 WHERE manager_id=$2', [target.manager_id || null, id]);
      await c.query('UPDATE employees SET term_date=current_date, activation=\'invited\', presence=\'none\' WHERE id=$1', [id]);
      await c.query('DELETE FROM sessions WHERE employee_id=$1', [id]);
      await audit(req.user.id, 'employee.deactivate', 'employee', id, {}, c);
      return { ok: true };
    });
  });

  // HR відновлює тимчасово заблокований акаунт. Профіль та вся історія лишаються без змін.
  // Працівник отримує одноразове посилання і сам задає новий пароль.
  app.post('/api/employees/:id/unlock', async (req, reply) => {
    if (!(await hasAccess(req.user,'employees','full'))) return reply.code(403).send({ error: 'Потрібен повний доступ до розділу «Співробітники»' });
    const e = (await q('SELECT * FROM employees WHERE id=$1 AND term_date IS NULL', [req.params.id])).rows[0];
    if (!e) return reply.code(404).send({ error: 'Активного співробітника не знайдено' });
    if (!e.locked_until || new Date(e.locked_until) <= new Date())
      return reply.code(409).send({ error: 'Акаунт не заблоковано' });

    const raw = newToken();
    await withCtx(req.user, async (c) => {
      await c.query(`UPDATE employees
                     SET failed_logins=0, locked_until=NULL, password_hash=NULL,
                         password_reset_required=true
                     WHERE id=$1`, [e.id]);
      await c.query('DELETE FROM sessions WHERE employee_id=$1', [e.id]);
      await c.query(`UPDATE auth_tokens SET used_at=now()
                     WHERE employee_id=$1 AND kind='reset' AND used_at IS NULL`, [e.id]);
      await c.query(`INSERT INTO auth_tokens(employee_id,kind,token_hash,expires_at)
                     VALUES($1,'reset',$2,now()+interval '30 minutes')`, [e.id, tokenHash(raw)]);
      await audit(req.user.id, 'employee.unlock_and_reset', 'employee', e.id, { email: e.email }, c);
    });
    await sendReset(e.email, e.name, raw);
    return { ok: true, email: e.email };
  });

  // Корпоративний GUID — окреме службове поле. Його не включаємо у звичайний /api/employees,
  // щоб випадково не віддати ідентифікатор звичайному співробітнику.
  const canManageCorporateGuid = (u) => ['hr','hr_manager','admin'].includes(u?.role);
  const normalizeGuid = (value) => {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    let v=String(value).trim().replace(/^\{+|\}+$/g,'').toLowerCase();
    if (/^[0-9a-f]{32}$/.test(v)) v=`${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      const err=new Error('GUID має бути у форматі UUID, наприклад 3f2504e0-4f89-41d3-9a0c-0305e82c3301');
      err.statusCode=400; throw err;
    }
    return v;
  };

  app.get('/api/employees/:id/corporate-guid', async (req, reply) => {
    if (!canManageCorporateGuid(req.user)) return reply.code(403).send({ error: 'Корпоративний GUID доступний лише HR та Адміністратору' });
    const {rows}=await q('SELECT id,is_fop,corporate_guid FROM employees WHERE id=$1',[req.params.id]);
    if(!rows[0]) return reply.code(404).send({error:'Співробітника не знайдено'});
    return { id: rows[0].id, is_fop: rows[0].is_fop, corporate_guid: rows[0].corporate_guid };
  });

  app.post('/api/employees/:id/corporate-guid/generate', async (req, reply) => {
    if (!canManageCorporateGuid(req.user)) return reply.code(403).send({ error: 'Корпоративний GUID доступний лише HR та Адміністратору' });
    const exists=(await q('SELECT 1 FROM employees WHERE id=$1',[req.params.id])).rowCount;
    if(!exists) return reply.code(404).send({error:'Співробітника не знайдено'});
    // gen_random_uuid() генерує криптографічно випадковий UUID v4. Перевірка БД нижче
    // додатково гарантує відсутність дубля всередині HRM.
    for(let i=0;i<5;i++){
      const guid=(await q('SELECT gen_random_uuid()::text AS guid')).rows[0].guid;
      const duplicate=(await q('SELECT 1 FROM employees WHERE corporate_guid=$1',[guid])).rowCount;
      if(!duplicate) return { corporate_guid: guid };
    }
    return reply.code(500).send({error:'Не вдалося згенерувати унікальний GUID. Спробуйте ще раз.'});
  });

  app.put('/api/employees/:id/corporate-guid', async (req, reply) => {
    if (!canManageCorporateGuid(req.user)) return reply.code(403).send({ error: 'Корпоративний GUID доступний лише HR та Адміністратору' });
    const b=req.body||{};
    if (b.is_fop !== null && b.is_fop !== undefined && typeof b.is_fop !== 'boolean')
      return reply.code(400).send({error:'Некоректне значення ФОП'});
    let guid;
    try{guid=normalizeGuid(b.corporate_guid);}catch(e){return reply.code(e.statusCode||400).send({error:e.message});}
    if(guid){
      const dup=(await q('SELECT id,name FROM employees WHERE corporate_guid=$1 AND id<>$2',[guid,req.params.id])).rows[0];
      if(dup) return reply.code(409).send({error:`Цей GUID уже прив’язаний до іншого співробітника: ${dup.name}`});
    }
    const old=(await q('SELECT is_fop,corporate_guid FROM employees WHERE id=$1',[req.params.id])).rows[0];
    if(!old) return reply.code(404).send({error:'Співробітника не знайдено'});
    const {rows}=await q('UPDATE employees SET is_fop=$1,corporate_guid=$2 WHERE id=$3 RETURNING id,is_fop,corporate_guid',[b.is_fop ?? null,guid,req.params.id]);
    await audit(req.user.id,'employee.guid.update','employee',req.params.id,{is_fop:rows[0].is_fop,changed:String(old.corporate_guid||'')!==String(rows[0].corporate_guid||'')});
    return rows[0];
  });

  app.post('/api/employees/:id/reinvite', async (req, reply) => {
    if (!(await hasAccess(req.user,'employees','full'))) return reply.code(403).send({ error: 'Потрібен повний доступ до розділу «Співробітники»' });
    const e = (await q('SELECT * FROM employees WHERE id=$1', [req.params.id])).rows[0];
    if (!e) return reply.code(404).send({ error: 'Співробітника не знайдено' });
    if (!e.invite_sent_at) return reply.code(409).send({ error: 'Спочатку активуйте профіль через кнопку «Активувати» після заповнення обов’язкових даних' });
    await inviteEmployee(e);
    await audit(req.user.id,'employee.activation_invite','employee',e.id,{email:e.email,resend:true});
    return { ok: true };
  });
}

export async function inviteEmployee(e) {
  const raw = newToken();
  await q(`UPDATE auth_tokens SET used_at=now() WHERE employee_id=$1 AND kind='invite' AND used_at IS NULL`,[e.id]);
  await q(`INSERT INTO auth_tokens(employee_id,kind,token_hash,expires_at)
           VALUES($1,'invite',$2, now() + interval '7 days')`, [e.id, tokenHash(raw)]);
  await q('UPDATE employees SET invite_sent_at=now() WHERE id=$1',[e.id]);
  await sendInvite(e.email, e.name, raw);
}
export async function audit(actor, action, entity, entity_id, details, client = null) {
  const runner = client || { query: systemQ };
  await runner.query('INSERT INTO audit_log(actor_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)',
    [actor, action, entity, entity_id, details]);
}
