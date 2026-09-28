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
  // Special behavior: when a non-core goal activates with monthlyTarget, fund it, then continue priority routing.
  const eligible = [...goals].filter(g=>g.status!=='paused' && g.status!=='completed' && g.status!=='archived').sort((a,b)=>a.priority-b.priority);
  // Detect eligible monthly-target goals whose prerequisite is met.
  for (const g of eligible) {
    if (!g.monthlyTarget || remaining <= 0) continue;
    const bal = Number(balances[g.bucketId]||0);
    if (bal >= g.targetAmount) continue;
    if (g.prerequisiteGoalId) {
      const pg = goals.find(x=>x.id===g.prerequisiteGoalId);
      const pbal = pg ? Number(balances[pg.bucketId]||0) : 0;
      if (pbal < Number(g.prerequisiteAmount||0)) continue;
    }
    const amountForGoal = Math.min(remaining, Number(g.monthlyTarget), Number(g.targetAmount)-bal);
    if (amountForGoal > 0) {
      allocations.push({goalId:g.id,bucketId:g.bucketId,amount:amountForGoal,label:g.name});
      balances[g.bucketId]=(balances[g.bucketId]||0)+amountForGoal;
      remaining -= amountForGoal;
    }
  }
  while (remaining > 0.005) {
    const g = activeGoal(goals, balances);
    if (!g) {
      allocations.push({goalId:null,bucketId:'emergency',amount:remaining,label:'Unassigned Wealth'});
      remaining=0;break;
    }
    const bal = Number(balances[g.bucketId]||0);
    const room = Math.max(0, Number(g.targetAmount)-bal);
    if (!room) { balances[g.bucketId]=Number(g.targetAmount); continue; }
    const a = Math.min(remaining, room);
    allocations.push({goalId:g.id,bucketId:g.bucketId,amount:a,label:g.name});
    balances[g.bucketId]=(balances[g.bucketId]||0)+a;
    remaining -= a;
  }
  return allocations;
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
