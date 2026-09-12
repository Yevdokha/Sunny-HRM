import pg from 'pg';
const { Pool } = pg;

// Робочий пул — під роллю застосунку (НЕсуперюзер → діє RLS).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '--client_encoding=UTF8 -c statement_timeout=15000 -c lock_timeout=5000',
  max: 20,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});


// Окремий службовий пул для технічних журналів і міграційних таблиць.
// Він не використовується для читання HR-даних користувачів і не обходить
// прикладні перевірки доступу; потрібен, щоб логи не губилися через RLS/GRANT
// у базах, створених попередніми версіями.
export const systemPool = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL,
  options: '--client_encoding=UTF8 -c statement_timeout=15000 -c lock_timeout=5000',
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
export const systemQ = (text, params) => systemPool.query(text, params);

// Простий запит (для не-RLS таблиць, напр. employees при вході).
export const q = (text, params) => pool.query(text, params);

// Запит у контексті залогіненого користувача — вмикає RLS-політики.
// Відкриває транзакцію, виставляє app.employee_id / app.role, і все всередині
// бачить лише дозволені рядки.
export async function withCtx(user, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.employee_id', $1, true)", [user?.id || '']);
    await client.query("SELECT set_config('app.role', $1, true)", [user?.role || 'user']);
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
