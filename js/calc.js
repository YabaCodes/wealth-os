export const money = (n, currency='TWD') => {
  const v = Number(n || 0);
  if (currency === 'USD') return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(v);
  return `NT$${new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Math.round(v))}`;
};

export const pct = n => `${(Number(n||0)*100).toFixed(1)}%`;
export const monthIdFromDate = dateStr => dateStr.slice(0,7);
export const monthLabel = id => {
  if (!id) return '';
  const [y,m] = id.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(new Date(y,m-1,1));
};

export function buildBudgetPlan({income, categories, settings}) {
  const salary = Number(income || 0);
  let tithe = 0, fixed = 0, caps = 0, sinking = 0, buffer = 0;
  const lines = [];
  for (const c of categories.filter(x=>x.active).sort((a,b)=>(a.sort||0)-(b.sort||0))) {
    let amount = Number(c.defaultAmount || 0);
    if (c.ruleType === 'percentage') {
      amount = salary * (Number(c.defaultAmount||0)/100);
      tithe += amount;
    } else if (c.ruleType === 'fixed') fixed += amount;
    else if (c.ruleType === 'cap') caps += amount;
    else if (c.ruleType === 'sinking_contribution') sinking += amount;
    else if (c.ruleType === 'buffer') buffer += amount;
    lines.push({...c, budgetAmount: amount});
  }
  const assignedBeforeWealth = tithe + fixed + caps + sinking + buffer;
  const immediateWealth = salary - assignedBeforeWealth;
  return {salary,tithe,fixed,caps,sinking,buffer,assignedBeforeWealth,immediateWealth,lines};
}

export function activeGoal(goals, bucketBalances) {
  const ordered = [...goals].filter(g=>g.status!=='completed' && g.status!=='archived').sort((a,b)=>a.priority-b.priority);
  for (const g of ordered) {
    if (g.status === 'paused') continue;
    const bal = Number(bucketBalances[g.bucketId]||0);
    if (bal >= Number(g.targetAmount||Infinity)) continue;
    if (g.prerequisiteGoalId) {
      const pg = goals.find(x=>x.id===g.prerequisiteGoalId);
      const pbal = pg ? Number(bucketBalances[pg.bucketId]||0) : 0;
      if (pbal < Number(g.prerequisiteAmount||0)) continue;
    }
    return g;
  }
  return null;
}

export function allocateGoalSurplus({amount, goals, bucketBalances}) {
  let remaining = Math.max(0, Number(amount||0));
  const allocations = [];
  const balances = {...bucketBalances};
  const eligible = [...goals]
    .filter(g=>g.status!=='paused' && g.status!=='completed' && g.status!=='archived')
    .sort((a,b)=>a.priority-b.priority);

  // Planned-spending goals with a monthly target receive only that target once their prerequisite is met.
  // Any remaining wealth capacity continues toward core-wealth goals and, once those are full, investments.
  for (const g of eligible) {
    if (!g.monthlyTarget || remaining <= 0) continue;
    const bal = Number(balances[g.bucketId]||0);
    if (bal >= Number(g.targetAmount||0)) continue;
    if (g.prerequisiteGoalId) {
      const pg = goals.find(x=>x.id===g.prerequisiteGoalId);
      const pbal = pg ? Number(balances[pg.bucketId]||0) : 0;
      if (pbal < Number(g.prerequisiteAmount||0)) continue;
    }
    const amountForGoal = Math.min(remaining, Number(g.monthlyTarget), Number(g.targetAmount)-bal);
    if (amountForGoal > 0) {
      allocations.push({goalId:g.id,bucketId:g.bucketId,amount:amountForGoal,label:g.name,destination:'bucket'});
      balances[g.bucketId]=(balances[g.bucketId]||0)+amountForGoal;
      remaining -= amountForGoal;
    }
  }

  // Core-wealth goals receive the remaining capacity in priority order.
  for (const g of eligible.filter(g=>g.type==='core_wealth')) {
    if (remaining <= 0.005) break;
    const bal = Number(balances[g.bucketId]||0);
    const room = Math.max(0, Number(g.targetAmount||0)-bal);
    if (!room) continue;
    const a = Math.min(remaining, room);
    allocations.push({goalId:g.id,bucketId:g.bucketId,amount:a,label:g.name,destination:'bucket'});
    balances[g.bucketId]=(balances[g.bucketId]||0)+a;
    remaining -= a;
  }

  // Once core cash goals are complete, surplus becomes an investment contribution.
  if (remaining > 0.005) {
    allocations.push({goalId:null,bucketId:null,accountId:'ibkr',amount:remaining,label:'Investments',destination:'investment'});
  }
  return allocations;
}

export function simulateWealthStrategy({
  emergencyStart=0,
  travelStart=0,
  investmentStart=0,
  monthlyCapacity=0,
  annualReturn=0.07,
  emergencyUnlock=200000,
  emergencyTarget=300000,
  travelTarget=100000,
  travelMonthly=10000,
  months=600,
  milestones=[]
}) {
  let emergency=Math.max(0,Number(emergencyStart||0));
  let travel=Math.max(0,Number(travelStart||0));
  let investment=Math.max(0,Number(investmentStart||0));
  const capacity=Math.max(0,Number(monthlyCapacity||0));
  const r=Math.max(-0.99,Number(annualReturn||0))/12;
  const hits={};
  const events={travelUnlockMonth: emergency>=emergencyUnlock?0:null, emergencyCompleteMonth: emergency>=emergencyTarget?0:null, travelCompleteMonth: travel>=travelTarget?0:null};
  const snapshots=[];
  const orderedMilestones=[...milestones].sort((a,b)=>a-b);

  const recordHits=(m)=>{
    const core=emergency+investment;
    for(const t of orderedMilestones){ if(hits[t]===undefined && core>=t) hits[t]=m; }
    if(events.travelUnlockMonth===null && emergency>=emergencyUnlock) events.travelUnlockMonth=m;
    if(events.emergencyCompleteMonth===null && emergency>=emergencyTarget) events.emergencyCompleteMonth=m;
    if(events.travelCompleteMonth===null && travel>=travelTarget) events.travelCompleteMonth=m;
  };

  recordHits(0);
  for(let m=1;m<=months;m++){
    investment=Math.max(0,investment*(1+r));
    let available=capacity;

    if(emergency>=emergencyUnlock && travel<travelTarget && available>0){
      const toTravel=Math.min(available,travelMonthly,travelTarget-travel);
      travel+=toTravel;
      available-=toTravel;
    }

    if(emergency<emergencyTarget && available>0){
      const toEmergency=Math.min(available,emergencyTarget-emergency);
      emergency+=toEmergency;
      available-=toEmergency;
    }

    if(available>0) investment+=available;
    recordHits(m);
    if([12,36,60,120].includes(m)) snapshots.push({month:m,coreWealth:emergency+investment,emergency,travel,investment});
  }
  return {emergency,travel,investment,coreWealth:emergency+investment,hits,events,snapshots};
}


export function simulateWealthStrategyWithGrowth({
  emergencyStart=0,
  travelStart=0,
  investmentStart=0,
  monthlyCapacity=0,
  startingSalary=0,
  annualSalaryGrowth=0.03,
  raiseCaptureRate=0.75,
  annualReturn=0.07,
  emergencyUnlock=200000,
  emergencyTarget=300000,
  travelTarget=100000,
  travelMonthly=10000,
  months=600,
  milestones=[]
}) {
  let emergency=Math.max(0,Number(emergencyStart||0));
  let travel=Math.max(0,Number(travelStart||0));
  let investment=Math.max(0,Number(investmentStart||0));
  let capacity=Math.max(0,Number(monthlyCapacity||0));
  let salary=Math.max(0,Number(startingSalary||0));
  const salaryGrowth=Math.max(-0.99,Number(annualSalaryGrowth||0));
  const capture=Math.max(0,Math.min(1,Number(raiseCaptureRate||0)));
  const r=Math.max(-0.99,Number(annualReturn||0))/12;
  const hits={};
  const events={travelUnlockMonth: emergency>=emergencyUnlock?0:null, emergencyCompleteMonth: emergency>=emergencyTarget?0:null, travelCompleteMonth: travel>=travelTarget?0:null};
  const snapshots=[];
  const orderedMilestones=[...milestones].sort((a,b)=>a-b);

  const recordHits=(m)=>{
    const core=emergency+investment;
    for(const t of orderedMilestones){ if(hits[t]===undefined && core>=t) hits[t]=m; }
    if(events.travelUnlockMonth===null && emergency>=emergencyUnlock) events.travelUnlockMonth=m;
    if(events.emergencyCompleteMonth===null && emergency>=emergencyTarget) events.emergencyCompleteMonth=m;
    if(events.travelCompleteMonth===null && travel>=travelTarget) events.travelCompleteMonth=m;
  };

  recordHits(0);
  for(let m=1;m<=months;m++){
    if(m>1 && (m-1)%12===0 && salary>0){
      const nextSalary=salary*(1+salaryGrowth);
      const monthlyRaise=nextSalary-salary;
      capacity=Math.max(0,capacity+monthlyRaise*capture);
      salary=nextSalary;
    }
    investment=Math.max(0,investment*(1+r));
    let available=capacity;

    if(emergency>=emergencyUnlock && travel<travelTarget && available>0){
      const toTravel=Math.min(available,travelMonthly,travelTarget-travel);
      travel+=toTravel;
      available-=toTravel;
    }

    if(emergency<emergencyTarget && available>0){
      const toEmergency=Math.min(available,emergencyTarget-emergency);
      emergency+=toEmergency;
      available-=toEmergency;
    }

    if(available>0) investment+=available;
    recordHits(m);
    if([12,36,60,120].includes(m)) snapshots.push({month:m,coreWealth:emergency+investment,emergency,travel,investment,monthlyCapacity:capacity,salary});
  }
  return {emergency,travel,investment,coreWealth:emergency+investment,hits,events,snapshots,endingMonthlyCapacity:capacity,endingSalary:salary};
}

export function aggregateExpenses(expenses, periodId) {
  const out = {};
  for (const e of expenses.filter(x=>x.budgetPeriodId===periodId && !x.deletedAt)) {
    out[e.categoryId]=(out[e.categoryId]||0)+Number(e.amount||0);
  }
  return out;
}

export function budgetSummary({planLines, expenseTotals}) {
  return planLines.map(line=>{
    const actual = Number(expenseTotals[line.id]||0);
    const budget = Number(line.budgetAmount||0);
    return {...line, actual, remaining: budget-actual};
  });
}

export function calculateSweep({budgetLines, expenseTotals}) {
  let sweep = 0, deficit = 0;
  const eligible = budgetLines.filter(x=>['cap','buffer'].includes(x.ruleType));
  for (const line of eligible) {
    const rem = Number(line.budgetAmount||0)-Number(expenseTotals[line.id]||0);
    if (rem >= 0) sweep += rem; else deficit += Math.abs(rem);
  }
  return {grossUnused:sweep, deficits:deficit, available:Math.max(0,sweep-deficit), net:sweep-deficit};
}

export function forecastMonthsToTarget({start, monthly, annualReturn, target}) {
  start=Number(start||0);monthly=Number(monthly||0);target=Number(target||0);annualReturn=Number(annualReturn||0);
  if (start>=target) return 0;
  if (monthly<=0 && annualReturn<=0) return Infinity;
  const r=annualReturn/12;
  let value=start;
  for(let m=1;m<=1200;m++){
    value=value*(1+r)+monthly;
    if(value>=target)return m;
  }
  return Infinity;
}
