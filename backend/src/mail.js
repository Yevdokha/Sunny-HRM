import nodemailer from 'nodemailer';
import { q } from './db.js';

const enabled = !!process.env.SMTP_HOST;
const authEnabled = !!process.env.SMTP_USER;
const transport = enabled ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  ...(authEnabled ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}),
}) : null;

async function record(status, detail='') {
  try { await q('INSERT INTO system_checks(component,status,detail) VALUES($1,$2,$3)', ['mail',status,detail]); } catch {}
}

async function send(to, subject, html) {
  if (!transport) {
    console.log(`[mail:DISABLED] → ${to} | ${subject}`);
    if(process.env.APP_ENV==='local') console.log(`[mail:LOCAL_PREVIEW] ${html}`);
    await record('warning','SMTP не налаштовано; лист не надіслано');
    return { disabled: true };
  }
  try {
    const result=await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
    await record('ok','Останній лист надіслано успішно');
    return result;
  } catch(e) {
    await record('error','Помилка SMTP: '+e.message);
    try { await q(`INSERT INTO security_alerts(alert_key,level,category,title,detail,metadata)
      VALUES($1,'critical','mail','Системні листи не надсилаються',$2,$3)
      ON CONFLICT DO NOTHING`,['mail:'+new Date().toISOString().slice(0,13),e.message,JSON.stringify({to})]); } catch {}
    throw e;
  }
}

const base = () => (process.env.APP_URL || 'https://hrm.sunny.ua').replace(/\/$/, '');
export const sendInvite = (to, name, token) => send(to,'Запрошення до HR-порталу Sunny Ukraine',
  `<p>Вітаємо, ${name}!</p><p>Для вас створено акаунт у HR-порталі.</p><p><a href="${base()}/activate?token=${token}">Активувати акаунт</a></p><p>Посилання дійсне 7 днів.</p>`);
export const sendReset = (to, name, token) => send(to,'Відновлення пароля — HR-портал Sunny',
  `<p>Вітаємо, ${name}!</p><p><a href="${base()}/reset?token=${token}">Задати новий пароль</a></p><p>Посилання дійсне 30 хв.</p>`);
export const sendProbationReminder = (to, recipientName, employeeName, probEnd) => send(
  to,
  'Завершення випробувального строку — HR-портал Sunny',
  `<p>Вітаємо, ${recipientName || ''}!</p><p>Через 10 днів, <strong>${String(probEnd).slice(0,10)}</strong>, завершується випробувальний строк співробітника: <strong>${employeeName}</strong>.</p><p>Будь ласка, заплануйте необхідні дії та зворотний зв’язок.</p>`
);
export const sendSecurityAlert = (subject, html) => process.env.SECURITY_ALERT_EMAIL ? send(process.env.SECURITY_ALERT_EMAIL,subject,html) : null;
