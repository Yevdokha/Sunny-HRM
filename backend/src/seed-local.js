import bcrypt from 'bcrypt';
import { q } from './db.js';

// Лише для docker-compose.local.yml. У production DEMO_SEED не встановлюється.
export async function seedLocalDemo(log=console){
  const hash=await bcrypt.hash('1',10);
  const emps=[
    {name:'Олена Гриценко',email:'management@sunny.ua',pos:'Операційна директорка',dept:'Управління',role:'management',mgr:null,bday:'1987-03-11',hire:'2018-04-02'},
    {name:'Євгенія Новікова',email:'y.novikova@sunny.ua',pos:'Head of HR',dept:'HR',role:'hr_manager',mgr:'management@sunny.ua',bday:'1988-01-01',hire:'2020-01-15'},
    {name:'Єва Логвінова',email:'y.lohvinova@sunny.ua',pos:'Junior IT & Data Specialist',dept:'IT',role:'admin',mgr:'y.novikova@sunny.ua',bday:'1999-01-01',hire:'2023-06-01'},
    {name:'Андрій Мельник',email:'a.melnyk@sunny.ua',pos:'Керівник редакційного відділу',dept:'Редакція',role:'manager',mgr:'y.novikova@sunny.ua',bday:'1986-02-14',hire:'2019-05-20'},
    {name:'Наталія Ковальчук',email:'n.kovalchuk@sunny.ua',pos:'HR-менеджер',dept:'HR',role:'hr',mgr:'y.novikova@sunny.ua',bday:'1992-01-01',hire:'2021-03-01'},
    {name:'Світлана Сібелєва',email:'s.sibeleva@sunny.ua',pos:'Бухгалтер',dept:'Фінанси',role:'accountant',mgr:'y.novikova@sunny.ua',bday:'1990-07-09',hire:'2020-09-10'},
    {name:'Максим Іваненко',email:'m.ivanenko@sunny.ua',pos:'Журналіст',dept:'Редакція',role:'user',mgr:'a.melnyk@sunny.ua',bday:'1995-10-12',hire:'2022-04-25'}
  ];
  const ids=new Map();
  for(const e of emps){
    const mgrId=e.mgr?ids.get(e.mgr):null;
    const row=(await q(`INSERT INTO employees(name,email,pos,pos_official,dept,manager_id,bday,hire_date,vacation_days,role,activation,password_hash,failed_logins,locked_until,vacation_accrual_start,password_reset_required)
      VALUES($1,$2,$3,$3,$4,$5,$6,$7,24,$8,'active',$9,0,NULL,current_date+1,false)
      ON CONFLICT ((lower(email))) DO UPDATE SET
        name=EXCLUDED.name,pos=EXCLUDED.pos,pos_official=EXCLUDED.pos_official,dept=EXCLUDED.dept,
        manager_id=EXCLUDED.manager_id,bday=EXCLUDED.bday,role=EXCLUDED.role,activation='active',
        password_hash=EXCLUDED.password_hash,password_reset_required=false,term_date=NULL,failed_logins=0,locked_until=NULL
      RETURNING id`,[e.name,e.email,e.pos,e.dept,mgrId,e.bday,e.hire,e.role,hash])).rows[0];
    ids.set(e.email,row.id);
  }

  const demoPersonal=[
    ['m.ivanenko@sunny.ua','male','000000001','2022-01-10','0001','1234567890'],
    ['s.sibeleva@sunny.ua','female','000000002','2021-02-20','0002','1234567891'],
    ['n.kovalchuk@sunny.ua','female','000000003','2020-03-15','0003','1234567892']
  ];
  for(const [email,sex,num,issued,issuer,tax] of demoPersonal){
    await q(`INSERT INTO employee_personal_data(employee_id,sex,passport_type,passport_number,passport_issue_date,passport_issuer,tax_id)
      VALUES($1,$2,'id_card',$3,$4,$5,$6)
      ON CONFLICT(employee_id) DO UPDATE SET sex=EXCLUDED.sex`,
      [ids.get(email),sex,num,issued,issuer,tax]);
  }
  log.info?.('Локальні демоакаунти готові. Пароль: 1');
}
