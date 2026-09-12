import { q } from '../db.js';
import { requireAuth, isHR, isManager, hasAccess } from '../auth.js';
import { audit } from './employees.routes.js';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const mgrOrHR = (u) => isHR(u) || isManager(u);
const text = (v) => String(v ?? '').trim();

export default async function (app) {
  app.addHook('preHandler', requireAuth);

  // ── Новини ────────────────────────────────────────────────────────────────
  app.get('/api/news', async () => {
    const { rows } = await q(`
      SELECT n.id,n.author_id,n.title,n.body,n.created_at,
             e.name AS author_name,e.pos AS author_pos
      FROM news n LEFT JOIN employees e ON e.id=n.author_id
      ORDER BY n.created_at DESC`);
    return rows;
  });

  app.post('/api/news', async (req, reply) => {
    if (!mgrOrHR(req.user)) return reply.code(403).send({ error: 'Новини публікують лише керівники та HR' });
    const title = text(req.body?.title), body = text(req.body?.body);
    if (!title) return reply.code(400).send({ error: 'Додайте заголовок' });
    const row = (await q(
      `INSERT INTO news(author_id,title,body) VALUES($1,$2,$3)
       RETURNING id,author_id,title,body,created_at`,
      [req.user.id, title, body])).rows[0];
    await audit(req.user.id, 'news.create', 'news', row.id, { title });
    return reply.code(201).send({ ...row, author_name: req.user.name, author_pos: req.user.pos });
  });

  // ── Опитування / eNPS ────────────────────────────────────────────────────
  app.get('/api/surveys', async (req) => {
    const { rows } = await q(`
      SELECT s.id,s.author_id,s.kind,s.question,s.options,s.created_at,
             e.name AS author_name,
             COALESCE(json_agg(json_build_object(
               'v',r.value,
               'by',CASE WHEN r.employee_id=$1 THEN r.employee_id::text ELSE NULL END
             ) ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL),'[]'::json) AS votes
      FROM surveys s
      LEFT JOIN employees e ON e.id=s.author_id
      LEFT JOIN survey_responses r ON r.survey_id=s.id
      GROUP BY s.id,e.name
      ORDER BY s.created_at DESC`, [req.user.id]);
    return rows;
  });

  app.post('/api/surveys', async (req, reply) => {
    if (!mgrOrHR(req.user)) return reply.code(403).send({ error: 'Опитування створюють лише керівники та HR' });
    const kind = req.body?.kind === 'enps' ? 'enps' : 'poll';
    const question = text(req.body?.question);
    const options = Array.isArray(req.body?.options) ? req.body.options.map(text).filter(Boolean) : [];
    if (!question) return reply.code(400).send({ error: 'Додайте питання' });
    if (kind === 'poll' && options.length < 2) return reply.code(400).send({ error: 'Потрібно щонайменше два варіанти' });
    const row = (await q(
      `INSERT INTO surveys(author_id,kind,question,options) VALUES($1,$2,$3,$4::jsonb)
       RETURNING id,author_id,kind,question,options,created_at`,
      [req.user.id, kind, question, JSON.stringify(kind === 'poll' ? options : [])])).rows[0];
    await audit(req.user.id, 'survey.create', 'survey', row.id, { kind });
    return reply.code(201).send({ ...row, author_name: req.user.name, votes: [] });
  });

  app.post('/api/surveys/:id/respond', async (req, reply) => {
    const survey = (await q('SELECT kind,options FROM surveys WHERE id=$1', [req.params.id])).rows[0];
    if (!survey) return reply.code(404).send({ error: 'Опитування не знайдено' });
    const value = Number(req.body?.value);
    const valid = survey.kind === 'enps'
      ? Number.isInteger(value) && value >= 0 && value <= 10
      : Number.isInteger(value) && value >= 0 && value < (survey.options?.length || 0);
    if (!valid) return reply.code(400).send({ error: 'Некоректний варіант відповіді' });
    await q(`INSERT INTO survey_responses(survey_id,employee_id,value) VALUES($1,$2,$3)
      ON CONFLICT (survey_id,employee_id) DO UPDATE SET value=EXCLUDED.value,created_at=now()`,
      [req.params.id, req.user.id, value]);
    return { ok: true, value };
  });

  // ── База знань ────────────────────────────────────────────────────────────
  app.get('/api/kb', async () =>
    (await q(`SELECT id,category,title,body,file_name,file_mime,
                     octet_length(file_data) AS file_size,updated_at
              FROM kb_docs ORDER BY category,title`)).rows);

  app.get('/api/kb/:id/file', async (req, reply) => {
    const d = (await q('SELECT file_name,file_mime,file_data FROM kb_docs WHERE id=$1', [req.params.id])).rows[0];
    if (!d?.file_data) return reply.code(404).send({ error: 'До документа не прикріплено файл' });
    reply.header('Content-Type', d.file_mime || 'application/octet-stream');
    const mode = req.query?.inline === '1' ? 'inline' : 'attachment';
    reply.header('Content-Disposition', `${mode}; filename*=UTF-8''${encodeURIComponent(d.file_name || 'document')}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(d.file_data);
  });

  // Серверний перегляд офісних форматів: LibreOffice перетворює їх у PDF.
  app.get('/api/kb/:id/render', async (req, reply) => {
    const d = (await q('SELECT file_name,file_mime,file_data FROM kb_docs WHERE id=$1', [req.params.id])).rows[0];
    if (!d?.file_data) return reply.code(404).send({ error: 'Файл не знайдено' });
    const ext = extname(d.file_name || '').toLowerCase();
    const convertible = new Set(['.doc','.docx','.odt','.rtf','.xls','.xlsx','.ods','.ppt','.pptx','.odp']);
    if (!convertible.has(ext)) return reply.code(415).send({ error: 'Формат не підтримує перетворення у PDF' });
    const dir = await mkdtemp(join(tmpdir(), 'hrm-preview-'));
    try {
      const input = join(dir, 'source' + ext);
      await writeFile(input, d.file_data);
      await execFileAsync('libreoffice', ['--headless','--nologo','--nodefault','--nolockcheck','--convert-to','pdf','--outdir',dir,input], { timeout: 30000 });
      const pdf = await readFile(join(dir, 'source.pdf'));
      reply.header('Content-Type','application/pdf');
      reply.header('Content-Disposition','inline; filename*=UTF-8\'\'' + encodeURIComponent((d.file_name || 'document').replace(/\.[^.]+$/, '') + '.pdf'));
      return reply.send(pdf);
    } catch (e) {
      req.log.error(e);
      return reply.code(422).send({ error: 'Не вдалося підготувати перегляд цього файлу' });
    } finally { await rm(dir, { recursive:true, force:true }); }
  });

  // Перегляд текстових файлів і DOCX без завантаження на комп'ютер.
  app.get('/api/kb/:id/preview', async (req, reply) => {
    const d = (await q('SELECT file_name,file_mime,file_data FROM kb_docs WHERE id=$1', [req.params.id])).rows[0];
    if (!d?.file_data) return reply.code(404).send({ error: 'До документа не прикріплено файл' });
    const name = String(d.file_name || '').toLowerCase();
    const mime = String(d.file_mime || '').toLowerCase();
    if (/\.(doc|docx|odt|rtf|xls|xlsx|ods|ppt|pptx|odp)$/.test(name)) {
      return { kind: 'pdf', url: `/api/kb/${req.params.id}/render` };
    }
    if (mime.startsWith('text/') || mime === 'application/json' || name.endsWith('.md') || name.endsWith('.csv')) {
      return { kind: 'text', text: d.file_data.toString('utf8') };
    }
    return reply.code(415).send({ error: 'Для цього формату доступне лише завантаження' });
  });

  app.post('/api/kb', async (req, reply) => {
    if (!(await hasAccess(req.user,'kb','edit'))) return reply.code(403).send({ error: 'Немає прав на редагування бази знань' });
    let category = 'Інше', title = '', body = '', fileName = null, fileMime = null, fileData = null;

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (buf.length > 6 * 1024 * 1024) return reply.code(413).send({ error: 'Файл перевищує 6 МБ' });
          fileName = part.filename || 'document'; fileMime = part.mimetype; fileData = buf;
        } else {
          if (part.fieldname === 'category') category = text(part.value) || 'Інше';
          if (part.fieldname === 'title') title = text(part.value);
          if (part.fieldname === 'body') body = text(part.value);
        }
      }
    } else {
      category = text(req.body?.category) || 'Інше'; title = text(req.body?.title); body = text(req.body?.body);
    }
    if (!title) return reply.code(400).send({ error: 'Додайте назву документа' });
    const row = (await q(`INSERT INTO kb_docs(category,title,body,file_name,file_mime,file_data,uploaded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,category,title,body,file_name,file_mime,octet_length(file_data) AS file_size,updated_at`,
      [category,title,body,fileName,fileMime,fileData,req.user.id])).rows[0];
    await audit(req.user.id, 'kb.create', 'kb_doc', row.id, { title, file: fileName });
    return reply.code(201).send(row);
  });

}
