import { runMigrations } from './migrate.js';
import { q } from './db.js';
const [email,name='Системний адміністратор'] = process.argv.slice(2);
if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
  console.error('Використання: node src/bootstrap-admin.js admin@example.com "ПІБ"'); process.exit(1);
}
await runMigrations();
const {rows}=await q(`INSERT INTO employees(name,email,pos,pos_official,dept,role,activation)
 VALUES($1,lower($2),'Системний адміністратор','Системний адміністратор','IT','admin','invited')
 ON CONFLICT ((lower(email))) DO UPDATE SET name=EXCLUDED.name,role='admin',term_date=NULL
 RETURNING id,email,name`,[name,email]);
console.log('Початковий адміністратор готовий:',rows[0]);
process.exit(0);
