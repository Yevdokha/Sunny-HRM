import { q } from '../db.js';
import { requireAuth, hasAccess, hasExplicitAccess } from '../auth.js';
import { audit } from './employees.routes.js';

export default async function(app){
 app.addHook('preHandler',requireAuth);
 app.addHook('preHandler',async(req,reply)=>{
   if(req.url.startsWith('/api/onboarding-services')) return;
   if(req.url.startsWith('/api/onboarding-deleted')) return;
   const need=req.method==='GET'?'view':'edit';
   if(!(await hasAccess(req.user,'onboarding',need)))return reply.code(403).send({error:'Немає доступу до онбордингу'});
 });

 app.get('/api/onboarding',async(req)=>{
   const params=[];let where='WHERE o.deleted_at IS NULL';
   const full=await hasAccess(req.user,'onboarding','full');
   const edit=await hasAccess(req.user,'onboarding','edit');
   const delegatedEdit=await hasExplicitAccess(req.user,'onboarding','edit');
   if(!full && !delegatedEdit){
     params.push(req.user.id);
     // Базове право керівника лишається scoped до підлеглих. Явно видане через «Видачу прав»
     // редагування онбордингу є делегованим правом і відкриває робочий реєстр повністю.
     where+=edit?' AND (o.employee_id=$1 OR e.manager_id=$1)':' AND o.employee_id=$1';
   }
   return (await q(`SELECT o.id,o.employee_id,o.kind,o.template,o.items,o.created_at,o.deleted_at FROM onboarding o JOIN employees e ON e.id=o.employee_id ${where} ORDER BY o.created_at DESC`,params)).rows;
 });

 app.post('/api/onboarding',async(req,reply)=>{
   const emp=req.body?.employee_id,kind=req.body?.kind==='offboarding'?'offboarding':'onboarding';
   const e=(await q('SELECT id,manager_id FROM employees WHERE id=$1',[emp])).rows[0];
   if(!e)return reply.code(404).send({error:'Співробітника не знайдено'});
   const full=await hasAccess(req.user,'onboarding','full');
   const delegatedEdit=await hasExplicitAccess(req.user,'onboarding','edit');
   if(!full&&!delegatedEdit&&e.manager_id!==req.user.id)return reply.code(403).send({error:'Можна створювати процес лише для свого підлеглого або за окремо виданим правом'});
   const defaults=kind==='onboarding'?['Видати техніку','Створити пошту та доступи','Знайомство з командою','Вступний інструктаж','Зустріч 1-на-1']:['Забрати техніку','Заблокувати доступи','Передати справи','Exit-інтерв’ю','Оформити документи'];
   const base=Array.isArray(req.body?.items)?req.body.items:defaults.map(t=>({t,done:false,type:'task'}));
   const serviceIds=Array.isArray(req.body?.service_ids)?req.body.service_ids:[];
   let services=[];
   if(kind==='onboarding'&&serviceIds.length){services=(await q('SELECT id,name FROM company_services WHERE id=ANY($1::uuid[]) AND active=true',[serviceIds])).rows;}
   const items=[...base,...services.map(s=>({t:s.name,done:false,type:'service',service_id:s.id}))];
   const row=(await q('INSERT INTO onboarding(employee_id,kind,template,items) VALUES($1,$2,$3,$4::jsonb) RETURNING *',[emp,kind,kind==='onboarding'?'Онбординг':'Офбординг',JSON.stringify(items)])).rows[0];
   await audit(req.user.id,'onboarding.create','onboarding',row.id,{kind,services:services.map(s=>s.name)});return reply.code(201).send(row);
 });

 app.patch('/api/onboarding/:id',async(req,reply)=>{
   const row=(await q(`SELECT o.*,e.manager_id FROM onboarding o JOIN employees e ON e.id=o.employee_id WHERE o.id=$1 AND o.deleted_at IS NULL`,[req.params.id])).rows[0];
   if(!row)return reply.code(404).send({error:'Процес не знайдено'});
   const full=await hasAccess(req.user,'onboarding','full');
   const delegatedEdit=await hasExplicitAccess(req.user,'onboarding','edit');
   if(!full&&!delegatedEdit&&row.manager_id!==req.user.id)return reply.code(403).send({error:'Немає доступу'});
   const items=Array.isArray(req.body?.items)?req.body.items:row.items;
   await q('UPDATE onboarding SET items=$2::jsonb WHERE id=$1',[req.params.id,JSON.stringify(items)]);
   await audit(req.user.id,'onboarding.update','onboarding',req.params.id,{});return {ok:true};
 });

 app.delete('/api/onboarding/:id',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_deleted','edit')))return reply.code(403).send({error:'Немає права видаляти процеси онбордингу/офбордингу'});
   const current=(await q(`SELECT o.id,o.kind,e.manager_id FROM onboarding o JOIN employees e ON e.id=o.employee_id WHERE o.id=$1 AND o.deleted_at IS NULL`,[req.params.id])).rows[0];
   if(!current)return reply.code(404).send({error:'Процес не знайдено'});
   const full=await hasAccess(req.user,'onboarding','full');
   const delegatedEdit=await hasExplicitAccess(req.user,'onboarding','edit');
   if(!full&&!delegatedEdit&&current.manager_id!==req.user.id)return reply.code(403).send({error:'Немає права видалити цей процес'});
   const row=(await q('UPDATE onboarding SET deleted_at=now(),deleted_by=$2 WHERE id=$1 RETURNING id,kind',[req.params.id,req.user.id])).rows[0];
   await audit(req.user.id,'onboarding.delete','onboarding',row.id,{kind:row.kind});return {ok:true};
 });

 app.get('/api/onboarding-deleted',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_deleted','view')))return reply.code(403).send({error:'Немає права переглядати видалені процеси'});
   return (await q(`SELECT o.*,e.name AS employee_name,e.dept,d.name AS deleted_by_name FROM onboarding o
      JOIN employees e ON e.id=o.employee_id LEFT JOIN employees d ON d.id=o.deleted_by
      WHERE o.deleted_at IS NOT NULL ORDER BY o.deleted_at DESC`)).rows;
 });

 app.post('/api/onboarding/:id/restore',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_deleted','full')))return reply.code(403).send({error:'Потрібен повний доступ до видалених процесів'});
   const row=(await q('UPDATE onboarding SET deleted_at=NULL,deleted_by=NULL WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id,kind',[req.params.id])).rows[0];
   if(!row)return reply.code(404).send({error:'Видалений процес не знайдено'});
   await audit(req.user.id,'onboarding.restore','onboarding',row.id,{kind:row.kind});return {ok:true};
 });

 app.get('/api/onboarding-services',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding','view')))return reply.code(403).send({error:'Немає доступу'});
   return (await q('SELECT * FROM company_services WHERE active=true ORDER BY name')).rows;
 });
 app.post('/api/onboarding-services',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_services','edit')))return reply.code(403).send({error:'Немає права керувати сервісами онбордингу'});
   const name=String(req.body?.name||'').trim();if(!name)return reply.code(400).send({error:'Вкажіть назву сервісу'});
   try{const row=(await q('INSERT INTO company_services(name,created_by) VALUES($1,$2) RETURNING *',[name,req.user.id])).rows[0];await audit(req.user.id,'onboarding.service.create','company_service',row.id,{name});return reply.code(201).send(row);}catch(e){if(e.code==='23505')return reply.code(409).send({error:'Такий сервіс уже є'});throw e;}
 });
 app.patch('/api/onboarding-services/:id',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_services','edit')))return reply.code(403).send({error:'Немає права керувати сервісами онбордингу'});
   const name=String(req.body?.name||'').trim();if(!name)return reply.code(400).send({error:'Вкажіть назву сервісу'});
   const row=(await q('UPDATE company_services SET name=$2 WHERE id=$1 AND active=true RETURNING *',[req.params.id,name])).rows[0];if(!row)return reply.code(404).send({error:'Сервіс не знайдено'});await audit(req.user.id,'onboarding.service.update','company_service',row.id,{name});return row;
 });
 app.delete('/api/onboarding-services/:id',async(req,reply)=>{
   if(!(await hasAccess(req.user,'onboarding_services','edit')))return reply.code(403).send({error:'Немає права керувати сервісами онбордингу'});
   const row=(await q('UPDATE company_services SET active=false WHERE id=$1 AND active=true RETURNING id,name',[req.params.id])).rows[0];if(!row)return reply.code(404).send({error:'Сервіс не знайдено'});await audit(req.user.id,'onboarding.service.delete','company_service',row.id,{name:row.name});return {ok:true};
 });
}
