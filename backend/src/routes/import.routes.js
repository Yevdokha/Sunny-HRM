import XLSX from 'xlsx';
import { q, withCtx } from '../db.js';
import { requireAuth, hasAccess } from '../auth.js';
import { audit } from './employees.routes.js';

const EXPECTED = [
  'ПІБ','Пошта','Посада (управлінська)','Посада за класифікатором','Відділ',
  'Роль у системі','Керівник (пошта)','Дата народження','Дата найму',
  'Залишок відпустки (днів)'
];
const aliases = {
  name:['піб','ім’я','імя','name'], email:['пошта','email','електронна адреса'],
  pos:['посада (управлінська)','посада управлінська','управлінська посада'],
  posOfficial:['посада за класифікатором','офіційна посада','регламентна посада'],
  dept:['відділ','департамент'], role:['роль у системі','роль','system role'],
  manager:['керівник (пошта)','керівник','пошта керівника'],
  bday:['дата народження','день народження'], hire:['дата найму'],
  prob:['кінець випробувального','дата закінчення випробувального терміну'],
  vacation:['залишок відпустки (днів)','залишок відпустки','відпустка']
};
const ROLE_MAP = new Map([
  ['співробітник','user'],['працівник','user'],['user','user'],
  ['керівник','manager'],['manager','manager'],
  ['hr','hr'],['ейчар','hr'],
  ['управління','management'],['management','management'],['керівник / hr','hr_manager'],['керівник/hr','hr_manager'],['hr / керівник','hr_manager'],['hr_manager','hr_manager'],
  ['бухгалтерія','accountant'],['бухгалтер','accountant'],['accountant','accountant'],
  ['адміністратор','admin'],['admin','admin']
]);
const clean = v => String(v ?? '').trim();
const key = v => clean(v).toLowerCase().replace(/\s+/g,' ');
function normDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v); if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s=clean(v); let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m)return s;
  m=s.match(/^(\d{1,2})[.\/]\s*(\d{1,2})[.\/]\s*(\d{4})$/);
  return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:null;
}

function addMonthsISO(iso, months) {
  const base = iso ? new Date(`${iso}T12:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const originalDay = base.getDate();
  base.setDate(1);
  base.setMonth(base.getMonth() + months);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  base.setDate(Math.min(originalDay, lastDay));
  return `${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,'0')}-${String(base.getDate()).padStart(2,'0')}`;
}
function automaticProbationEnd(hireDate, role) {
  return addMonthsISO(hireDate, ['manager','management','hr_manager'].includes(role) ? 6 : 3);
}

function normRole(v) {
  const raw=key(v);
  if(!raw) return 'user';
  return ROLE_MAP.get(raw) || null;
}
function parseWorkbook(buffer) {
  const wb=XLSX.read(buffer,{type:'buffer',cellDates:false,raw:true});
  const ws=wb.Sheets[wb.SheetNames[0]];
  const matrix=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:true});
  if(!matrix.length) return {headers:[],rows:[]};
  return {headers:matrix[0].map(clean),rows:matrix.slice(1).filter(r=>r.some(v=>clean(v)))};
}
function columnMap(headers){
  const map={};
  for(const [field,names] of Object.entries(aliases)){
    const i=headers.findIndex(h=>names.includes(key(h))); if(i>=0)map[field]=i;
  }
  return map;
}
function analyze(headers, rows){
  const map=columnMap(headers), errors=[];
  if(map.name===undefined) errors.push('Не знайдено колонку «ПІБ»');
  if(map.email===undefined) errors.push('Не знайдено колонку «Пошта»');
  const seen=new Set();
  const normalized=rows.map((r,idx)=>{
    const get=f=>map[f]===undefined?'':r[map[f]];
    const name=clean(get('name')), email=clean(get('email')).toLowerCase();
    const rowErrors=[];
    if(!name)rowErrors.push('не вказано ПІБ');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))rowErrors.push('некоректна пошта');
    if(email&&seen.has(email))rowErrors.push('дубль пошти у файлі'); seen.add(email);
    const bday=normDate(get('bday')),hire=normDate(get('hire'));
    if(clean(get('bday'))&&!bday)rowErrors.push('некоректна дата народження');
    if(clean(get('hire'))&&!hire)rowErrors.push('некоректна дата найму');
    const role=normRole(get('role'));
    if(!role) rowErrors.push('невідома роль у системі');
    // Кінець випробувального строку не заповнюється у файлі:
    // система автоматично рахує 3 місяці, а для керівника / Керівника-HR — 6 місяців.
    const effectiveHire=hire || new Date().toISOString().slice(0,10);
    const prob=automaticProbationEnd(effectiveHire, role || 'user');
    let vacation=clean(get('vacation'))===''?24:Number(String(get('vacation')).replace(',','.'));
    if(!Number.isInteger(vacation)||vacation < -365||vacation>365){rowErrors.push('некоректний залишок відпустки');vacation=24;}
    return {
      row:idx+2,name,email,pos:clean(get('pos'))||'—',
      pos_official:clean(get('posOfficial'))||clean(get('pos'))||'—',dept:clean(get('dept'))||'—',
      role:role||'user',manager_email:clean(get('manager')).toLowerCase(),bday,hire_date:hire,
      prob_end:prob,vacation_days:vacation,errors:rowErrors
    };
  });
  return {headers,expected:EXPECTED,errors,rows:normalized,valid:normalized.filter(r=>!r.errors.length),invalid:normalized.filter(r=>r.errors.length)};
}
async function readUpload(req){
  const file=await req.file(); if(!file)return null;
  return {buffer:await file.toBuffer(),filename:file.filename||''};
}
async function enrichReport(report){
  const fileEmails=new Set(report.rows.map(r=>r.email).filter(Boolean));
  const managerEmails=[...new Set(report.rows.map(r=>r.manager_email).filter(Boolean))];
  const knownManagers=managerEmails.length
    ?(await q('SELECT lower(email) email FROM employees WHERE lower(email)=ANY($1) AND term_date IS NULL',[managerEmails])).rows.map(x=>x.email)
    :[];
  const managerSet=new Set([...knownManagers,...fileEmails]);
  report.rows.forEach(r=>{if(r.manager_email&&!managerSet.has(r.manager_email))r.errors.push('керівника з такою поштою не знайдено');});
  report.valid=report.rows.filter(r=>!r.errors.length); report.invalid=report.rows.filter(r=>r.errors.length);
  const emails=report.valid.map(r=>r.email);
  const existingRows=emails.length?(await q('SELECT lower(email) email, term_date FROM employees WHERE lower(email)=ANY($1)',[emails])).rows:[];
  const existing=new Map(existingRows.map(x=>[x.email,Boolean(x.term_date)]));
  report.rows.forEach(r=>{
    if(r.errors.length) r.action='skip';
    else if(!existing.has(r.email)) r.action='create';
    else r.action=existing.get(r.email)?'reactivate':'update';
  });
  return report;
}

export default async function(app){
  app.addHook('preHandler',requireAuth);

  app.post('/api/import/employees/preview',async(req,reply)=>{
    if(!(await hasAccess(req.user,'employees','full')))return reply.code(403).send({error:'Потрібен повний доступ до розділу «Співробітники»'});
    const up=await readUpload(req); if(!up)return reply.code(400).send({error:'Додайте Excel або CSV-файл'});
    try{
      const parsed=parseWorkbook(up.buffer), report=await enrichReport(analyze(parsed.headers,parsed.rows));
      return {...report,summary:{
        total:report.rows.length,valid:report.valid.length,invalid:report.invalid.length,
        create:report.rows.filter(r=>r.action==='create').length,
        update:report.rows.filter(r=>r.action==='update').length,
        reactivate:report.rows.filter(r=>r.action==='reactivate').length
      }};
    }catch(e){req.log.error(e);return reply.code(400).send({error:'Не вдалося прочитати файл. Використайте .xlsx, .xls або .csv'});}
  });

  app.post('/api/import/employees/commit',async(req,reply)=>{
    if(!(await hasAccess(req.user,'employees','full')))return reply.code(403).send({error:'Потрібен повний доступ до розділу «Співробітники»'});
    const up=await readUpload(req); if(!up)return reply.code(400).send({error:'Додайте файл повторно для підтвердження імпорту'});
    const parsed=parseWorkbook(up.buffer), report=await enrichReport(analyze(parsed.headers,parsed.rows));
    if(report.errors.length||report.invalid.length)return reply.code(400).send({error:'У файлі є помилки. Виправте їх перед імпортом.',report});
    const result=await withCtx(req.user,async c=>{
      let created=0,updated=0,reactivated=0; const relations=[];
      for(const r of report.valid){
        const ex=(await c.query('SELECT id,term_date,password_hash FROM employees WHERE lower(email)=$1 FOR UPDATE',[r.email])).rows[0];
        if(ex){
          const wasInactive=Boolean(ex.term_date);
          await c.query(`UPDATE employees SET
              name=$1,pos=$2,pos_official=$3,dept=$4,role=$5,
              bday=COALESCE($6,bday),hire_date=COALESCE($7,hire_date),prob_end=$8,vacation_days=$9,
              term_date=NULL,presence='none',failed_logins=0,locked_until=NULL,
              activation=CASE WHEN password_hash IS NULL THEN 'invited'::activation_status ELSE 'active'::activation_status END
            WHERE id=$10`,
            [r.name,r.pos,r.pos_official,r.dept,r.role,r.bday,r.hire_date,r.prob_end,r.vacation_days,ex.id]);
          relations.push({id:ex.id,manager_email:r.manager_email});
          if(wasInactive) reactivated++; else updated++;
        }else{
          const id=(await c.query(`INSERT INTO employees(name,email,pos,pos_official,dept,bday,hire_date,prob_end,vacation_days,role,activation,vacation_accrual_start)
            VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,current_date),$8,$9,$10,'invited',COALESCE($7,current_date)) RETURNING id`,
            [r.name,r.email,r.pos,r.pos_official,r.dept,r.bday,r.hire_date,r.prob_end,r.vacation_days,r.role])).rows[0].id;
          relations.push({id,manager_email:r.manager_email});created++;
        }
      }
      for(const rel of relations){
        let managerId=null;
        if(rel.manager_email)managerId=(await c.query('SELECT id FROM employees WHERE lower(email)=$1 AND term_date IS NULL',[rel.manager_email])).rows[0]?.id||null;
        if(managerId===rel.id) throw Object.assign(new Error('Співробітник не може бути власним керівником'),{statusCode:400});
        await c.query('UPDATE employees SET manager_id=$1 WHERE id=$2',[managerId,rel.id]);
      }
      // Автоматичне підвищення ролі лише там, де це безпечно:
      // звичайний співробітник → керівник; HR → Керівник / HR.
      await c.query(`UPDATE employees SET role='manager'
                     WHERE role='user' AND term_date IS NULL
                       AND id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL)`);
      await c.query(`UPDATE employees SET role='hr_manager'
                     WHERE role='hr' AND term_date IS NULL
                       AND id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL)`);
      await audit(req.user.id,'import.employees','employees',null,{created,updated,reactivated,total:report.valid.length},c);
      return {created,updated,reactivated,total:report.valid.length};
    });
    return {...result,invitations_sent:0};
  });
}
