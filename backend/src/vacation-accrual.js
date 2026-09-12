import { q, systemQ } from './db.js';

function daysInMonth(y,m){ return new Date(Date.UTC(y,m,0)).getUTCDate(); }
function pad(n){return String(n).padStart(2,'0');}
function iso(y,m,d){return `${y}-${pad(m)}-${pad(d)}`;}
function companionDay(hireDay, dim){
  // Для дат найму 15–31: число найму мінус 14 (25 -> 11, 31 -> 17).
  // Для 1–14 використовуємо симетричний другий цикл +14, щоб у кожному місяці
  // було рівно два нарахування і максимум 24 на рік (10 -> 10 і 24).
  const raw = hireDay > 14 ? hireDay - 14 : hireDay + 14;
  return Math.min(raw, dim);
}
function monthCursor(dateStr){
  const d=new Date(String(dateStr).slice(0,10)+'T00:00:00Z');
  return {y:d.getUTCFullYear(),m:d.getUTCMonth()+1};
}
function nextMonth({y,m}){return m===12?{y:y+1,m:1}:{y,m:m+1};}


export async function runVacationAccrualJob(log=console){
  const today=String((await q("SELECT current_date AS d")).rows[0].d).slice(0,10);
  const td=new Date(today+'T00:00:00Z');
  const ty=td.getUTCFullYear(),tm=td.getUTCMonth()+1;
  const {rows:emps}=await q(`SELECT id,name,hire_date,vacation_accrual_start,term_date FROM employees
    WHERE term_date IS NULL AND hire_date IS NOT NULL`);
  let added=0;
  for(const e of emps){
    const start=[String(e.hire_date).slice(0,10),String(e.vacation_accrual_start).slice(0,10)].sort().at(-1);
    if(start>today) continue;
    const hd=new Date(String(e.hire_date).slice(0,10)+'T00:00:00Z');
    const hireDom=hd.getUTCDate();
    let cur=monthCursor(start);
    while(cur.y<ty || (cur.y===ty && cur.m<=tm)){
      const dim=daysInMonth(cur.y,cur.m);
      const hireDay=Math.min(hireDom,dim);
      const due=[companionDay(hireDom,dim),hireDay].sort((a,b)=>a-b);
      // За місяць максимум два унікальні дні. Якщо для екзотичного календарного краю
      // вони збіглися, другий запис не створюємо.
      for(const dom of [...new Set(due)]){
        const accrualDate=iso(cur.y,cur.m,dom);
        if(accrualDate<start || accrualDate>today) continue;
        try{
          const ins=await q(`INSERT INTO vacation_accruals(employee_id,accrual_date,days,source,note)
            VALUES($1,$2,1,'automatic','Автоматичне нарахування') ON CONFLICT DO NOTHING RETURNING id`,[e.id,accrualDate]);
          if(ins.rowCount){
            await q('UPDATE employees SET vacation_days=vacation_days+1 WHERE id=$1',[e.id]);
            await systemQ(`INSERT INTO audit_log(actor_id,action,entity,entity_id,details) VALUES(NULL,'vacation.accrual.auto','employee',$1,$2)`,[e.id,{days:1,date:accrualDate}]);
            added++;
          }
        }catch(err){ log.error?.({err,employee:e.id,date:accrualDate},'vacation accrual failed'); }
      }
      cur=nextMonth(cur);
    }
  }
  log.info?.({added,date:today},'vacation accrual job complete');
}

export async function syncVacationPresence(log=console){
  try{
    // Відпустка визначається погодженими заявами. Старий ручний статус vacation
    // автоматично ставиться/знімається, щоб після останнього дня людина не лишалася «у відпустці».
    await q(`UPDATE employees e SET presence='vacation'
      WHERE e.term_date IS NULL AND EXISTS (
        SELECT 1 FROM requests r WHERE r.employee_id=e.id AND r.status='approved'
          AND r.start_date<=current_date AND r.end_date>=current_date
          AND r.type IN ('annual','unpaid'))`);
    await q(`UPDATE employees e SET presence='none'
      WHERE e.presence='vacation' AND NOT EXISTS (
        SELECT 1 FROM requests r WHERE r.employee_id=e.id AND r.status='approved'
          AND r.start_date<=current_date AND r.end_date>=current_date
          AND r.type IN ('annual','unpaid'))`);
  }catch(err){log.error?.(err,'vacation presence sync failed');}
}

export function startVacationJobs(log){
  const run=async()=>{await runVacationAccrualJob(log);await syncVacationPresence(log);};
  setTimeout(run,2500);
  setInterval(run,60*60*1000);
}
