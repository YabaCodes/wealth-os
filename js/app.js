import { seedIfNeeded,getAll,getOne,put,bulkPut,remove,uid,exportData,importData,bucketBalances,accountBalances,wealthMetrics } from './db.js';
import { INCOME_TYPES } from './defaults.js';
import { money,pct,monthLabel,buildBudgetPlan,aggregateExpenses,budgetSummary,calculateSweep,allocateGoalSurplus,activeGoal,forecastMonthsToTarget } from './calc.js';

const root=document.querySelector('#app');
let tab='home';
let state={};
let modal=null;
let selectedPeriodId=null;

const today=()=>new Date().toISOString().slice(0,10);
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const nextMonthId=(dateStr)=>{const d=new Date(`${dateStr}T12:00:00`);return `${d.getFullYear()+(d.getMonth()===11?1:0)}-${String((d.getMonth()+1)%12+1).padStart(2,'0')}`;};

async function load(){
  await seedIfNeeded();
  const keys=['accounts','buckets','categories','goals','periods','incomes','expenses','transfers','transferAllocations','investmentSnapshots','reconciliations','monthlyCloses'];
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
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&t.budgetPeriodId===periodId).map(t=>t.id));
  const coreBucketIds=new Set(state.buckets.filter(b=>b.countsTowardCoreWealth).map(b=>b.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&coreBucketIds.has(a.bucketId)).reduce((s,a)=>s+Number(a.amount),0);
}
function completedGoalFunding(periodId){
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&t.budgetPeriodId===periodId).map(t=>t.id));
  const sinkIds=new Set(state.buckets.filter(b=>['sinking_fund','operating_reserve'].includes(b.bucketType)).map(b=>b.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&sinkIds.has(a.bucketId)).reduce((s,a)=>s+Number(a.amount),0);
}
function physicalAccount(id){return state.accounts.find(a=>a.id===id);}
function bucket(id){return state.buckets.find(b=>b.id===id);}
function category(id){return state.categories.find(c=>c.id===id);}
function goal(id){return state.goals.find(g=>g.id===id);}
function totalExpenses(periodId){return state.expenses.filter(e=>e.budgetPeriodId===periodId&&!e.deletedAt).reduce((s,e)=>s+Number(e.amount),0);}
function sweepInfo(periodId){const plan=planFor(periodId),base=calculateSweep({budgetLines:plan.lines,expenseTotals:expenseTotals(periodId)});const reserved=state.transfers.filter(t=>t.budgetPeriodId===periodId&&t.transferType==='month_end_sweep'&&['planned','completed'].includes(t.status)).reduce((s,t)=>s+Number(t.amount||0),0);return {...base,alreadySwept:reserved,available:Math.max(0,base.available-reserved),netAfterSweep:base.net-reserved};}
function latestInvestmentTwd(){
  const snap=[...state.investmentSnapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1);
  if(!snap)return 0;return Number(snap.value)*Number(snap.fxRate||state.settings.usdTwdRate||1);
}
function goalBal(g){return Number(state.bucketBalances[g.bucketId]||0);}

function shell(content){
  const p=currentPeriod();
  root.innerHTML=`<main class="shell">
    <header class="topbar"><div class="brand"><h1>Wealth OS</h1><p>Budget deliberately. Build wealth automatically.</p></div><button class="btn ghost small" data-action="settings">⚙︎ Settings</button></header>
    ${content}
    <p class="footer-note">Local-first financial planning. Transfers are not expenses; virtual buckets track purpose independently of bank balances.</p>
  </main>${nav()}${modal?renderModal():''}`;
  bind();
}
function nav(){const items=[['home','⌂','Home'],['budget','▤','Budget'],['transactions','↕','Activity'],['goals','◎','Goals'],['wealth','◈','Wealth'],['forecast','⌁','Forecast']];return `<nav class="tabs"><div class="tabs-inner">${items.map(([id,ic,l])=>`<button class="tab ${tab===id?'active':''}" data-tab="${id}"><b>${ic}</b>${l}</button>`).join('')}</div></nav>`;}

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
  <div class="grid g2" style="margin-top:12px">
    <section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Emergency savings + investments</div></section>
    <section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded</div></section>
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
function wealthStrip(){return `<div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Starting financial net worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div></section><section class="card"><div class="metric-label">IBKR</div><div class="metric">${money(latestInvestmentTwd())}</div><div class="sub">FX is editable in Settings</div></section></div>`;}

function budgetView(){
  const p=currentPeriod();if(!p)return `<section class="card empty">Create a paycheck first.</section>`;
  const plan=planFor(p.id), totals=expenseTotals(p.id), lines=budgetSummary({planLines:plan.lines,expenseTotals:totals});
  return `<div class="split"><div><h2 style="margin:0">Budget</h2><div class="sub">${monthLabel(p.id)}</div></div>${periodSelector()}</div>
  <div class="kpi-strip" style="margin-top:14px"><section class="card kpi-mini"><div class="metric-label">Income</div><div class="metric">${money(plan.salary)}</div></section><section class="card kpi-mini"><div class="metric-label">Assigned</div><div class="metric">${money(plan.assignedBeforeWealth)}</div></section><section class="card kpi-mini"><div class="metric-label">Immediate wealth</div><div class="metric">${money(plan.immediateWealth)}</div></section></div>
  ${['Percentage','Fixed','Flexible','Reserve','Buffer'].map(group=>budgetGroup(group,lines)).join('')}`;
}
function budgetGroup(group,lines){const xs=lines.filter(x=>x.group===group);if(!xs.length)return'';return `<div class="section-title"><h2>${group}</h2></div><section class="card"><div class="list-head"><span>Category</span><span class="right">Budget</span><span class="right">Actual</span><span class="right">Remaining</span></div>${xs.map(x=>`<div class="budget-line"><div><strong>${esc(x.name)}</strong><div class="sub">${x.ruleType.replaceAll('_',' ')}</div></div><div class="num">${money(x.budgetAmount)}</div><div class="num">${x.ruleType==='percentage'||x.ruleType==='sinking_contribution'?'—':money(x.actual)}</div><div class="num ${x.remaining<0?'bad':''}">${x.ruleType==='percentage'||x.ruleType==='sinking_contribution'?'—':money(x.remaining)}</div></div>`).join('')}</section>`;}

function transactionsView(){
  const list=[...state.expenses.map(x=>({...x,_kind:'expense',_date:x.date,_amount:-Number(x.amount),_title:category(x.categoryId)?.name||'Expense'})),...state.incomes.map(x=>({...x,_kind:'income',_date:x.dateReceived,_amount:Number(x.amount),_title:INCOME_TYPES.find(t=>t[0]===x.incomeType)?.[1]||'Income'})),...state.transfers.filter(x=>x.status==='completed').map(x=>({...x,_kind:'transfer',_date:x.completedDate||x.plannedDate,_amount:0,_title:`${physicalAccount(x.fromAccountId)?.name} → ${physicalAccount(x.toAccountId)?.name}`}))].filter(x=>!x.deletedAt).sort((a,b)=>String(b._date).localeCompare(String(a._date)));
  return `<div class="split"><div><h2 style="margin:0">Activity</h2><div class="sub">Expenses, income and transfers</div></div><div class="actions"><button class="btn" data-action="add-expense">+ Expense</button><button class="btn secondary" data-action="add-income">+ Income</button><button class="btn secondary" data-action="manual-transfer">+ Transfer</button></div></div><section class="card" style="margin-top:14px">${list.length?list.slice(0,100).map(txLine).join(''):`<div class="empty">No activity yet.</div>`}</section>`;
}
function txLine(x){const meta=x._kind==='expense'?`${x.date} · ${x.description||''}`:x._kind==='income'?`${x.dateReceived} · ${x.description||''}`:`${x._date} · transfer`;return `<div class="tx"><div><div class="tx-title">${esc(x._title)}</div><div class="tx-meta">${esc(meta)}</div></div><div class="right"><div class="amount ${x._amount>0?'good':x._amount<0?'bad':''}">${x._kind==='transfer'?'Transfer':money(x._amount)}</div><span class="tag">${x._kind}</span>${x._kind==='expense'?`<button class="btn ghost small" style="margin-left:5px" data-action="delete-expense" data-id="${x.id}">Delete</button>`:''}</div></div>`;}

function goalsView(){return `<div><h2 style="margin:0">Goals</h2><div class="sub">Permanent wealth and planned spending stay separate.</div></div><div class="grid g2" style="margin-top:14px">${[...state.goals].sort((a,b)=>a.priority-b.priority).map(g=>{const b=goalBal(g),p=Math.min(1,b/g.targetAmount);let status=g.status;if(g.prerequisiteGoalId){const pg=goal(g.prerequisiteGoalId);if(pg&&goalBal(pg)<g.prerequisiteAmount)status=`waiting for ${money(g.prerequisiteAmount)} emergency threshold`;}return `<section class="card"><div class="split"><strong>${esc(g.name)}</strong><span class="tag">${esc(status)}</span></div><div class="metric">${money(b)}</div><div class="sub">of ${money(g.targetAmount)}</div><div class="progress"><span style="width:${p*100}%"></span></div>${g.targetDate?`<div class="sub">Target ${g.targetDate}</div>`:''}${g.monthlyTarget?`<div class="sub">Monthly target ${money(g.monthlyTarget)}</div>`:''}</section>`;}).join('')}</div>`;}

function wealthView(){
  const fx=state.settings.usdTwdRate;return `<div><h2 style="margin:0">Wealth</h2><div class="sub">Physical accounts and virtual purpose ledgers</div></div>
  <div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Core Wealth</div><div class="metric">${money(state.wealth.coreWealth)}</div><div class="sub">Long-term capital only</div></section><section class="card"><div class="metric-label">Financial Net Worth</div><div class="metric">${money(state.wealth.financialNetWorth)}</div><div class="sub">Tithe excluded</div></section></div>
  <div class="section-title"><h2>Accounts</h2></div><section class="card">${state.accounts.map(a=>{const bal=state.accountBalances[a.id]||0;return row(a.name,a.currency==='USD'?`${money(bal,'USD')} · ${money(bal*fx)}`:money(bal));}).join('')}</section>
  <div class="section-title"><h2>E.SUN virtual composition</h2><span class="sub">Purpose ledger</span></div><section class="card">${state.buckets.filter(b=>b.accountId==='esun').map(b=>row(b.name,money(state.bucketBalances[b.id]||0))).join('')}<div class="row"><strong>Virtual total</strong><strong class="amount">${money(state.buckets.filter(b=>b.accountId==='esun').reduce((s,b)=>s+Number(state.bucketBalances[b.id]||0),0))}</strong></div></section>
  <div class="section-title"><h2>Investments</h2></div><section class="card">${row('IBKR current value',money(latestInvestmentTwd()))}${row('USD/TWD rate',Number(fx).toFixed(2))}<div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="investment-snapshot">Update IBKR Value</button></div></section>`;
}

function forecastView(){
  const salary=Number(state.settings.forecastSalary||82500);const plan=buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});const monthly=Math.max(0,plan.immediateWealth);const start=state.wealth.coreWealth;const annual=.07;const targets=[1000000,3000000,5000000,10000000,30000000];
  return `<div><h2 style="margin:0">Forecast</h2><div class="sub">Illustrative planning assumptions, not guaranteed returns.</div></div><section class="card" style="margin-top:14px"><div class="form-grid"><div><div class="metric-label">Planning income</div><div class="metric">${money(salary)}</div></div><div><div class="metric-label">Monthly wealth capacity</div><div class="metric">${money(monthly)}</div></div></div><div class="sub">Uses your current rules and a 7% nominal annual return assumption for long-term scenarios.</div></section>
  <div class="section-title"><h2>Current path</h2></div><section class="card">${targets.map(t=>{const m=forecastMonthsToTarget({start,monthly,annualReturn:annual/12*12,target:t});const yrs=isFinite(m)?`${Math.floor(m/12)}y ${m%12}m`:'—';return row(money(t),yrs)}).join('')}</section>
  <div class="section-title"><h2>Scenario lab</h2></div><section class="card"><div class="notice">Use this to test a different take-home salary without changing your real budget.</div><div class="form-grid" style="margin-top:12px"><div class="field"><label>Take-home salary</label><input id="scenario-salary" type="number" value="120000"></div><div class="field"><label>Annual return assumption (%)</label><input id="scenario-return" type="number" step="0.1" value="7"></div></div><button class="btn" data-action="run-scenario">Run Scenario</button><div id="scenario-result" style="margin-top:12px"></div></section>`;
}

function renderModal(){
  if(modal.type==='paycheck') return modalWrap('New Paycheck',paycheckForm());
  if(modal.type==='expense') return modalWrap('Add Expense',expenseForm());
  if(modal.type==='income') return modalWrap('Add Income',incomeForm());
  if(modal.type==='manual-transfer') return modalWrap('Record Transfer',manualTransferForm());
  if(modal.type==='transfer') return modalWrap('Confirm Transfer',transferConfirm(modal.id));
  if(modal.type==='close') return modalWrap('Month-End Review',monthCloseView());
  if(modal.type==='settings') return modalWrap('Settings',settingsView());
  if(modal.type==='investment') return modalWrap('Update IBKR Value',investmentForm());
  return '';
}
function modalWrap(title,body){return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" onclick="event.stopPropagation()"><div class="split"><h3>${title}</h3><button class="btn ghost small" data-action="close-modal">Close</button></div>${body}</section></div>`;}
function paycheckForm(){const d=today(),mid=nextMonthId(d);return `<form id="paycheck-form"><div class="field"><label>Exact take-home salary</label><input name="amount" type="number" min="0" step="1" required placeholder="e.g. 82137"></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${d}" required></div><div class="field"><label>Funding month</label><input name="period" type="month" value="${mid}" required></div></div><div class="notice">The paycheck date and funding month are separate. A salary received at month-end can fund the following month.</div><button class="btn" style="margin-top:14px;width:100%">Calculate & Create Funding Plan</button></form>`;}
function expenseForm(){const p=currentPeriod();if(!p)return `<div class="empty">Create a funding month first.</div>`;return `<form id="expense-form"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" required></div><div class="field"><label>Category</label><select name="category">${state.categories.filter(c=>['fixed','cap','expense_only'].includes(c.ruleType)).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Account used</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Funding bucket (optional)</label><select name="fundingBucket"><option value="">Operating cash</option>${state.buckets.filter(b=>b.bucketType!=='restricted').map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div><div class="field"><label>Description (optional)</label><input name="description" placeholder="Lunch, rent, electricity..."></div><button class="btn" style="width:100%">Save Expense</button></form>`;}
function incomeForm(){const p=currentPeriod();return `<form id="income-form"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" required></div><div class="field"><label>Income type</label><select name="type">${INCOME_TYPES.filter(x=>x[0]!=='regular_income').map(x=>`<option value="${x[0]}">${x[1]}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Budget period</label><select name="period">${state.periods.map(x=>`<option value="${x.id}" ${x.id===p?.id?'selected':''}>${monthLabel(x.id)}</option>`).join('')}</select></div></div><div class="field"><label>Account</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}">${a.name}</option>`).join('')}</select></div><div class="field"><label>Description</label><input name="description" placeholder="e.g. Camera sale"></div><label><input name="tithe" type="checkbox"> Tithe eligible</label><button class="btn" style="width:100%;margin-top:14px">Save Income</button></form>`;}

function manualTransferForm(){const p=currentPeriod();return `<form id="manual-transfer-form"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" required></div><div class="form-grid"><div class="field"><label>From account</label><select name="from">${state.accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div><div class="field"><label>To account</label><select name="to">${state.accounts.map(a=>`<option value="${a.id}" ${a.id==='esun'?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Purpose / virtual bucket</label><select name="bucket"><option value="">No bucket allocation</option>${state.buckets.map(b=>`<option value="${b.id}" ${b.id==='emergency'?'selected':''}>${esc(b.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}"></div><div class="field"><label>Budget period</label><select name="period"><option value="">None</option>${state.periods.map(x=>`<option value="${x.id}" ${x.id===p?.id?'selected':''}>${monthLabel(x.id)}</option>`).join('')}</select></div></div><label><input name="completed" type="checkbox" checked> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">Save Transfer</button></form>`;}

function transferConfirm(id){const t=state.transfers.find(x=>x.id===id);if(!t)return'';const allocs=state.transferAllocations.filter(a=>a.transferId===id);return `<div class="notice">Confirm only after you actually moved the money in your banking app.</div><div class="section-title"><h2>${physicalAccount(t.fromAccountId)?.name} → ${physicalAccount(t.toAccountId)?.name}</h2></div><section class="card">${allocs.map(a=>row(bucket(a.bucketId)?.name||'Allocation',money(a.amount))).join('')}<div class="row"><strong>Total</strong><strong>${money(t.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-transfer" data-id="${id}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;}
function monthCloseView(){const p=currentPeriod();if(!p)return'';const plan=planFor(p.id),totals=expenseTotals(p.id),sweep=sweepInfo(p.id);const pending=state.transfers.find(t=>t.budgetPeriodId===p.id&&t.status==='planned');return `<div class="grid g2"><section class="card"><div class="metric-label">Unused flexible + buffer</div><div class="metric">${money(sweep.grossUnused)}</div></section><section class="card"><div class="metric-label">Overspending deficits</div><div class="metric ${sweep.deficits?'bad':''}">${money(sweep.deficits)}</div></section></div><section class="card" style="margin-top:14px"><div class="metric-label">Available month-end sweep</div><div class="metric">${money(sweep.available)}</div><div class="sub">Calculated only from this budget period; a next-month paycheck is excluded.</div></section>${pending?`<div class="notice" style="margin-top:14px">Complete the existing planned transfer before creating a month-end sweep.</div>`:sweep.available>0?`<button class="btn" style="width:100%;margin-top:14px" data-action="create-sweep">Create Sweep Transfer</button>`:`<button class="btn" style="width:100%;margin-top:14px" data-action="close-period">Close Month</button>`}`;}
function investmentForm(){const snap=[...state.investmentSnapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1);return `<form id="investment-form"><div class="field"><label>IBKR portfolio value (USD)</label><input name="value" type="number" step="0.01" value="${snap?.value||3536}" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>USD/TWD rate</label><input name="fx" type="number" step="0.0001" value="${state.settings.usdTwdRate}" required></div></div><button class="btn" style="width:100%">Save Snapshot</button></form>`;}
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
async function addExpense(form){const fd=new FormData(form);const cat=category(fd.get('category'));let fundingBucketId=fd.get('fundingBucket')||cat?.defaultFundingBucketId||null;let accountId=fd.get('account');if(fundingBucketId){const b=bucket(fundingBucketId);if(b?.accountId) accountId=b.accountId;}await put('expenses',{id:uid('exp'),amount:Number(fd.get('amount')),categoryId:fd.get('category'),date:fd.get('date'),accountId,budgetPeriodId:selectedPeriodId,description:fd.get('description')||'',fundingBucketId,createdAt:new Date().toISOString()});modal=null;await load();}

async function saveManualTransfer(form){const fd=new FormData(form);const amount=Number(fd.get('amount')),from=fd.get('from'),to=fd.get('to');if(from===to)throw new Error('From and to accounts must be different.');const tid=uid('tr'),status=fd.get('completed')==='on'?'completed':'planned';await put('transfers',{id:tid,fromAccountId:from,toAccountId:to,amount,budgetPeriodId:fd.get('period')||null,status,plannedDate:fd.get('date'),completedDate:status==='completed'?fd.get('date'):null,transferType:'manual',createdAt:new Date().toISOString()});const bid=fd.get('bucket');if(bid)await put('transferAllocations',{id:uid('ta'),transferId:tid,bucketId:bid,amount,goalId:null,label:'Manual allocation'});modal=null;await load();}

async function addIncome(form){const fd=new FormData(form),type=fd.get('type');await put('incomes',{id:uid('inc'),amount:Number(fd.get('amount')),incomeType:type,dateReceived:fd.get('date'),accountId:fd.get('account'),budgetPeriodId:fd.get('period'),description:fd.get('description')||'',titheEligible:fd.get('tithe')==='on',includedInRegularIncomeMetrics:false,createdAt:new Date().toISOString()});modal=null;await load();}
async function completeTransfer(id){const t=state.transfers.find(x=>x.id===id);await put('transfers',{...t,status:'completed',completedDate:today(),updatedAt:new Date().toISOString()});modal=null;await load();}
async function createSweep(){const p=currentPeriod(),plan=planFor(p.id),totals=expenseTotals(p.id),sweep=sweepInfo(p.id);if(sweep.available<=0)return;const allocs=allocateGoalSurplus({amount:sweep.available,goals:state.goals,bucketBalances:state.bucketBalances});const tid=uid('tr');await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'esun',amount:sweep.available,budgetPeriodId:p.id,status:'planned',plannedDate:today(),transferType:'month_end_sweep',createdAt:new Date().toISOString()});await bulkPut('transferAllocations',allocs.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:a.goalId||null,label:a.label})));modal={type:'transfer',id:tid};await load();}
async function closePeriod(){const p=currentPeriod();await put('periods',{...p,state:'closed',closedAt:new Date().toISOString()});await put('monthlyCloses',{id:p.id,budgetPeriodId:p.id,closedAt:new Date().toISOString(),income:periodRegularIncome(p.id),expenses:totalExpenses(p.id),wealthContribution:completedCoreWealth(p.id),goalFunding:completedGoalFunding(p.id)});modal=null;await load();}
async function saveInvestment(form){const fd=new FormData(form);const fx=Number(fd.get('fx'));await put('investmentSnapshots',{id:uid('snap'),accountId:'ibkr',date:fd.get('date'),value:Number(fd.get('value')),currency:'USD',fxRate:fx,createdAt:new Date().toISOString()});await put('settings',{...state.settings,usdTwdRate:fx,updatedAt:new Date().toISOString()});modal=null;await load();}
async function saveSettings(form){const fd=new FormData(form);await put('settings',{...state.settings,forecastSalary:Number(fd.get('forecastSalary')),usdTwdRate:Number(fd.get('usdTwdRate')),operatingBuffer:Number(state.categories.find(c=>c.id==='operating-buffer')?.defaultAmount||3000),wealthRaisePercent:Number(fd.get('wealthRaisePercent')),updatedAt:new Date().toISOString()});for(const c of state.categories){const v=fd.get(`cat-${c.id}`);if(v!==null)await put('categories',{...c,defaultAmount:Number(v),updatedAt:new Date().toISOString()});}const ob=fd.get('cat-operating-buffer');if(ob!==null)await put('settings',{...(await getOne('settings','app')),operatingBuffer:Number(ob),updatedAt:new Date().toISOString()});modal=null;await load();}
async function backup(){const data=await exportData();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`wealth-os-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);await put('settings',{...state.settings,lastBackupAt:new Date().toISOString()});await load();}
async function restore(file){const text=await file.text();await importData(JSON.parse(text));modal=null;selectedPeriodId=null;await load();}
function runScenario(){const salary=Number(document.querySelector('#scenario-salary').value||0),annual=Number(document.querySelector('#scenario-return').value||0)/100;const p=buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});const monthly=Math.max(0,p.immediateWealth);const months=forecastMonthsToTarget({start:state.wealth.coreWealth,monthly,annualReturn:annual,target:10000000});document.querySelector('#scenario-result').innerHTML=`<div class="notice"><strong>${money(monthly)}/month</strong> estimated wealth capacity under current rules.<br>Illustrative time to ${money(10000000)}: <strong>${isFinite(months)?`${Math.floor(months/12)}y ${months%12}m`:'not reachable'}</strong>.</div>`;}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();});
  const ps=document.querySelector('#period-select');if(ps)ps.onchange=()=>{selectedPeriodId=ps.value;render();};
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async(e)=>{const a=b.dataset.action;try{
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
    if(a==='close-modal')modal=null;
    if(a==='export-backup')return backup();
    if(a==='run-scenario')return runScenario();
    if(a==='delete-expense'){if(confirm('Delete this expense?')){const x=state.expenses.find(e=>e.id===b.dataset.id);await put('expenses',{...x,deletedAt:new Date().toISOString()});return load();}else return;}
    render();
  }catch(err){alert(err.message||String(err));}});
  const pf=document.querySelector('#paycheck-form');if(pf)pf.onsubmit=e=>{e.preventDefault();createPaycheck(pf).catch(err=>alert(err.message));};
  const ef=document.querySelector('#expense-form');if(ef)ef.onsubmit=e=>{e.preventDefault();addExpense(ef).catch(err=>alert(err.message));};
  const inf=document.querySelector('#income-form');if(inf)inf.onsubmit=e=>{e.preventDefault();addIncome(inf).catch(err=>alert(err.message));};
  const mtf=document.querySelector('#manual-transfer-form');if(mtf)mtf.onsubmit=e=>{e.preventDefault();saveManualTransfer(mtf).catch(err=>alert(err.message));};
  const inv=document.querySelector('#investment-form');if(inv)inv.onsubmit=e=>{e.preventDefault();saveInvestment(inv).catch(err=>alert(err.message));};
  const sf=document.querySelector('#settings-form');if(sf)sf.onsubmit=e=>{e.preventDefault();saveSettings(sf).catch(err=>alert(err.message));};
  const rf=document.querySelector('#restore-file');if(rf)rf.onchange=()=>{if(rf.files[0]&&confirm('Replace all local Wealth OS data with this backup?'))restore(rf.files[0]).catch(err=>alert(err.message));};
}

if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
load().catch(err=>{root.innerHTML=`<pre style="padding:20px">${esc(err.stack||err.message)}</pre>`;});
