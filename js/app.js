import { seedIfNeeded,getAll,getOne,put,bulkPut,remove,uid,exportData,importData,bucketBalances,accountBalances,wealthMetrics } from './db.js';
import { INCOME_TYPES } from './defaults.js';
import { money,pct,monthLabel,buildBudgetPlan,aggregateExpenses,budgetSummary,calculateSweep,allocateGoalSurplus,activeGoal,forecastMonthsToTarget } from './calc.js';

const root=document.querySelector('#app');
let tab='home';
let state={};
let modal=null;
let selectedPeriodId=null;
let activityFilter='all';

const today=()=>new Date().toISOString().slice(0,10);
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const nextMonthId=(dateStr)=>{const d=new Date(`${dateStr}T12:00:00`);return `${d.getFullYear()+(d.getMonth()===11?1:0)}-${String((d.getMonth()+1)%12+1).padStart(2,'0')}`;};

async function load(){
  await seedIfNeeded();
  const keys=['accounts','buckets','categories','goals','periods','incomes','expenses','transfers','transferAllocations','investmentSnapshots','reconciliations','adjustments','monthlyCloses'];
  const vals=await Promise.all(keys.map(getAll));
  keys.forEach((k,i)=>state[k]=vals[i]);
  state.settings=await getOne('settings','app');
  state.bucketBalances=await bucketBalances();
  state.accountBalances=await accountBalances();
  state.wealth=await wealthMetrics();
  const open=state.periods.filter(p=>p.state!=='closed').sort((a,b)=>b.id.localeCompare(a.id));
  const any=[...state.periods].sort((a,b)=>b.id.localeCompare(a.id));
  if(!selectedPeriodId) selectedPeriodId=(open[0]||any[0])?.id||null;
  render();
}

function currentPeriod(){return state.periods.find(p=>p.id===selectedPeriodId)||null;}
function periodRegularIncome(periodId){return state.incomes.filter(i=>i.budgetPeriodId===periodId&&!i.deletedAt&&i.incomeType==='regular_income').reduce((a,b)=>a+Number(b.amount),0);}
function periodEligibleIncome(periodId){return state.incomes.filter(i=>i.budgetPeriodId===periodId&&!i.deletedAt&&i.titheEligible).reduce((a,b)=>a+Number(b.amount),0);}
function planFor(periodId){
  const salary=periodRegularIncome(periodId);
  return buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});
}
function expenseTotals(periodId){return aggregateExpenses(state.expenses,periodId);}
function completedCoreWealth(periodId){
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&!t.deletedAt&&t.budgetPeriodId===periodId).map(t=>t.id));
  const coreBucketIds=new Set(state.buckets.filter(b=>b.countsTowardCoreWealth).map(b=>b.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&coreBucketIds.has(a.bucketId)).reduce((s,a)=>s+Number(a.amount),0);
}
function completedGoalFunding(periodId){
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&!t.deletedAt&&t.budgetPeriodId===periodId).map(t=>t.id));
  const sinkIds=new Set(state.buckets.filter(b=>['sinking_fund','operating_reserve'].includes(b.bucketType)).map(b=>b.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&sinkIds.has(a.bucketId)).reduce((s,a)=>s+Number(a.amount),0);
}
function physicalAccount(id){return state.accounts.find(a=>a.id===id);}
function bucket(id){return state.buckets.find(b=>b.id===id);}
function category(id){return state.categories.find(c=>c.id===id);}
function goal(id){return state.goals.find(g=>g.id===id);}
function totalExpenses(periodId){return state.expenses.filter(e=>e.budgetPeriodId===periodId&&!e.deletedAt).reduce((s,e)=>s+Number(e.amount),0);}
function sweepInfo(periodId){const plan=planFor(periodId),base=calculateSweep({budgetLines:plan.lines,expenseTotals:expenseTotals(periodId)});const reserved=state.transfers.filter(t=>!t.deletedAt&&t.budgetPeriodId===periodId&&t.transferType==='month_end_sweep'&&['planned','completed'].includes(t.status)).reduce((s,t)=>s+Number(t.amount||0),0);return {...base,alreadySwept:reserved,available:Math.max(0,base.available-reserved),netAfterSweep:base.net-reserved};}
function latestInvestmentTwd(){
  const snap=[...state.investmentSnapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1);
  if(!snap)return 0;return Number(snap.value)*Number(snap.fxRate||state.settings.usdTwdRate||1);
}
function goalBal(g){return Number(state.bucketBalances[g.bucketId]||0);}
function icon(name,extra=''){
  const paths={
    home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
    budget:'<circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/>',
    activity:'<path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>',
    goals:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    wealth:'<ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7M4 11v4c0 1.4 2.2 2.5 5 2.5 1.3 0 2.5-.25 3.4-.65"/><ellipse cx="16.5" cy="14.5" rx="3.5" ry="2"/><path d="M13 14.5v4c0 1.1 1.6 2 3.5 2s3.5-.9 3.5-2v-4"/>',
    forecast:'<path d="M3 18l6-6 4 4 7-9"/><path d="M16 7h4v4"/>',
    expense:'<path d="M12 4v13M7.5 12.5 12 17l4.5-4.5"/><path d="M5 20h14"/>',
    income:'<path d="M12 20V7M7.5 11.5 12 7l4.5 4.5"/><path d="M5 4h14"/>',
    transfer:'<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.36.31.7.6 1 .3.29.66.5 1.1.6h.1v4h-.1c-.44.1-.8.31-1.1.6-.29.3-.5.64-.6 1z"/>'
  };
  return `<svg class="ui-icon ${extra}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]||''}</svg>`;
}
function latestReconciliation(accountId){return [...state.reconciliations].filter(r=>r.accountId===accountId&&!r.deletedAt).sort((a,b)=>`${a.date||''}${a.createdAt||''}`.localeCompare(`${b.date||''}${b.createdAt||''}`)).at(-1)||null;}
function accountSnapshot(accountId){
  const expected=Number(state.accountBalances[accountId]||0);
  const rec=latestReconciliation(accountId);
  const actual=rec?Number(rec.actualBalance||0):expected;
  return {accountId,expected,actual,difference:actual-expected,verified:Boolean(rec),reconciliation:rec};
}
function esunSnapshot(){
  const base=accountSnapshot('esun');
  const virtualTotal=state.buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(state.bucketBalances[b.id]||0),0);
  const unassigned=base.actual-virtualTotal;
  return {...base,virtualTotal,unassigned,allocationOk:Math.abs(unassigned)<0.5,bankOk:Math.abs(base.difference)<0.5};
}
function completedAllocationToBucket(periodId,bucketId){
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&!t.deletedAt&&t.budgetPeriodId===periodId).map(t=>t.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&a.bucketId===bucketId).reduce((s,a)=>s+Number(a.amount||0),0);
}
function completedTithe(periodId){return completedAllocationToBucket(periodId,'tithe');}
function actualAccountValue(accountId){
  const a=physicalAccount(accountId); if(!a) return 0;
  if(a.role==='investment') return Number(state.accountBalances[accountId]||0);
  const snap=accountSnapshot(accountId); return snap.actual;
}

function shell(content){
  const footer=tab==='transactions'?'':'<p class="footer-note">Local-first financial planning. Transfers are not expenses; virtual buckets track purpose independently of bank balances.</p>';
  root.innerHTML=`<main class="shell">
    <header class="topbar"><div class="brand"><h1>Wealth OS</h1><p>Budget deliberately. Build wealth automatically.</p></div><button class="btn ghost small settings-btn" data-action="settings">${icon('settings')}<span>Settings</span></button></header>
    ${content}
    ${footer}
  </main>${nav()}${modal?renderModal():''}`;
  bind();
}
function nav(){
  const items=[['home','home','Home'],['budget','budget','Budget'],['transactions','activity','Activity'],['goals','goals','Goals'],['wealth','wealth','Wealth'],['forecast','forecast','Forecast']];
  return `<nav class="tabs"><div class="tabs-inner">${items.map(([id,ic,label])=>`<button class="tab ${tab===id?'active':''}" data-tab="${id}" aria-label="${label}"><span class="tab-icon">${icon(ic)}</span><span class="tab-label">${label}</span></button>`).join('')}</div></nav>`;
}

function periodSelector(){
  if(!state.periods.length) return '';
  return `<select id="period-select">${[...state.periods].sort((a,b)=>b.id.localeCompare(a.id)).map(p=>`<option value="${p.id}" ${p.id===selectedPeriodId?'selected':''}>${monthLabel(p.id)} · ${p.state.replaceAll('_',' ')}</option>`).join('')}</select>`;
}

function render(){
  if(tab==='home') return shell(homeView());
  if(tab==='budget') return shell(budgetView());
  if(tab==='transactions') return shell(transactionsView());
  if(tab==='goals') return shell(goalsView());
  if(tab==='wealth') return shell(wealthView());
  if(tab==='forecast') return shell(forecastView());
}

function homeView(){
  const p=currentPeriod();
  const active=activeGoal(state.goals,state.bucketBalances);
  const nonCore=state.wealth.financialNetWorth-state.wealth.coreWealth;
  if(!p){return `<section class="card hero-action"><div class="metric-label">Start here</div><div class="metric">Create your first funding month</div><p class="sub">Enter the exact paycheck that lands in your account. Wealth OS will allocate it using your rules.</p><button class="btn" data-action="new-paycheck">Enter Paycheck</button></section>${wealthStrip()}`;}
  const plan=planFor(p.id), spent=totalExpenses(p.id), core=completedCoreWealth(p.id), goalFunding=completedGoalFunding(p.id);
  const expTotals=expenseTotals(p.id);const sweep=sweepInfo(p.id);
  const pending=state.transfers.find(t=>t.budgetPeriodId===p.id&&t.status==='planned');
  let action=`<button class="btn" data-action="add-expense">Add Expense</button>`;
  let actionText='Keep the ledger current';let actionSub='Record spending as it happens.';
  if(pending){actionText=`Transfer ${money(pending.amount)} pending`;actionSub=`Move the money physically, then confirm it here.`;action=`<button class="btn" data-action="complete-transfer" data-id="${pending.id}">Mark Transfer Completed</button>`;}
  const em=goal('goal-emergency');const eb=em?goalBal(em):0;const ep=em?Math.min(1,eb/em.targetAmount):0;
  const food=plan.lines.find(x=>x.id==='food'), foodSpent=expTotals.food||0;
  const social=plan.lines.find(x=>x.id==='dating-social'), socialSpent=expTotals['dating-social']||0;
  return `<div class="split"><div><span class="tag">${monthLabel(p.id)}</span></div>${periodSelector()}</div>
  <div class="grid g3 summary-grid" style="margin-top:12px">
    <section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Long-term wealth base</div></section>
    <section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">All financial assets, tithe excluded</div></section>
    <section class="card"><div class="metric-label">Non-Core Funds</div><div class="metric">${money(nonCore)}</div><div class="sub">Operating cash + planned-use funds</div></section>
  </div>
  <section class="card" style="margin-top:14px"><div class="split"><div><div class="metric-label">Emergency Fund</div><strong>${money(eb)} / ${money(em?.targetAmount||300000)}</strong></div><span class="tag">${pct(ep)}</span></div><div class="progress"><span style="width:${Math.min(100,ep*100)}%"></span></div><div class="sub">Current wealth priority: ${esc(active?.name||'No active goal')}</div></section>
  <div class="grid g3" style="margin-top:14px">
    <section class="card"><div class="metric-label">Income</div><div class="metric">${money(plan.salary)}</div><div class="sub">Exact regular income entered</div></section>
    <section class="card"><div class="metric-label">Spent</div><div class="metric">${money(spent)}</div><div class="sub">Actual expenses only</div></section>
    <section class="card"><div class="metric-label">Wealth contributed</div><div class="metric">${money(core)}</div><div class="sub">Completed transfers to core wealth</div></section>
  </div>
  <div class="section-title"><h2>Flexible budget</h2><span class="sub">Projected month-end sweep ${money(sweep.available)}</span></div>
  <section class="card">${budgetMini('Food',food?.budgetAmount||0,foodSpent)}${budgetMini('Dating / Social',social?.budgetAmount||0,socialSpent)}</section>
  <div class="section-title"><h2>Next action</h2></div><section class="card hero-action"><div class="metric-label">${actionText}</div><div class="metric">${pending?money(pending.amount):money(sweep.available)}</div><p class="sub">${actionSub}</p>${action}</section>
  <div class="section-title"><h2>Monthly flow</h2></div><section class="card">
    ${row('Planned immediate wealth',money(Math.max(0,plan.immediateWealth)))}${row('Completed goal/reserve funding',money(goalFunding))}${row('Current sweep available',money(sweep.available))}
    <div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="add-income">Add Income</button><button class="btn secondary" data-action="month-close">Month-End Review</button></div>
  </section>`;
}

function budgetMini(name,budget,actual){const r=budget-actual;const u=budget?Math.min(1,actual/budget):0;return `<div class="row"><div style="flex:1"><strong>${name}</strong><div class="progress"><span style="width:${u*100}%"></span></div><div class="sub">${money(actual)} of ${money(budget)}</div></div><div class="amount ${r<0?'bad':''}">${money(r)} left</div></div>`;}
function row(label,value){return `<div class="row"><span>${label}</span><span class="amount">${value}</span></div>`;}
function wealthStrip(){
  const nonCore=state.wealth.financialNetWorth-state.wealth.coreWealth;
  return `<div class="grid g3 summary-grid" style="margin-top:14px"><section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Long-term wealth base</div></section><section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded</div></section><section class="card"><div class="metric-label">Non-Core Funds</div><div class="metric">${money(nonCore)}</div><div class="sub">Operating cash + planned-use funds</div></section></div>`;
}


function budgetView(){
  const p=currentPeriod();if(!p)return `<section class="card empty">Create a paycheck first.</section>`;
  const plan=planFor(p.id), totals=expenseTotals(p.id), lines=budgetSummary({planLines:plan.lines,expenseTotals:totals});
  const fixedActual=lines.filter(x=>x.ruleType==='fixed').reduce((s,x)=>s+Number(x.actual||0),0);
  const flexActual=lines.filter(x=>x.ruleType==='cap').reduce((s,x)=>s+Number(x.actual||0),0);
  const reserveFunded=lines.filter(x=>x.ruleType==='sinking_contribution').reduce((s,x)=>s+completedAllocationToBucket(p.id,x.bucketId),0);
  const titheAllocated=completedTithe(p.id);
  const wealthDone=completedCoreWealth(p.id);
  const sweep=sweepInfo(p.id);
  return `<div class="split"><div><h2 style="margin:0">Budget</h2><div class="sub">${monthLabel(p.id)} · Plan vs actual</div></div>${periodSelector()}</div>
  <div class="budget-overview" style="margin-top:14px">
    ${budgetKpi('Income',money(plan.salary),'Exact take-home')}
    ${budgetKpi('Fixed',`${money(fixedActual)} / ${money(plan.fixed)}`,`${money(Math.max(0,plan.fixed-fixedActual))} remaining`)}
    ${budgetKpi('Flexible',`${money(flexActual)} / ${money(plan.caps)}`,`${money(plan.caps-flexActual)} remaining`,flexActual>plan.caps)}
    ${budgetKpi('Reserves',`${money(reserveFunded)} / ${money(plan.sinking)}`,'Completed funding')}
    ${budgetKpi('Wealth',`${money(wealthDone)} / ${money(Math.max(0,plan.immediateWealth))}`,'Completed core-wealth transfers')}
    ${budgetKpi('Buffer',money(plan.buffer),`Projected sweep ${money(sweep.available)}`)}
  </div>
  <div class="section-title"><h2>Monthly flow</h2><span class="sub">What this paycheck is doing</span></div>
  <section class="card flow-card">
    ${row('Tithe',`${money(titheAllocated)} / ${money(plan.tithe)}`)}
    ${row('Fixed obligations',`${money(fixedActual)} / ${money(plan.fixed)}`)}
    ${row('Flexible spending',`${money(flexActual)} / ${money(plan.caps)}`)}
    ${row('Reserve funding',`${money(reserveFunded)} / ${money(plan.sinking)}`)}
    ${row('Operating buffer',money(plan.buffer))}
    ${row('Immediate wealth capacity',money(Math.max(0,plan.immediateWealth)))}
    ${row('Projected month-end sweep',money(sweep.available))}
  </section>
  ${budgetGroup('Fixed',lines,p.id)}
  ${budgetGroup('Flexible',lines,p.id)}
  ${budgetGroup('Reserve',lines,p.id)}
  ${budgetGroup('Giving',lines,p.id)}
  ${budgetGroup('Buffer',lines,p.id)}
  ${fundingMonthControls(p)}`;
}
function budgetKpi(label,value,sub,bad=false){return `<section class="card budget-kpi"><div class="metric-label">${label}</div><div class="kpi-value ${bad?'bad':''}">${value}</div><div class="sub">${sub}</div></section>`;}
function fundingMonthControls(p){
  const completed=state.transfers.filter(t=>!t.deletedAt&&t.budgetPeriodId===p.id&&t.status==='completed');
  const closed=p.state==='closed';
  const warning=closed?'Closed months cannot be deleted.':completed.length?`${completed.length} completed transfer${completed.length===1?'':'s'} must be resolved before this month can be deleted.`:'Use this to remove a test or mistaken funding month and all of its period-linked draft data.';
  return `<div class="section-title"><h2>Funding month controls</h2></div><section class="card danger-zone"><div class="split"><div><strong>Delete ${monthLabel(p.id)} funding month</strong><div class="sub">${warning}</div></div><button class="btn danger" data-action="delete-period" data-id="${p.id}" ${closed?'disabled':''}>Delete Month</button></div></section>`;
}

function budgetGroup(group,lines,periodId){
  const xs=lines.filter(x=>x.group===group);if(!xs.length)return'';
  return `<div class="section-title"><h2>${group}</h2></div><section class="card budget-category-list">${xs.map(x=>budgetCategoryRow(x,periodId)).join('')}</section>`;
}
function budgetCategoryRow(x,periodId){
  let actual=Number(x.actual||0), actualLabel='Spent';
  if(x.ruleType==='sinking_contribution'){actual=completedAllocationToBucket(periodId,x.bucketId);actualLabel='Funded';}
  if(x.ruleType==='percentage'){actual=completedTithe(periodId);actualLabel='Allocated';}
  if(x.ruleType==='buffer'){
    return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">Held for variability and month-end sweep</div></div><div class="budget-numbers"><strong>${money(x.budgetAmount)}</strong><span>planned</span></div></div><div class="progress"><span style="width:0%"></span></div></div>`;
  }
  const budget=Number(x.budgetAmount||0),remaining=budget-actual,ratio=budget?Math.max(0,Math.min(1,actual/budget)):0;
  return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">${actualLabel} ${money(actual)} · ${remaining>=0?`${money(remaining)} left`:`${money(Math.abs(remaining))} over`}</div></div><div class="budget-numbers"><strong class="${remaining<0?'bad':''}">${money(actual)} / ${money(budget)}</strong><span>${pct(ratio)}</span></div></div><div class="progress ${remaining<0?'over':''}"><span style="width:${Math.min(100,ratio*100)}%"></span></div></div>`;
}

function transactionsView(){
  const all=[
    ...state.expenses.filter(x=>!x.deletedAt).map(x=>({...x,_kind:'expense',_date:x.date,_amount:-Number(x.amount),_title:category(x.categoryId)?.name||'Expense',_account:physicalAccount(x.accountId)?.name||'',_detail:x.description||''})),
    ...state.incomes.filter(x=>!x.deletedAt).map(x=>({...x,_kind:'income',_date:x.dateReceived,_amount:Number(x.amount),_title:INCOME_TYPES.find(t=>t[0]===x.incomeType)?.[1]||'Income',_account:physicalAccount(x.accountId)?.name||'',_detail:x.description||''})),
    ...state.transfers.filter(x=>x.status==='completed'&&!x.deletedAt).map(x=>{const internal=x.fromAccountId===x.toAccountId;return {...x,_kind:'transfer',_date:x.completedDate||x.plannedDate,_amount:Number(x.amount||0),_title:internal?'E.SUN purpose allocation':`${physicalAccount(x.fromAccountId)?.name} → ${physicalAccount(x.toAccountId)?.name}`,_account:internal?'Virtual buckets':'Internal transfer',_detail:x.transferType==='bucket_allocation'?'Purpose allocation':(x.transferType||'transfer').replaceAll('_',' ')};} )
  ].sort((a,b)=>String(b._date).localeCompare(String(a._date))||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  const list=activityFilter==='all'?all:all.filter(x=>x._kind===activityFilter);
  return `<div><h2 style="margin:0">Activity</h2><div class="sub">Expenses, income and transfers</div></div>
  <div class="activity-actions">
    <button class="activity-action-card" data-action="add-expense"><span class="action-icon">${icon('expense')}</span><span class="action-copy"><strong>Add Expense</strong><span>Record money actually spent on goods, services or obligations.</span></span><span class="action-chevron">›</span></button>
    <button class="activity-action-card" data-action="add-income"><span class="action-icon">${icon('income')}</span><span class="action-copy"><strong>Add Income</strong><span>Salary, bonus, reimbursement, asset sale or other money received.</span></span><span class="action-chevron">›</span></button>
    <button class="activity-action-card" data-action="manual-transfer"><span class="action-icon">${icon('transfer')}</span><span class="action-copy"><strong>Add Transfer</strong><span>Move money between accounts or assign it to a virtual bucket.</span></span><span class="action-chevron">›</span></button>
  </div>
  <div class="section-title"><h2>Recent activity</h2><span class="sub">${list.length} shown</span></div>
  <div class="filter-chips">${[['all','All'],['expense','Expenses'],['income','Income'],['transfer','Transfers']].map(([id,label])=>`<button class="filter-chip ${activityFilter===id?'active':''}" data-action="activity-filter" data-filter="${id}">${label}</button>`).join('')}</div>
  <section class="card activity-list">${list.length?list.slice(0,150).map(txLine).join(''):`<div class="empty compact-empty"><strong>No ${activityFilter==='all'?'activity':activityFilter} yet.</strong><span>Entries matching this filter will appear here.</span></div>`}</section>`;
}
function txLine(x){
  const meta=[x._date,x._account,x._detail].filter(Boolean).join(' · ');
  const canEdit=x._kind!=='transfer'||['manual'].includes(x.transferType);
  const canDelete=x._kind!=='transfer'||['manual','bucket_allocation'].includes(x.transferType);
  const amount=x._kind==='transfer'?money(x._amount):money(x._amount);
  return `<div class="tx"><div class="tx-main"><div class="tx-title">${esc(x._title)}</div><div class="tx-meta">${esc(meta)}</div><div class="tx-actions">${canEdit?`<button class="text-btn" data-action="edit-transaction" data-kind="${x._kind}" data-id="${x.id}">Edit</button>`:''}${canDelete?`<button class="text-btn danger-text" data-action="delete-transaction" data-kind="${x._kind}" data-id="${x.id}">Delete</button>`:''}</div></div><div class="right"><div class="amount ${x._kind==='income'?'good':x._kind==='expense'?'bad':''}">${x._kind==='transfer'?'↔ ':''}${amount}</div><span class="tag">${x._kind}</span></div></div>`;
}

function goalsView(){return `<div><h2 style="margin:0">Goals</h2><div class="sub">Permanent wealth and planned spending stay separate.</div></div><div class="grid g2" style="margin-top:14px">${[...state.goals].sort((a,b)=>a.priority-b.priority).map(g=>{const b=goalBal(g),p=Math.min(1,b/g.targetAmount);let status=g.status;if(g.prerequisiteGoalId){const pg=goal(g.prerequisiteGoalId);if(pg&&goalBal(pg)<g.prerequisiteAmount)status=`waiting for ${money(g.prerequisiteAmount)} emergency threshold`;}return `<section class="card"><div class="split"><strong>${esc(g.name)}</strong><span class="tag">${esc(status)}</span></div><div class="metric">${money(b)}</div><div class="sub">of ${money(g.targetAmount)}</div><div class="progress"><span style="width:${p*100}%"></span></div>${g.targetDate?`<div class="sub">Target ${g.targetDate}</div>`:''}${g.monthlyTarget?`<div class="sub">Monthly target ${money(g.monthlyTarget)}</div>`:''}</section>`;}).join('')}</div>`;}

function wealthView(){
  const fx=state.settings.usdTwdRate;
  const ct=accountSnapshot('ctbc');
  const es=esunSnapshot();
  const ctStatus=!ct.verified?'Not checked':Math.abs(ct.difference)<0.5?'Reconciled':'Ledger mismatch';
  const ctStatusClass=!ct.verified?'':Math.abs(ct.difference)<0.5?' good-tag':' warn-tag';
  let esStatus='Not checked';let esStatusClass='';
  if(es.verified){
    if(es.bankOk&&es.allocationOk){esStatus='Fully reconciled';esStatusClass=' good-tag';}
    else if(!es.bankOk&&!es.allocationOk){esStatus='2 items to resolve';esStatusClass=' warn-tag';}
    else if(!es.bankOk){esStatus='Ledger mismatch';esStatusClass=' warn-tag';}
    else {esStatus='Allocation needed';esStatusClass=' warn-tag';}
  }
  const allocationText=es.allocationOk?'Complete':es.unassigned>0?`${money(es.unassigned)} unassigned`:`${money(Math.abs(es.unassigned))} over-allocated`;
  return `<div><h2 style="margin:0">Wealth</h2><div class="sub">Physical accounts and virtual purpose ledgers</div></div>
  <div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Long-term capital only</div></section><section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded</div></section></div>

  <div class="section-title"><h2>Account health</h2><span class="sub">Match Wealth OS to your banks</span></div>
  <section class="card account-health">
    ${accountHealthRow('CTBC Operating',ct.actual,ctStatus,ctStatusClass)}
    ${accountHealthRow('E.SUN Reserved',es.actual,esStatus,esStatusClass)}
    ${accountHealthRow('IBKR',latestInvestmentTwd(),'Portfolio value','')}
  </section>

  <div class="section-title"><h2>CTBC Operating</h2><span class="tag${ctStatusClass}">${ctStatus}</span></div>
  <section class="card account-detail-card">
    <div class="account-balance-head"><div><div class="metric-label">Latest bank balance</div><div class="metric">${money(ct.actual)}</div>${ct.verified?`<div class="sub">Checked ${esc(ct.reconciliation.date||'')}</div>`:`<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid two-col">
      <div><span class="sub">Ledger expected</span><strong>${money(ct.expected)}</strong></div>
      <div><span class="sub">Bank vs ledger</span><strong class="${Math.abs(ct.difference)<0.5?'good':ct.difference<0?'bad':'warn'}">${ct.difference>0?'+':''}${money(ct.difference)}</strong></div>
    </div>
    <div class="actions account-actions"><button class="btn secondary" data-action="account-reconcile" data-id="ctbc">Update Balance</button><button class="btn ghost" data-action="account-adjustment" data-id="ctbc">Add Adjustment</button></div>
  </section>

  <div class="section-title"><h2>E.SUN Reserved</h2><span class="tag${esStatusClass}">${esStatus}</span></div>
  <section class="card esun-card">
    <div class="account-balance-head"><div><div class="metric-label">Latest bank balance</div><div class="metric">${money(es.actual)}</div>${es.verified?`<div class="sub">Checked ${esc(es.reconciliation.date||'')}</div>`:`<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid">
      <div><span class="sub">Ledger expected</span><strong>${money(es.expected)}</strong></div>
      <div><span class="sub">Virtual allocated</span><strong>${money(es.virtualTotal)}</strong></div>
      <div><span class="sub">Bank reconciliation</span><strong class="${es.bankOk?'good':es.difference<0?'bad':'warn'}">${es.bankOk?'Matched':`${es.difference>0?'+':''}${money(es.difference)}`}</strong></div>
      <div><span class="sub">Purpose allocation</span><strong class="${es.allocationOk?'good':'warn'}">${allocationText}</strong></div>
    </div>
    ${!es.allocationOk?`<div class="allocation-callout"><div><strong>${es.unassigned>0?`${money(es.unassigned)} needs a purpose`:`Allocations exceed the bank balance by ${money(Math.abs(es.unassigned))}`}</strong><div class="sub">Assign or reduce virtual buckets explicitly. Wealth OS will never guess.</div></div><button class="btn" data-action="esun-allocate">${es.unassigned>0?'Assign Money':'Reduce Allocation'}</button></div>`:''}
    <div class="actions account-actions"><button class="btn secondary" data-action="account-reconcile" data-id="esun">Update Balance</button><button class="btn ghost" data-action="account-adjustment" data-id="esun">Add Adjustment</button></div>
  </section>
  <div class="section-title"><h2>E.SUN virtual composition</h2><span class="sub">Purpose ledger</span></div><section class="card">${state.buckets.filter(b=>b.accountId==='esun').map(b=>row(b.name,money(state.bucketBalances[b.id]||0))).join('')}<div class="row"><strong>Virtual total</strong><strong class="amount">${money(es.virtualTotal)}</strong></div>${!es.allocationOk?`<div class="row"><strong>${es.unassigned>0?'Unassigned':'Over-allocated'}</strong><strong class="amount ${es.unassigned<0?'bad':'warn'}">${es.unassigned>0?'+':''}${money(es.unassigned)}</strong></div>`:''}</section>
  <div class="section-title"><h2>Investments</h2></div><section class="card">${row('IBKR current value',money(latestInvestmentTwd()))}${row('USD/TWD rate',Number(fx).toFixed(2))}<div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="investment-snapshot">Update IBKR Value</button></div></section>`;
}
function accountHealthRow(name,value,status,statusClass=''){return `<div class="account-health-row"><div><strong>${esc(name)}</strong><div class="sub">${money(value)}</div></div><span class="tag${statusClass}">${esc(status)}</span></div>`;}


function forecastView(){
  const salary=Number(state.settings.forecastSalary||82500);const plan=buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});const monthly=Math.max(0,plan.immediateWealth);const start=state.wealth.coreWealth;const annual=.07;const targets=[1000000,3000000,5000000,10000000,30000000];
  return `<div><h2 style="margin:0">Forecast</h2><div class="sub">Illustrative planning assumptions, not guaranteed returns.</div></div><section class="card" style="margin-top:14px"><div class="form-grid"><div><div class="metric-label">Planning income</div><div class="metric">${money(salary)}</div></div><div><div class="metric-label">Monthly wealth capacity</div><div class="metric">${money(monthly)}</div></div></div><div class="sub">Uses your current rules and a 7% nominal annual return assumption for long-term scenarios.</div></section>
  <div class="section-title"><h2>Current path</h2></div><section class="card">${targets.map(t=>{const m=forecastMonthsToTarget({start,monthly,annualReturn:annual/12*12,target:t});const yrs=isFinite(m)?`${Math.floor(m/12)}y ${m%12}m`:'—';return row(money(t),yrs)}).join('')}</section>
  <div class="section-title"><h2>Scenario lab</h2></div><section class="card"><div class="notice">Use this to test a different take-home salary without changing your real budget.</div><div class="form-grid" style="margin-top:12px"><div class="field"><label>Take-home salary</label><input id="scenario-salary" type="number" value="120000"></div><div class="field"><label>Annual return assumption (%)</label><input id="scenario-return" type="number" step="0.1" value="7"></div></div><button class="btn" data-action="run-scenario">Run Scenario</button><div id="scenario-result" style="margin-top:12px"></div></section>`;
}

function renderModal(){
  if(modal.type==='paycheck') return modalWrap('New Paycheck',paycheckForm());
  if(modal.type==='expense') return modalWrap(modal.id?'Edit Expense':'Add Expense',expenseForm(modal.id?state.expenses.find(x=>x.id===modal.id):null));
  if(modal.type==='income') return modalWrap(modal.id?'Edit Income':'Add Income',incomeForm(modal.id?state.incomes.find(x=>x.id===modal.id):null));
  if(modal.type==='manual-transfer') return modalWrap(modal.id?'Edit Transfer':'Record Transfer',manualTransferForm(modal.id?state.transfers.find(x=>x.id===modal.id):null));
  if(modal.type==='transfer') return modalWrap('Confirm Transfer',transferConfirm(modal.id));
  if(modal.type==='close') return modalWrap('Month-End Review',monthCloseView());
  if(modal.type==='settings') return modalWrap('Settings',settingsView());
  if(modal.type==='investment') return modalWrap('Update IBKR Value',investmentForm());
  if(modal.type==='account-reconcile') return modalWrap(`Update ${physicalAccount(modal.accountId)?.name||'Account'} Balance`,accountReconciliationForm(modal.accountId));
  if(modal.type==='account-adjustment') return modalWrap(`Add ${physicalAccount(modal.accountId)?.name||'Account'} Adjustment`,accountAdjustmentForm(modal.accountId));
  if(modal.type==='esun-allocate') return modalWrap('Assign E.SUN Money',esunAllocationForm());
  if(modal.type==='delete-period') return modalWrap('Delete Funding Month',deleteFundingMonthView(modal.periodId));
  return '';
}
function modalWrap(title,body){return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" onclick="event.stopPropagation()"><div class="split"><h3>${title}</h3><button class="btn ghost small" data-action="close-modal">Close</button></div>${body}</section></div>`;}
function paycheckForm(){const d=today(),mid=nextMonthId(d);return `<form id="paycheck-form"><div class="field"><label>Exact take-home salary</label><input name="amount" type="number" min="0" step="1" required placeholder="e.g. 82137"></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${d}" required></div><div class="field"><label>Funding month</label><input name="period" type="month" value="${mid}" required></div></div><div class="notice">The paycheck date and funding month are separate. A salary received at month-end can fund the following month.</div><button class="btn" style="margin-top:14px;width:100%">Calculate & Create Funding Plan</button></form>`;}
function expenseForm(x=null){const p=currentPeriod();if(!p)return `<div class="empty">Create a funding month first.</div>`;const catId=x?.categoryId||'food',accountId=x?.accountId||'ctbc',bucketId=x?.fundingBucketId||'';return `<form id="expense-form"><input type="hidden" name="id" value="${x?.id||''}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount||''}" required></div><div class="field"><label>Category</label><select name="category">${state.categories.filter(c=>['fixed','cap','expense_only'].includes(c.ruleType)).map(c=>`<option value="${c.id}" ${c.id===catId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.date||today()}" required></div><div class="field"><label>Account used</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Funding bucket (optional)</label><select name="fundingBucket"><option value="">Operating cash</option>${state.buckets.filter(b=>b.bucketType!=='restricted').map(b=>`<option value="${b.id}" ${b.id===bucketId?'selected':''}>${esc(b.name)}</option>`).join('')}</select></div><div class="field"><label>Description (optional)</label><input name="description" value="${esc(x?.description||'')}" placeholder="Lunch, rent, electricity..."></div><button class="btn" style="width:100%">${x?'Save Changes':'Save Expense'}</button></form>`;}
function incomeForm(x=null){const p=currentPeriod(),type=x?.incomeType||'bonus',accountId=x?.accountId||'ctbc',period=x?.budgetPeriodId||p?.id||'';return `<form id="income-form"><input type="hidden" name="id" value="${x?.id||''}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount||''}" required></div><div class="field"><label>Income type</label><select name="type">${INCOME_TYPES.map(t=>`<option value="${t[0]}" ${t[0]===type?'selected':''}>${t[1]}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${x?.dateReceived||today()}" required></div><div class="field"><label>Budget period</label><select name="period">${state.periods.map(y=>`<option value="${y.id}" ${y.id===period?'selected':''}>${monthLabel(y.id)}</option>`).join('')}</select></div></div><div class="field"><label>Account</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${a.name}</option>`).join('')}</select></div><div class="field"><label>Description</label><input name="description" value="${esc(x?.description||'')}" placeholder="e.g. Camera sale"></div><label><input name="tithe" type="checkbox" ${x?.titheEligible?'checked':''}> Tithe eligible</label><button class="btn" style="width:100%;margin-top:14px">${x?'Save Changes':'Save Income'}</button></form>`;}
function manualTransferForm(x=null){const p=currentPeriod();const alloc=x?state.transferAllocations.find(a=>a.transferId===x.id):null;return `<form id="manual-transfer-form"><input type="hidden" name="id" value="${x?.id||''}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount||''}" required></div><div class="form-grid"><div class="field"><label>From account</label><select name="from">${state.accounts.map(a=>`<option value="${a.id}" ${a.id===(x?.fromAccountId||'ctbc')?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div><div class="field"><label>To account</label><select name="to">${state.accounts.map(a=>`<option value="${a.id}" ${a.id===(x?.toAccountId||'esun')?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Purpose / virtual bucket</label><select name="bucket"><option value="">No bucket allocation</option>${state.buckets.map(b=>`<option value="${b.id}" ${b.id===alloc?.bucketId?'selected':''}>${esc(b.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.completedDate||x?.plannedDate||today()}"></div><div class="field"><label>Budget period</label><select name="period"><option value="">None</option>${state.periods.map(y=>`<option value="${y.id}" ${y.id===(x?.budgetPeriodId||p?.id)?'selected':''}>${monthLabel(y.id)}</option>`).join('')}</select></div></div><label><input name="completed" type="checkbox" ${!x||x.status==='completed'?'checked':''}> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">${x?'Save Changes':'Save Transfer'}</button></form>`;}
function transferConfirm(id){const t=state.transfers.find(x=>x.id===id);if(!t)return'';const allocs=state.transferAllocations.filter(a=>a.transferId===id);return `<div class="notice">Confirm only after you actually moved the money in your banking app.</div><div class="section-title"><h2>${physicalAccount(t.fromAccountId)?.name} → ${physicalAccount(t.toAccountId)?.name}</h2></div><section class="card">${allocs.map(a=>row(bucket(a.bucketId)?.name||'Allocation',money(a.amount))).join('')}<div class="row"><strong>Total</strong><strong>${money(t.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-transfer" data-id="${id}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;}
function monthCloseView(){const p=currentPeriod();if(!p)return'';const sweep=sweepInfo(p.id);const pending=state.transfers.find(t=>!t.deletedAt&&t.budgetPeriodId===p.id&&t.status==='planned');return `<div class="grid g2"><section class="card"><div class="metric-label">Unused flexible + buffer</div><div class="metric">${money(sweep.grossUnused)}</div></section><section class="card"><div class="metric-label">Overspending deficits</div><div class="metric ${sweep.deficits?'bad':''}">${money(sweep.deficits)}</div></section></div><section class="card" style="margin-top:14px"><div class="metric-label">Available month-end sweep</div><div class="metric">${money(sweep.available)}</div><div class="sub">Calculated only from this budget period; a next-month paycheck is excluded.</div></section>${pending?`<div class="notice" style="margin-top:14px">Complete the existing planned transfer before creating a month-end sweep.</div>`:sweep.available>0?`<button class="btn" style="width:100%;margin-top:14px" data-action="create-sweep">Create Sweep Transfer</button>`:`<button class="btn" style="width:100%;margin-top:14px" data-action="close-period">Close Month</button>`}`;}
function investmentForm(){const snap=[...state.investmentSnapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1);return `<form id="investment-form"><div class="field"><label>IBKR portfolio value (USD)</label><input name="value" type="number" step="0.01" value="${snap?.value||3536}" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>USD/TWD rate</label><input name="fx" type="number" step="0.0001" value="${state.settings.usdTwdRate}" required></div></div><button class="btn" style="width:100%">Save Snapshot</button></form>`;}
function accountReconciliationForm(accountId){const a=physicalAccount(accountId),snap=accountId==='esun'?esunSnapshot():accountSnapshot(accountId);return `<form id="account-reconcile-form" data-account="${accountId}"><div class="notice">Enter the exact balance shown in your ${esc(a?.name||'bank')} app. Wealth OS will compare it with the transaction ledger.</div><div class="field" style="margin-top:14px"><label>Actual bank balance</label><input name="actualBalance" type="number" step="1" min="0" value="${Math.round(snap.actual)}" required></div><div class="form-grid"><div class="field"><label>Date checked</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Ledger expected</label><input type="text" value="${money(snap.expected)}" disabled></div></div><div class="field"><label>Note (optional)</label><input name="note" placeholder="Checked in bank app"></div><button class="btn" style="width:100%">Save Actual Balance</button></form>`;}
function accountAdjustmentForm(accountId){const snap=accountSnapshot(accountId);return `<form id="account-adjustment-form" data-account="${accountId}"><div class="notice">Use an adjustment only when the difference is real and is not better recorded as an expense, income or transfer.</div><div class="field" style="margin-top:14px"><label>Adjustment amount</label><input name="amount" type="number" step="1" value="${Math.round(snap.difference)||''}" placeholder="Use + to add or − to subtract" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Current bank vs ledger</label><input type="text" value="${snap.difference>0?'+':''}${money(snap.difference)}" disabled></div></div><div class="field"><label>Reason</label><input name="note" placeholder="Bank interest, correction, opening-balance fix..." required></div><button class="btn" style="width:100%">Save Adjustment</button></form>`;}
function esunAllocationForm(){const es=esunSnapshot();const diff=Number(modal.amount??es.unassigned);const reducing=diff<0;const amount=Math.abs(diff);return `<form id="esun-allocation-form"><div class="notice"><strong>${reducing?'Reduce':'Assign'} ${money(amount)}</strong><br>${reducing?'Choose which virtual buckets should be reduced.':'Choose what the unassigned E.SUN money is for.'} You can split it across several buckets or leave part unassigned.</div><div class="allocation-fields">${state.buckets.filter(b=>b.accountId==='esun').map(b=>`<div class="allocation-row"><div><strong>${esc(b.name)}</strong><div class="sub">Current ${money(state.bucketBalances[b.id]||0)}</div></div><input name="bucket-${b.id}" type="number" min="0" step="1" value="0" ${reducing?`max="${Math.max(0,Math.floor(state.bucketBalances[b.id]||0))}"`:''}></div>`).join('')}</div><input type="hidden" name="direction" value="${reducing?'-1':'1'}"><input type="hidden" name="limit" value="${amount}"><div class="sub" style="margin:10px 0">Maximum to ${reducing?'reduce':'assign'} now: ${money(amount)}</div><button class="btn" style="width:100%">Save Purpose Allocation</button></form>`;}

function deleteFundingMonthView(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p)return '<div class="empty">Funding month not found.</div>';
  const incomes=state.incomes.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const expenses=state.expenses.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const transfers=state.transfers.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const completed=transfers.filter(x=>x.status==='completed');
  if(p.state==='closed') return `<div class="notice"><strong>${monthLabel(periodId)} is closed.</strong><br>Closed months are protected from deletion.</div>`;
  if(completed.length) return `<div class="notice"><strong>Deletion is blocked.</strong><br>This month has ${completed.length} completed transfer${completed.length===1?'':'s'}. Wealth OS will not silently reverse money you may have actually moved between accounts.</div><section class="card" style="margin-top:14px">${row('Income entries',incomes.length)}${row('Expenses',expenses.length)}${row('Transfers',transfers.length)}${row('Completed transfers',completed.length)}</section><div class="sub" style="margin-top:12px">If this was only a test, leave system transfers uncompleted before deleting the month.</div>`;
  return `<div class="notice"><strong>This action is intended for test or mistaken funding months.</strong><br>It will permanently remove the month and its period-linked entries from this device.</div><section class="card" style="margin-top:14px">${row('Funding month',monthLabel(periodId))}${row('Income entries',incomes.length)}${row('Expenses',expenses.length)}${row('Planned transfers',transfers.length)}</section><div class="sub" style="margin:12px 0">E.SUN/CTBC reconciliations, account adjustments, IBKR snapshots, and unrelated transactions are not touched.</div><button class="btn danger" style="width:100%" data-action="confirm-delete-period" data-id="${periodId}">Delete Month & Test Data</button>`;
}

function settingsView(){return `<form id="settings-form"><div class="form-grid"><div class="field"><label>Forecast salary</label><input name="forecastSalary" type="number" value="${state.settings.forecastSalary}"></div><div class="field"><label>USD/TWD rate</label><input name="usdTwdRate" type="number" step="0.0001" value="${state.settings.usdTwdRate}"></div><div class="field"><label>Raise → wealth (%)</label><input name="wealthRaisePercent" type="number" value="${state.settings.wealthRaisePercent}"></div></div><div class="section-title"><h2>Budget rules</h2></div>${state.categories.filter(c=>c.ruleType!=='expense_only').map(c=>`<div class="row"><div><strong>${esc(c.name)}</strong><div class="sub">${c.ruleType.replaceAll('_',' ')}</div></div><input name="cat-${c.id}" type="number" step="1" value="${c.defaultAmount}" style="width:120px;padding:9px;border:1px solid #d1d5db;border-radius:9px;text-align:right"></div>`).join('')}<button class="btn" style="width:100%;margin-top:14px">Save Settings</button></form><div class="section-title"><h2>Data</h2></div><div class="actions"><button class="btn secondary" data-action="export-backup">Export Backup</button><label class="btn secondary">Restore Backup<input id="restore-file" type="file" accept="application/json" hidden></label></div>`;}

async function createPaycheck(form){
  const fd=new FormData(form);const amount=Number(fd.get('amount')),date=fd.get('date'),periodId=fd.get('period');
  if(state.periods.some(p=>p.id===periodId)) throw new Error('That budget month already exists.');
  const period={id:periodId,state:'funded',createdAt:new Date().toISOString(),fundedAt:date};await put('periods',period);
  await put('incomes',{id:uid('inc'),dateReceived:date,budgetPeriodId:periodId,amount,incomeType:'regular_income',accountId:'ctbc',description:'Monthly salary',titheEligible:true,includedInRegularIncomeMetrics:true,createdAt:new Date().toISOString()});
  const plan=buildBudgetPlan({income:amount,categories:state.categories,settings:state.settings});
  const allocations=[];
  const titheLine=plan.lines.find(x=>x.ruleType==='percentage');if(titheLine?.budgetAmount>0)allocations.push({bucketId:'tithe',amount:titheLine.budgetAmount,label:'Tithe'});
  plan.lines.filter(x=>x.ruleType==='sinking_contribution'&&x.bucketId).forEach(x=>allocations.push({bucketId:x.bucketId,amount:x.budgetAmount,label:x.name}));
  const goals=allocateGoalSurplus({amount:Math.max(0,plan.immediateWealth),goals:state.goals,bucketBalances:state.bucketBalances});goals.forEach(x=>allocations.push(x));
  const total=allocations.reduce((s,a)=>s+Number(a.amount),0);
  if(total>0){const tid=uid('tr');await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'esun',amount:total,budgetPeriodId:periodId,status:'planned',plannedDate:date,transferType:'payday',createdAt:new Date().toISOString()});await bulkPut('transferAllocations',allocations.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:a.goalId||null,label:a.label})));}
  selectedPeriodId=periodId;modal=null;await load();
}
async function saveExpense(form){
  const fd=new FormData(form),id=fd.get('id');const existing=id?state.expenses.find(x=>x.id===id):null;
  const cat=category(fd.get('category'));let fundingBucketId=fd.get('fundingBucket')||cat?.defaultFundingBucketId||null;let accountId=fd.get('account');
  if(fundingBucketId){const b=bucket(fundingBucketId);if(b?.accountId) accountId=b.accountId;}
  const obj={...(existing||{}),id:existing?.id||uid('exp'),amount:Number(fd.get('amount')),categoryId:fd.get('category'),date:fd.get('date'),accountId,budgetPeriodId:existing?.budgetPeriodId||selectedPeriodId,description:fd.get('description')||'',fundingBucketId,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  await put('expenses',obj);modal=null;await load();
}
async function saveManualTransfer(form){
  const fd=new FormData(form),id=fd.get('id');const existing=id?state.transfers.find(x=>x.id===id):null;
  const amount=Number(fd.get('amount')),from=fd.get('from'),to=fd.get('to');if(from===to)throw new Error('From and to accounts must be different for a bank transfer.');
  const tid=existing?.id||uid('tr'),status=fd.get('completed')==='on'?'completed':'planned',date=fd.get('date');
  await put('transfers',{...(existing||{}),id:tid,fromAccountId:from,toAccountId:to,amount,budgetPeriodId:fd.get('period')||null,status,plannedDate:date,completedDate:status==='completed'?date:null,transferType:'manual',createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deletedAt:null});
  for(const a of state.transferAllocations.filter(a=>a.transferId===tid)) await remove('transferAllocations',a.id);
  const bid=fd.get('bucket');if(bid)await put('transferAllocations',{id:uid('ta'),transferId:tid,bucketId:bid,amount,goalId:null,label:'Manual allocation'});
  modal=null;await load();
}
async function saveIncome(form){
  const fd=new FormData(form),id=fd.get('id'),type=fd.get('type');const existing=id?state.incomes.find(x=>x.id===id):null;
  await put('incomes',{...(existing||{}),id:existing?.id||uid('inc'),amount:Number(fd.get('amount')),incomeType:type,dateReceived:fd.get('date'),accountId:fd.get('account'),budgetPeriodId:fd.get('period'),description:fd.get('description')||'',titheEligible:fd.get('tithe')==='on',includedInRegularIncomeMetrics:type==='regular_income',createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deletedAt:null});modal=null;await load();
}
async function completeTransfer(id){const t=state.transfers.find(x=>x.id===id);await put('transfers',{...t,status:'completed',completedDate:today(),updatedAt:new Date().toISOString()});modal=null;await load();}
async function createSweep(){const p=currentPeriod(),sweep=sweepInfo(p.id);if(sweep.available<=0)return;const allocs=allocateGoalSurplus({amount:sweep.available,goals:state.goals,bucketBalances:state.bucketBalances});const tid=uid('tr');await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'esun',amount:sweep.available,budgetPeriodId:p.id,status:'planned',plannedDate:today(),transferType:'month_end_sweep',createdAt:new Date().toISOString()});await bulkPut('transferAllocations',allocs.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:a.goalId||null,label:a.label})));modal={type:'transfer',id:tid};await load();}
async function closePeriod(){const p=currentPeriod();await put('periods',{...p,state:'closed',closedAt:new Date().toISOString()});await put('monthlyCloses',{id:p.id,budgetPeriodId:p.id,closedAt:new Date().toISOString(),income:periodRegularIncome(p.id),expenses:totalExpenses(p.id),wealthContribution:completedCoreWealth(p.id),goalFunding:completedGoalFunding(p.id)});modal=null;await load();}
async function saveInvestment(form){const fd=new FormData(form);const fx=Number(fd.get('fx'));await put('investmentSnapshots',{id:uid('snap'),accountId:'ibkr',date:fd.get('date'),value:Number(fd.get('value')),currency:'USD',fxRate:fx,createdAt:new Date().toISOString()});await put('settings',{...state.settings,usdTwdRate:fx,updatedAt:new Date().toISOString()});modal=null;await load();}
async function saveAccountReconciliation(form){
  const fd=new FormData(form),accountId=form.dataset.account,actual=Number(fd.get('actualBalance')),expected=Number(state.accountBalances[accountId]||0);
  await put('reconciliations',{id:uid('rec'),accountId,date:fd.get('date'),actualBalance:actual,expectedBalance:expected,difference:actual-expected,note:fd.get('note')||'',createdAt:new Date().toISOString()});
  if(accountId==='esun'){
    const virtualTotal=state.buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(state.bucketBalances[b.id]||0),0);
    const unassigned=actual-virtualTotal;
    if(Math.abs(unassigned)>=0.5){modal={type:'esun-allocate',amount:unassigned};await load();return;}
  }
  modal=null;await load();
}
async function saveAccountAdjustment(form){
  const fd=new FormData(form),accountId=form.dataset.account,amount=Number(fd.get('amount'));if(!amount)throw new Error('Enter a non-zero adjustment amount.');
  await put('adjustments',{id:uid('adj'),accountId,amount,date:fd.get('date'),note:fd.get('note')||'',createdAt:new Date().toISOString()});modal=null;await load();
}
async function saveEsunAllocation(form){
  const fd=new FormData(form),limit=Number(fd.get('limit')||0),direction=Number(fd.get('direction')||1);const allocations=[];
  for(const b of state.buckets.filter(b=>b.accountId==='esun')){const v=Number(fd.get(`bucket-${b.id}`)||0);if(v>0)allocations.push({bucketId:b.id,amount:v*direction,label:direction>0?'Purpose allocation':'Purpose reduction'});}
  const total=allocations.reduce((s,a)=>s+Math.abs(Number(a.amount)),0);if(total<=0)throw new Error('Enter at least one allocation amount.');if(total>limit+0.5)throw new Error(`Allocation cannot exceed ${money(limit)}.`);
  if(direction<0){for(const a of allocations){if(Math.abs(a.amount)>Number(state.bucketBalances[a.bucketId]||0)+0.5)throw new Error(`Cannot reduce ${bucket(a.bucketId)?.name} below zero.`);}}
  const tid=uid('tr');await put('transfers',{id:tid,fromAccountId:'esun',toAccountId:'esun',amount:total,budgetPeriodId:null,status:'completed',plannedDate:today(),completedDate:today(),transferType:'bucket_allocation',createdAt:new Date().toISOString()});
  await bulkPut('transferAllocations',allocations.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:null,label:a.label})));
  modal=null;await load();
}
async function deleteFundingMonth(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p)throw new Error('Funding month not found.');
  if(p.state==='closed')throw new Error('Closed months cannot be deleted.');
  const transfers=state.transfers.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const completed=transfers.filter(x=>x.status==='completed');
  if(completed.length)throw new Error('This month has completed transfers. Resolve those before deleting the funding month.');
  for(const t of transfers){
    for(const a of state.transferAllocations.filter(a=>a.transferId===t.id)) await remove('transferAllocations',a.id);
    await remove('transfers',t.id);
  }
  for(const x of state.expenses.filter(x=>x.budgetPeriodId===periodId)) await remove('expenses',x.id);
  for(const x of state.incomes.filter(x=>x.budgetPeriodId===periodId)) await remove('incomes',x.id);
  for(const x of state.monthlyCloses.filter(x=>x.budgetPeriodId===periodId||x.id===periodId)) await remove('monthlyCloses',x.id);
  await remove('periods',periodId);
  selectedPeriodId=null;modal=null;await load();
}

async function deleteTransaction(kind,id){
  if(kind==='expense'){const x=state.expenses.find(e=>e.id===id);await put('expenses',{...x,deletedAt:new Date().toISOString()});}
  if(kind==='income'){const x=state.incomes.find(e=>e.id===id);await put('incomes',{...x,deletedAt:new Date().toISOString()});}
  if(kind==='transfer'){const x=state.transfers.find(e=>e.id===id);await put('transfers',{...x,deletedAt:new Date().toISOString()});}
  await load();
}
async function saveSettings(form){const fd=new FormData(form);await put('settings',{...state.settings,forecastSalary:Number(fd.get('forecastSalary')),usdTwdRate:Number(fd.get('usdTwdRate')),operatingBuffer:Number(state.categories.find(c=>c.id==='operating-buffer')?.defaultAmount||3000),wealthRaisePercent:Number(fd.get('wealthRaisePercent')),updatedAt:new Date().toISOString()});for(const c of state.categories){const v=fd.get(`cat-${c.id}`);if(v!==null)await put('categories',{...c,defaultAmount:Number(v),updatedAt:new Date().toISOString()});}const ob=fd.get('cat-operating-buffer');if(ob!==null)await put('settings',{...(await getOne('settings','app')),operatingBuffer:Number(ob),updatedAt:new Date().toISOString()});modal=null;await load();}
async function backup(){const data=await exportData();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`wealth-os-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);await put('settings',{...state.settings,lastBackupAt:new Date().toISOString()});await load();}
async function restore(file){const text=await file.text();await importData(JSON.parse(text));modal=null;selectedPeriodId=null;await load();}
function runScenario(){const salary=Number(document.querySelector('#scenario-salary').value||0),annual=Number(document.querySelector('#scenario-return').value||0)/100;const p=buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});const monthly=Math.max(0,p.immediateWealth);const months=forecastMonthsToTarget({start:state.wealth.coreWealth,monthly,annualReturn:annual,target:10000000});document.querySelector('#scenario-result').innerHTML=`<div class="notice"><strong>${money(monthly)}/month</strong> estimated wealth capacity under current rules.<br>Illustrative time to ${money(10000000)}: <strong>${isFinite(months)?`${Math.floor(months/12)}y ${months%12}m`:'not reachable'}</strong>.</div>`;}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();});
  const ps=document.querySelector('#period-select');if(ps)ps.onchange=()=>{selectedPeriodId=ps.value;render();};
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.action;try{
    if(a==='new-paycheck')modal={type:'paycheck'};
    if(a==='add-expense')modal={type:'expense'};
    if(a==='add-income')modal={type:'income'};
    if(a==='manual-transfer')modal={type:'manual-transfer'};
    if(a==='complete-transfer')modal={type:'transfer',id:b.dataset.id};
    if(a==='confirm-transfer')return completeTransfer(b.dataset.id);
    if(a==='month-close')modal={type:'close'};
    if(a==='create-sweep')return createSweep();
    if(a==='close-period')return closePeriod();
    if(a==='settings')modal={type:'settings'};
    if(a==='investment-snapshot')modal={type:'investment'};
    if(a==='account-reconcile')modal={type:'account-reconcile',accountId:b.dataset.id};
    if(a==='account-adjustment')modal={type:'account-adjustment',accountId:b.dataset.id};
    if(a==='esun-allocate')modal={type:'esun-allocate',amount:esunSnapshot().unassigned};
    if(a==='delete-period')modal={type:'delete-period',periodId:b.dataset.id};
    if(a==='confirm-delete-period'){
      if(confirm(`Delete ${monthLabel(b.dataset.id)} and all of its test data? This cannot be undone.`)) return deleteFundingMonth(b.dataset.id);
      return;
    }
    if(a==='activity-filter'){activityFilter=b.dataset.filter;return render();}
    if(a==='edit-transaction'){
      if(b.dataset.kind==='expense')modal={type:'expense',id:b.dataset.id};
      if(b.dataset.kind==='income')modal={type:'income',id:b.dataset.id};
      if(b.dataset.kind==='transfer')modal={type:'manual-transfer',id:b.dataset.id};
    }
    if(a==='delete-transaction'){
      if(confirm(`Delete this ${b.dataset.kind}?`)) return deleteTransaction(b.dataset.kind,b.dataset.id);
      return;
    }
    if(a==='close-modal')modal=null;
    if(a==='export-backup')return backup();
    if(a==='run-scenario')return runScenario();
    render();
  }catch(err){alert(err.message||String(err));}});
  const pf=document.querySelector('#paycheck-form');if(pf)pf.onsubmit=e=>{e.preventDefault();createPaycheck(pf).catch(err=>alert(err.message));};
  const ef=document.querySelector('#expense-form');if(ef)ef.onsubmit=e=>{e.preventDefault();saveExpense(ef).catch(err=>alert(err.message));};
  const inf=document.querySelector('#income-form');if(inf)inf.onsubmit=e=>{e.preventDefault();saveIncome(inf).catch(err=>alert(err.message));};
  const mtf=document.querySelector('#manual-transfer-form');if(mtf)mtf.onsubmit=e=>{e.preventDefault();saveManualTransfer(mtf).catch(err=>alert(err.message));};
  const inv=document.querySelector('#investment-form');if(inv)inv.onsubmit=e=>{e.preventDefault();saveInvestment(inv).catch(err=>alert(err.message));};
  const arf=document.querySelector('#account-reconcile-form');if(arf)arf.onsubmit=e=>{e.preventDefault();saveAccountReconciliation(arf).catch(err=>alert(err.message));};
  const aaf=document.querySelector('#account-adjustment-form');if(aaf)aaf.onsubmit=e=>{e.preventDefault();saveAccountAdjustment(aaf).catch(err=>alert(err.message));};
  const eal=document.querySelector('#esun-allocation-form');if(eal)eal.onsubmit=e=>{e.preventDefault();saveEsunAllocation(eal).catch(err=>alert(err.message));};
  const sf=document.querySelector('#settings-form');if(sf)sf.onsubmit=e=>{e.preventDefault();saveSettings(sf).catch(err=>alert(err.message));};
  const rf=document.querySelector('#restore-file');if(rf)rf.onchange=()=>{if(rf.files[0]&&confirm('Replace all local Wealth OS data with this backup?'))restore(rf.files[0]).catch(err=>alert(err.message));};
}

if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
load().catch(err=>{root.innerHTML=`<pre style="padding:20px">${esc(err.stack||err.message)}</pre>`;});
