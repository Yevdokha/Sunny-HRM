import { q } from './db.js';
import { sendProbationReminder } from './mail.js';

// Надсилає одне нагадування за 10 календарних днів до завершення випробувального.
// Керівник отримує нагадування про себе та про кожного прямого підлеглого.
export async function sendDueProbationReminders(log = console) {
  const { rows } = await q(`
    SELECT e.id AS employee_id, e.name AS employee_name, e.prob_end,
           CASE WHEN e.role IN ('manager','management','hr_manager','admin') THEN e.email ELSE m.email END AS recipient_email,
           CASE WHEN e.role IN ('manager','management','hr_manager','admin') THEN e.name ELSE m.name END AS recipient_name
    FROM employees e
    LEFT JOIN employees m ON m.id=e.manager_id AND m.term_date IS NULL
    WHERE e.term_date IS NULL
      AND e.prob_end = current_date + 10
      AND (e.role IN ('manager','management','hr_manager','admin') OR m.email IS NOT NULL)
  `);

  let sent = 0;
  for (const row of rows) {
    const reserved = await q(`
      INSERT INTO probation_notifications(employee_id,recipient_email,prob_end,notice_days)
      VALUES($1,$2,$3,10)
      ON CONFLICT DO NOTHING
      RETURNING id`, [row.employee_id, row.recipient_email, row.prob_end]);
    if (!reserved.rowCount) continue;
    try {
      await sendProbationReminder(row.recipient_email, row.recipient_name, row.employee_name, row.prob_end);
      sent++;
    } catch (e) {
      await q('DELETE FROM probation_notifications WHERE id=$1', [reserved.rows[0].id]);
      log.error?.(e, '[probation] reminder failed');
    }
  }
  return { checked: rows.length, sent };
}

export function startProbationReminderJob(log = console) {
  const run = () => sendDueProbationReminders(log).catch(e => log.error?.(e, '[probation] job failed'));
  setTimeout(run, 5000);
  return setInterval(run, 6 * 60 * 60 * 1000);
}
