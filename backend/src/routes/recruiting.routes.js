import { q } from '../db.js';
import { requireAuth, hasAccess } from '../auth.js';
import { audit } from './employees.routes.js';
import { askAI, AiDisabledError } from '../ai.js';
import { extractCvText } from '../cv-extract.js';

const text=v=>String(v??'').trim();
const stages=new Set(['Новий','Скринінг','Співбесіда','Оффер','Найнято','Відмова']);

export default async function(app){
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', async(req,reply)=>{
    if(req.method==='GET'){
      const allowed=(await hasAccess(req.user,'recruiting','view')) || (await hasAccess(req.user,'analytics','view'));
      if(!allowed) return reply.code(403).send({error:'Немає доступу до рекрутингу'});
      return;
    }
    if(!(await hasAccess(req.user,'recruiting','edit'))) return reply.code(403).send({error:'Немає прав на зміну рекрутингу'});
  });

  app.get('/api/vacancies', async()=> (await q('SELECT id,title,dept,description,opened_at,closed_at FROM vacancies ORDER BY opened_at DESC,title')).rows);
  app.post('/api/vacancies', async(req,reply)=>{
    const title=text(req.body?.title),dept=text(req.body?.dept)||'—',description=text(req.body?.description);
    if(!title) return reply.code(400).send({error:'Додайте назву вакансії'});
    const row=(await q('INSERT INTO vacancies(title,dept,description) VALUES($1,$2,$3) RETURNING *',[title,dept,description])).rows[0];
    await audit(req.user.id,'vacancy.create','vacancy',row.id,{title,dept});
    return reply.code(201).send(row);
  });
  app.patch('/api/vacancies/:id', async(req,reply)=>{
    const title=req.body?.title===undefined?null:text(req.body.title);
    const dept=req.body?.dept===undefined?null:text(req.body.dept);
    const description=req.body?.description===undefined?null:text(req.body.description);
    const close=req.body?.closed===true, reopen=req.body?.closed===false;
    const row=(await q(`UPDATE vacancies SET
      title=COALESCE($2,title),dept=COALESCE($3,dept),description=COALESCE($6,description),
      closed_at=CASE WHEN $4 THEN current_date WHEN $5 THEN NULL ELSE closed_at END
      WHERE id=$1 RETURNING *`,[req.params.id,title,dept,close,reopen,description])).rows[0];
    if(!row) return reply.code(404).send({error:'Вакансію не знайдено'});
    await audit(req.user.id,'vacancy.update','vacancy',row.id,{title,dept,close,reopen});
    return row;
  });
  app.delete('/api/vacancies/:id', async(req,reply)=>{
    const used=(await q('SELECT count(*)::int n FROM candidates WHERE vacancy_id=$1',[req.params.id])).rows[0].n;
    if(used) return reply.code(409).send({error:'Спочатку видаліть або перенесіть кандидатів цієї вакансії'});
    await q('DELETE FROM vacancies WHERE id=$1',[req.params.id]);
    await audit(req.user.id,'vacancy.delete','vacancy',req.params.id,{});
    return {ok:true};
  });

  app.get('/api/candidates', async()=> (await q(`SELECT id,vacancy_id,name,email,phone,source,stage,cv_name,cv_mime,
    octet_length(cv_data) cv_size,notes,ai_review,ai_reviewed_at,created_at FROM candidates ORDER BY created_at DESC`)).rows);
  app.get('/api/candidates/:id/file', async(req,reply)=>{
    const c=(await q('SELECT cv_name,cv_mime,cv_data FROM candidates WHERE id=$1',[req.params.id])).rows[0];
    if(!c?.cv_data) return reply.code(404).send({error:'CV не прикріплено'});
    reply.header('Content-Type',c.cv_mime||'application/octet-stream');
    reply.header('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(c.cv_name||'cv')}`);
    reply.header('X-Content-Type-Options','nosniff');
    return reply.send(c.cv_data);
  });
  app.post('/api/candidates', async(req,reply)=>{
    let data={},cvName=null,cvMime=null,cvData=null;
    if(req.isMultipart()){
      for await(const part of req.parts()){
        if(part.type==='file'){cvData=await part.toBuffer();cvName=part.filename;cvMime=part.mimetype;}
        else data[part.fieldname]=part.value;
      }
    } else data=req.body||{};
    const name=text(data.name),stage=stages.has(data.stage)?data.stage:'Новий';
    if(!name) return reply.code(400).send({error:'Додайте ПІБ кандидата'});
    const row=(await q(`INSERT INTO candidates(vacancy_id,name,email,phone,source,stage,cv_name,cv_mime,cv_data,notes)
      VALUES(NULLIF($1,'')::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[
      data.vacancy_id||'',name,text(data.email)||null,text(data.phone)||null,text(data.source)||null,stage,cvName,cvMime,cvData,text(data.notes)||null])).rows[0];
    await audit(req.user.id,'candidate.create','candidate',row.id,{name});
    return reply.code(201).send({id:row.id});
  });
  app.patch('/api/candidates/:id', async(req,reply)=>{
    let data={},cvName,cvMime,cvData;
    if(req.isMultipart()){
      for await(const part of req.parts()){
        if(part.type==='file'){cvData=await part.toBuffer();cvName=part.filename;cvMime=part.mimetype;}
        else data[part.fieldname]=part.value;
      }
    } else data=req.body||{};
    if(data.stage && !stages.has(data.stage)) return reply.code(400).send({error:'Некоректний етап'});
    const row=(await q(`UPDATE candidates SET
      vacancy_id=CASE WHEN $2::text IS NULL THEN vacancy_id ELSE NULLIF($2,'')::uuid END,
      name=COALESCE(NULLIF($3,''),name),email=CASE WHEN $4::text IS NULL THEN email ELSE NULLIF($4,'') END,
      phone=CASE WHEN $5::text IS NULL THEN phone ELSE NULLIF($5,'') END,
      source=CASE WHEN $6::text IS NULL THEN source ELSE NULLIF($6,'') END,
      stage=COALESCE(NULLIF($7,''),stage),notes=CASE WHEN $8::text IS NULL THEN notes ELSE NULLIF($8,'') END,
      cv_name=COALESCE($9,cv_name),cv_mime=COALESCE($10,cv_mime),cv_data=COALESCE($11,cv_data)
      WHERE id=$1 RETURNING id`,[req.params.id,data.vacancy_id??null,text(data.name),data.email===undefined?null:text(data.email),data.phone===undefined?null:text(data.phone),data.source===undefined?null:text(data.source),data.stage||null,data.notes===undefined?null:text(data.notes),cvName||null,cvMime||null,cvData||null])).rows[0];
    if(!row) return reply.code(404).send({error:'Кандидата не знайдено'});
    await audit(req.user.id,'candidate.update','candidate',row.id,{stage:data.stage});
    return {ok:true};
  });
  app.delete('/api/candidates/:id', async(req)=>{await q('DELETE FROM candidates WHERE id=$1',[req.params.id]);await audit(req.user.id,'candidate.delete','candidate',req.params.id,{});return {ok:true};});

  // ШІ-оцінка резюме кандидата відносно вакансії (окремо від /api/ai/chat,
  // бо тут потрібен доступ до розділу «Рекрутинг», а не просто авторизація).
  app.post('/api/candidates/:id/ai-review', async(req,reply)=>{
    const c=(await q('SELECT * FROM candidates WHERE id=$1',[req.params.id])).rows[0];
    if(!c) return reply.code(404).send({error:'Кандидата не знайдено'});
    if(!c.cv_data) return reply.code(400).send({error:'У кандидата немає прикріпленого резюме'});
    const vac=c.vacancy_id?(await q('SELECT title,dept,description FROM vacancies WHERE id=$1',[c.vacancy_id])).rows[0]:null;
    let cvText;
    try{ cvText=await extractCvText(c.cv_data,c.cv_mime,c.cv_name); }
    catch(e){ req.log.error(e); return reply.code(422).send({error:'Не вдалося прочитати файл резюме.'}); }
    if(cvText===null) return reply.code(415).send({error:'Формат резюме поки не підтримується для аналізу (підтримуються PDF, DOCX, TXT).'});
    if(!cvText) return reply.code(422).send({error:'У файлі резюме не знайдено тексту (можливо, це скановане зображення).'});

    const vacInfo = vac
      ? `Вакансія: ${vac.title} (відділ: ${vac.dept}).\nОпис/вимоги вакансії: ${vac.description||'не вказано'}.`
      : 'Вакансія кандидата не вказана — оціни резюме загалом, зазначивши, для яких напрямів воно виглядає сильним.';
    const prompt = `${vacInfo}\n\nРезюме кандидата (${c.name}):\n${cvText}\n\nОціни відповідність кандидата вакансії. Дай відповідь українською у форматі:\n**Відповідність:** X/10\n**Сильні сторони:** ...\n**Слабкі сторони/ризики:** ...\n**Рекомендація:** (запросити на співбесіду / розглянути з застереженнями / відмовити) — коротке обґрунтування.`;

    let reviewText;
    try{
      reviewText=await askAI({
        system:'Ти — асистент рекрутера. Аналізуєш резюме кандидатів об’єктивно, стисло, без вигаданих фактів про кандидата, лише на основі наданого тексту резюме.',
        messages:[{role:'user',content:prompt}],
        maxTokens:Number(process.env.AI_REVIEW_MAX_TOKENS)||3600,
      });
    }catch(e){
      if(e instanceof AiDisabledError) return reply.code(503).send({error:e.message,code:e.code});
      req.log.error(e);
      return reply.code(502).send({error:'ШІ-помічник тимчасово недоступний. Спробуйте пізніше.'});
    }

    const row=(await q('UPDATE candidates SET ai_review=$1,ai_reviewed_at=now() WHERE id=$2 RETURNING ai_review,ai_reviewed_at',[reviewText,c.id])).rows[0];
    await audit(req.user.id,'candidate.ai_review','candidate',c.id,{});
    return row;
  });
}
