import { q, withCtx } from '../db.js';
import { requireAuth, isHR, effectivePermissions, hasAccess, defaultPermissionsForRole, accessRank } from '../auth.js';
import { audit } from './employees.routes.js';

const LEVELS = new Set(['none','view','edit','full']);
const SECTIONS = new Set(['employees','requests','calendar','org','kb','hr_suite','analytics','recruiting','performance','onboarding','personal_docs','employee_guid','onboarding_services','onboarding_deleted','account_activation','security','permissions','role_edit']);
const ROLES = new Set(['user','manager','management','hr','hr_manager','accountant','admin']);

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/permissions', async (req, reply) => {
    if (!isHR(req.user)) return reply.code(403).send({ error: 'Лише HR та адміністратор' });
    const { rows } = await q(`SELECT p.employee_id,p.section,p.access_level,e.name,e.email,e.role
      FROM employee_permissions p JOIN employees e ON e.id=p.employee_id
      ORDER BY e.name,p.section`);
    return rows;
  });

  app.get('/api/permissions/:employeeId', async (req, reply) => {
    if (!isHR(req.user) && req.user.id !== req.params.employeeId)
      return reply.code(403).send({ error: 'Немає прав' });
    const target=(await q('SELECT * FROM employees WHERE id=$1',[req.params.employeeId])).rows[0];
    if(!target) return reply.code(404).send({error:'Співробітника не знайдено'});
    const effective=await effectivePermissions(target);
    return Object.entries(effective).map(([section,access_level])=>({section,access_level}));
  });

  app.put('/api/permissions/:employeeId', async (req, reply) => {
    if (!isHR(req.user)) return reply.code(403).send({ error: 'Лише HR та адміністратор' });
    const target = (await q('SELECT id,role FROM employees WHERE id=$1', [req.params.employeeId])).rows[0];
    if (!target) return reply.code(404).send({ error: 'Співробітника не знайдено' });
    if (target.role === 'admin' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Права адміністратора змінює лише адміністратор' });
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    for (const x of permissions) {
      if (!SECTIONS.has(x.section) || !LEVELS.has(x.access_level))
        return reply.code(400).send({ error: 'Некоректне право доступу' });
      // «Видача прав» не делегується через матрицю: цей розділ доступний лише ролям HR/адмін.
      if (x.section === 'permissions')
        return reply.code(400).send({ error: 'Доступ до «Видачі прав» визначається роллю HR/Адміністратор' });
      if (x.section === 'employee_guid')
        return reply.code(400).send({ error: 'Доступ до корпоративного GUID мають лише HR та Адміністратор' });
      if (x.section === 'personal_docs' && x.access_level !== 'none' && !['hr','hr_manager'].includes(target.role))
        return reply.code(400).send({ error: 'Особисті документи доступні лише самому співробітнику та ролям HR' });
    }
    await withCtx(req.user, async (c) => {
      for (const x of permissions) {
        await c.query(`INSERT INTO employee_permissions(employee_id,section,access_level,updated_by)
          VALUES($1,$2,$3,$4)
          ON CONFLICT(employee_id,section) DO UPDATE SET access_level=EXCLUDED.access_level,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [target.id,x.section,x.access_level,req.user.id]);
      }
      // Захищені права завжди синхронізовані з роллю.
      const permissionsLevel = ['hr','hr_manager','admin'].includes(target.role) ? 'full' : 'none';
      await c.query(`INSERT INTO employee_permissions(employee_id,section,access_level,updated_by)
        VALUES($1,'permissions',$2,$3)
        ON CONFLICT(employee_id,section) DO UPDATE SET access_level=EXCLUDED.access_level,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [target.id, permissionsLevel, req.user.id]);
      await audit(req.user.id,'permissions.update','employee',target.id,{count:permissions.length},c);
    });
    return { ok:true, permissions: await effectivePermissions((await q('SELECT * FROM employees WHERE id=$1',[target.id])).rows[0]) };
  });

  // Окрема керована дія: зміна базової ролі користувача.
  // Після зміни ролі зберігаємо лише справжні ДОДАТКОВІ права: ті,
  // що були вищими за базові права старої ролі і лишаються вищими за базові права нової.
  // Таким чином користувач завжди отримує базові права нової ролі + раніше видані надлишкові права,
  // але старий шаблон ролі не "прилипає" як індивідуальні overrides.
  app.put('/api/permissions/:employeeId/role', async (req, reply) => {
    if (!(await hasAccess(req.user,'role_edit','edit')))
      return reply.code(403).send({ error: 'Немає права «Редагування ролей користувачів»' });

    const newRole = String(req.body?.role || '').trim();
    if (!ROLES.has(newRole)) return reply.code(400).send({ error: 'Некоректна роль' });
    if (newRole === 'admin' && req.user.role !== 'admin')
      return reply.code(403).send({ error: 'Роль адміністратора призначає лише адміністратор' });

    return withCtx(req.user, async (c) => {
      const target = (await c.query('SELECT * FROM employees WHERE id=$1 FOR UPDATE',[req.params.employeeId])).rows[0];
      if (!target) return reply.code(404).send({ error: 'Співробітника не знайдено' });
      if (target.role === 'admin' && req.user.role !== 'admin')
        return reply.code(403).send({ error: 'Роль адміністратора змінює лише адміністратор' });
      if (target.role === newRole) {
        return { ok:true, employee:target, permissions:await effectivePermissions(target), preserved_extra:[] };
      }

      const oldBase = defaultPermissionsForRole(target.role);
      const explicit = (await c.query(
        `SELECT section,access_level FROM employee_permissions WHERE employee_id=$1`,[target.id])).rows;

      const protectedSections = new Set(['permissions','employee_guid','security']);
      // Зберігаємо всі справді ДОДАТКОВІ права, які були видані понад базовий шаблон
      // попередньої ролі. Навіть якщо нова роль уже дає такий самий/вищий рівень,
      // запис лишається як індивідуально надане право і не загубиться при наступній зміні ролі.
      const extras = explicit.filter(x => {
        if (protectedSections.has(x.section)) return false;
        return accessRank(x.access_level) > accessRank(oldBase[x.section] || 'none');
      });

      await c.query('UPDATE employees SET role=$1 WHERE id=$2',[newRole,target.id]);
      await c.query('DELETE FROM employee_permissions WHERE employee_id=$1',[target.id]);
      for (const x of extras) {
        await c.query(`INSERT INTO employee_permissions(employee_id,section,access_level,updated_by)
                       VALUES($1,$2,$3,$4)
                       ON CONFLICT(employee_id,section) DO UPDATE SET access_level=EXCLUDED.access_level,
                         updated_by=EXCLUDED.updated_by,updated_at=now()`,
                      [target.id,x.section,x.access_level,req.user.id]);
      }
      await audit(req.user.id,'employee.role.update','employee',target.id,
        {old_role:target.role,new_role:newRole,preserved_extra:extras.map(x=>x.section)},c);

      const updated=(await c.query('SELECT * FROM employees WHERE id=$1',[target.id])).rows[0];
      return { ok:true, employee:updated, permissions:await effectivePermissions(updated), preserved_extra:extras };
    });
  });

}
