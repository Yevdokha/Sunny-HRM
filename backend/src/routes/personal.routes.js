import { q } from '../db.js';
import { requireAuth, hasAccess } from '../auth.js';
import { audit } from './employees.routes.js';

const HR_ROLES = new Set(['hr','hr_manager']);
const PASSPORT_TYPES = new Set(['booklet','id_card','residence_permit']);
const isHRContent = u => HR_ROLES.has(u?.role);
const nullable = v => (v === '' || v === undefined ? null : v);

function canSee(viewer, employeeId){ return viewer?.id === employeeId || isHRContent(viewer); }

export default async function(app){
  app.addHook('preHandler', requireAuth);

  app.get('/api/personal/:id', async (req, reply) => {
    const self=req.user?.id===req.params.id;
    if(!self && (!isHRContent(req.user) || !(await hasAccess(req.user,'personal_docs','view')))) return reply.code(403).send({error:'Особисті документи доступні лише співробітнику та HR із відповідним правом'});
    return (await q('SELECT * FROM employee_personal_data WHERE employee_id=$1',[req.params.id])).rows[0] || null;
  });

  app.put('/api/personal/:id', async (req, reply) => {
    if(!isHRContent(req.user)) return reply.code(403).send({error:'Редагувати особисті документи може лише HR'});
    if(!(await hasAccess(req.user,'personal_docs','edit'))) return reply.code(403).send({error:'Немає права редагувати особисті документи'});
    const b=req.body||{};
    if(b.sex && !['male','female'].includes(b.sex)) return reply.code(400).send({error:'Некоректно вказана стать'});
    if(b.passport_type && !PASSPORT_TYPES.has(b.passport_type)) return reply.code(400).send({error:'Некоректний тип документа'});
    const row=(await q(`INSERT INTO employee_personal_data(
      employee_id,sex,passport_type,passport_series,passport_number,
      passport_issue_date,passport_issuer,tax_id,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(employee_id) DO UPDATE SET
        sex=excluded.sex,
        passport_type=excluded.passport_type,passport_series=excluded.passport_series,
        passport_number=excluded.passport_number,passport_issue_date=excluded.passport_issue_date,
        passport_issuer=excluded.passport_issuer,tax_id=excluded.tax_id,updated_by=excluded.updated_by
      RETURNING *`,[
        req.params.id, nullable(b.sex),
        nullable(b.passport_type), nullable(b.passport_series), nullable(b.passport_number),
        nullable(b.passport_issue_date), nullable(b.passport_issuer), nullable(b.tax_id), req.user.id
      ])).rows[0];
    await audit(req.user.id,'personal_docs.update','employee_personal_data',req.params.id,{passport_type:row.passport_type,sex:row.sex});
    return row;
  });
}
