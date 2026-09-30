import { seedIfNeeded,getAll,getOne,put,bulkPut,remove,uid,exportData,importData,bucketBalances,accountBalances,wealthMetrics } from './db.js';
import { INCOME_TYPES } from './defaults.js';
import { money,pct,monthLabel,buildBudgetPlan,aggregateExpenses,budgetSummary,calculateSweep,allocateGoalSurplus,activeGoal,forecastMonthsToTarget,simulateWealthStrategy,simulateWealthStrategyWithGrowth } from './calc.js';

const root=document.querySelector('#app');
let tab='home';
let state={};
let modal=null;
let selectedPeriodId=null;
let activityFilter='all';
let activitySearch='';
const APP_VERSION='1.7';
const DATA_MODEL_VERSION=170;

const today=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const nextMonthId=(dateStr)=>{const d=new Date(`${dateStr}T12:00:00`);return `${d.getFullYear()+(d.getMonth()===11?1:0)}-${String((d.getMonth()+1)%12+1).padStart(2,'0')}`;};

async function migrateV131(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=131) return;

  const electricity=await getOne('buckets','electricity');
  if(electricity){
    await put('buckets',{...electricity,accountId:'ctbc',countsTowardNetWorth:false,updatedAt:new Date().toISOString()});
  }

  // v1.3 created combined planned payday transfers. They were only intentions and may
  // become stale when the user records one component separately. v1.3.1 derives payday
  // transfer requirements from the funding plan instead, so uncompleted system plans can
  // be safely removed while completed real transfers are preserved.
  const transfers=await getAll('transfers');
  const allocations=await getAll('transferAllocations');
  const stalePlans=transfers.filter(t=>!t.deletedAt&&t.status==='planned'&&['payday','investment_contribution'].includes(t.transferType));
  for(const t of stalePlans){
    for(const a of allocations.filter(a=>a.transferId===t.id)) await remove('transferAllocations',a.id);
    await remove('transfers',t.id);
  }

  // Electricity remains physically in CTBC. Treat the monthly reserve as an internal
  // purpose allocation, not a CTBC → E.SUN bank transfer.
  const periods=await getAll('periods');
  const remainingTransfers=await getAll('transfers');
  const remainingAllocs=await getAll('transferAllocations');
  for(const period of periods.filter(p=>p.state!=='closed')){
    const line=period.planSnapshot?.lines?.find(x=>x.ruleType==='sinking_contribution'&&x.bucketId==='electricity');
    const target=Number(line?.budgetAmount||0);
    if(target<=0) continue;
    const completedIds=new Set(remainingTransfers.filter(t=>!t.deletedAt&&t.status==='completed'&&t.budgetPeriodId===period.id).map(t=>t.id));
    const already=remainingAllocs.filter(a=>completedIds.has(a.transferId)&&a.bucketId==='electricity').reduce((sum,a)=>sum+Number(a.amount||0),0);
    const amount=Math.max(0,target-already);
    if(amount>0.5){
      const stamp=new Date().toISOString(),tid=uid('tr');
      await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'ctbc',amount,budgetPeriodId:period.id,status:'completed',plannedDate:period.fundedAt||today(),completedDate:period.fundedAt||today(),completedAt:stamp,transferType:'reserve_allocation',affectsPhysicalBalance:false,systemGenerated:true,createdAt:stamp,updatedAt:stamp});
      await put('transferAllocations',{id:uid('ta'),transferId:tid,bucketId:'electricity',amount,goalId:null,label:'Electricity Reserve'});
    }
  }

  await put('settings',{...settings,dataModelVersion:131,updatedAt:new Date().toISOString()});
}

async function migrateV132(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=132) return;

  // Purpose allocations are bookkeeping only; they must never change a physical bank
  // balance. Mark every historical internal allocation explicitly so old records cannot
  // be interpreted as bank movements by future balance logic.
  const transfers=await getAll('transfers');
  for(const t of transfers){
    const purposeOnly=t.fromAccountId===t.toAccountId || ['bucket_allocation','reserve_allocation'].includes(t.transferType);
    if(purposeOnly && t.affectsPhysicalBalance!==false){
      await put('transfers',{...t,affectsPhysicalBalance:false,updatedAt:t.updatedAt||new Date().toISOString()});
    }
  }

  // Repair the narrow duplicate-purpose-allocation case exposed during the Sep 30 live
  // migration: an already-assigned reconciliation difference could be assigned a second
  // time. Only remove a duplicate when (a) the virtual ledger is over the tracked bank
  // amount by the exact prior reconciliation difference and (b) two identical purpose
  // allocation records exist. This avoids guessing about legitimate distinct allocations.
  const recs=(await getAll('reconciliations')).filter(r=>r.accountId==='esun'&&!r.deletedAt)
    .sort((a,b)=>`${a.date||''}${a.createdAt||''}`.localeCompare(`${b.date||''}${b.createdAt||''}`));
  const latestRec=recs.at(-1)||null;
  if(latestRec){
    const baselineGap=Number(latestRec.actualBalance||0)-Number(latestRec.expectedBalance||0);
    if(baselineGap>0.5){
      const absNow=await accountBalances();
      const rawExpected=Number(absNow.esun||0);
      const trackedBank=Number(latestRec.actualBalance||0)+(rawExpected-Number(latestRec.expectedBalance||0));
      const bb=await bucketBalances();
      const buckets=await getAll('buckets');
      const virtualTotal=buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(bb[b.id]||0),0);
      const over=virtualTotal-trackedBank;
      if(Math.abs(over-baselineGap)<0.5){
        const allTransfers=await getAll('transfers');
        const allAllocs=await getAll('transferAllocations');
        const candidates=allTransfers.filter(t=>!t.deletedAt&&t.status==='completed'&&t.transferType==='bucket_allocation'&&t.fromAccountId==='esun'&&t.toAccountId==='esun');
        const signature=t=>allAllocs.filter(a=>a.transferId===t.id).map(a=>`${a.bucketId}:${Number(a.amount||0)}`).sort().join('|');
        const groups=new Map();
        for(const t of candidates){
          if(Math.abs(Number(t.amount||0)-baselineGap)>=0.5) continue;
          const sig=signature(t); if(!sig) continue;
          if(!groups.has(sig)) groups.set(sig,[]);
          groups.get(sig).push(t);
        }
        for(const group of groups.values()){
          if(group.length<2) continue;
          group.sort((a,b)=>String(a.createdAt||a.completedAt||a.completedDate||'').localeCompare(String(b.createdAt||b.completedAt||b.completedDate||'')));
          const duplicate=group.at(-1);
          await put('transfers',{...duplicate,deletedAt:new Date().toISOString(),repairNote:'v1.3.2 removed duplicate E.SUN purpose allocation',updatedAt:new Date().toISOString()});
          break;
        }
      }
    }
  }

  await put('settings',{...settings,dataModelVersion:132,updatedAt:new Date().toISOString()});
}

async function migrateV133(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=133) return;

  // v1.3.2 still derived the post-reconciliation bank roll-forward from the entire
  // historical ledger. Older reconciliation adjustments could therefore be counted
  // again after the reconciliation had already established the true bank baseline.
  // Rebuild the E.SUN comparison from only physical activity that happened after the
  // latest exact bank check.
  const recs=(await getAll('reconciliations')).filter(r=>r.accountId==='esun'&&!r.deletedAt)
    .sort((a,b)=>`${a.date||''}${a.createdAt||''}`.localeCompare(`${b.date||''}${b.createdAt||''}`));
  const rec=recs.at(-1)||null;
  if(rec){
    const after=(effectiveDate,stamp)=>{
      const rd=String(rec.date||'');
      const ed=String(effectiveDate||'');
      if(ed>rd) return true;
      if(ed<rd) return false;
      return String(stamp||'')>String(rec.createdAt||'');
    };
    const [incomes,expenses,transfers,adjustments,buckets,allocs]=await Promise.all([
      getAll('incomes'),getAll('expenses'),getAll('transfers'),getAll('adjustments'),getAll('buckets'),getAll('transferAllocations')
    ]);
    let delta=0;
    for(const x of incomes){if(!x.deletedAt&&x.accountId==='esun'&&after(x.dateReceived||x.date,x.createdAt||x.updatedAt))delta+=Number(x.amount||0);}
    for(const x of expenses){if(!x.deletedAt&&x.accountId==='esun'&&after(x.dateReceived||x.date,x.createdAt||x.updatedAt))delta-=Number(x.amount||0);}
    for(const t of transfers){
      if(t.deletedAt||t.status!=='completed') continue;
      const purposeOnly=t.affectsPhysicalBalance===false||t.fromAccountId===t.toAccountId||['bucket_allocation','reserve_allocation'].includes(t.transferType);
      if(purposeOnly||!after(t.completedDate||t.plannedDate,t.completedAt||t.updatedAt||t.createdAt)) continue;
      if(t.toAccountId==='esun')delta+=Number(t.amount||0);
      if(t.fromAccountId==='esun')delta-=Number(t.amount||0);
    }
    for(const a of adjustments){if(!a.deletedAt&&a.accountId==='esun'&&after(a.date,a.createdAt||a.updatedAt))delta+=Number(a.amount||0);}
    const tracked=Number(rec.actualBalance||0)+delta;

    // Remove the duplicate NT$4,500-style purpose allocation only when the current
    // virtual ledger is over the correctly rolled-forward bank balance by exactly the
    // original positive reconciliation gap, and duplicate matching internal allocations
    // actually exist. This is deliberately narrow so legitimate allocations are untouched.
    const baselineGap=Number(rec.actualBalance||0)-Number(rec.expectedBalance||0);
    const bb=await bucketBalances();
    const virtualTotal=buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(bb[b.id]||0),0);
    const over=virtualTotal-tracked;
    if(baselineGap>0.5&&Math.abs(over-baselineGap)<0.5){
      const candidates=transfers.filter(t=>!t.deletedAt&&t.status==='completed'&&t.transferType==='bucket_allocation'&&t.fromAccountId==='esun'&&t.toAccountId==='esun'&&Math.abs(Number(t.amount||0)-baselineGap)<0.5);
      const signature=t=>allocs.filter(a=>a.transferId===t.id).map(a=>`${a.bucketId}:${Number(a.amount||0)}`).sort().join('|');
      const groups=new Map();
      for(const t of candidates){const sig=signature(t);if(!sig)continue;if(!groups.has(sig))groups.set(sig,[]);groups.get(sig).push(t);}
      for(const group of groups.values()){
        if(group.length<2)continue;
        group.sort((a,b)=>String(a.createdAt||a.completedAt||a.completedDate||'').localeCompare(String(b.createdAt||b.completedAt||b.completedDate||'')));
        const duplicate=group.at(-1);
        await put('transfers',{...duplicate,deletedAt:new Date().toISOString(),repairNote:'v1.3.3 removed duplicate E.SUN purpose allocation after reconciliation-baseline repair',updatedAt:new Date().toISOString()});
        break;
      }
    }
  }

  await put('settings',{...settings,dataModelVersion:133,updatedAt:new Date().toISOString()});
}

async function migrateV140(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=140) return;
  // Reliability release only: do not mutate balances, transactions, reconciliations,
  // allocations, goals, or funding months during this upgrade.
  await put('settings',{...settings,dataModelVersion:140,appVersion:'1.4',updatedAt:new Date().toISOString()});
}

async function migrateV150(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=150) return;
  const next={
    ...settings,
    forecastInvestmentReturn:Number.isFinite(Number(settings?.forecastInvestmentReturn))?Number(settings.forecastInvestmentReturn):7,
    forecastSalaryGrowth:Number.isFinite(Number(settings?.forecastSalaryGrowth))?Number(settings.forecastSalaryGrowth):3,
    conservativeInvestmentReturn:Number.isFinite(Number(settings?.conservativeInvestmentReturn))?Number(settings.conservativeInvestmentReturn):4,
    conservativeSalaryGrowth:Number.isFinite(Number(settings?.conservativeSalaryGrowth))?Number(settings.conservativeSalaryGrowth):1,
    aggressiveInvestmentReturn:Number.isFinite(Number(settings?.aggressiveInvestmentReturn))?Number(settings.aggressiveInvestmentReturn):9,
    aggressiveSalaryGrowth:Number.isFinite(Number(settings?.aggressiveSalaryGrowth))?Number(settings.aggressiveSalaryGrowth):5,
    dataModelVersion:150,
    appVersion:'1.5',
    updatedAt:new Date().toISOString()
  };
  await put('settings',next);
}

async function migrateV160(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=160) return;
  // v1.6 is a quality-of-life release. It adds no new financial ledger records and
  // deliberately does not rewrite balances, reconciliations, allocations or history.
  await put('settings',{...settings,dataModelVersion:160,appVersion:'1.6',updatedAt:new Date().toISOString()});
}

async function migrateV161(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=161) return;
  // v1.6.1 fixes annual Tithe reporting only. It does not create, delete, reclassify,
  // or rewrite any financial ledger records. Historical purpose corrections and
  // reallocations remain in the audit trail; annual Tithe reporting nets corrections and excludes pure purpose moves.
  await put('settings',{...settings,dataModelVersion:161,appVersion:'1.6.1',updatedAt:new Date().toISOString()});
}

async function migrateV170(){
  const settings=await getOne('settings','app');
  if(Number(settings?.dataModelVersion||0)>=170) return;
  // v1.7 adds month-operation, data-health and snapshot metadata only. It deliberately
  // does not rewrite financial balances, transactions, allocations, reconciliations or goals.
  // Existing fixed categories already generate expected monthly obligations; mark them
  // explicitly so future releases can distinguish expectations from real expenses.
  const categories=await getAll('categories');
  for(const c of categories){
    if(c.ruleType==='fixed'&&c.expectedEachMonth!==true){
      await put('categories',{...c,expectedEachMonth:true,updatedAt:c.updatedAt||new Date().toISOString()});
    }
  }
  await put('settings',{...settings,dataModelVersion:170,appVersion:'1.7',updatedAt:new Date().toISOString()});
}

async function load(){
  await seedIfNeeded();
  await migrateV131();
  await migrateV132();
  await migrateV133();
  await migrateV140();
  await migrateV150();
  await migrateV160();
  await migrateV161();
  await migrateV170();
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
function isClosedPeriod(periodId){return state.periods.find(p=>p.id===periodId)?.state==='closed';}
function assertPeriodEditable(periodId){if(periodId&&isClosedPeriod(periodId))throw new Error(`${monthLabel(periodId)} is closed. Reopen the month before changing period-linked records.`);}
function formatMonths(m){if(m===null||m===undefined||!isFinite(m))return '—';if(m===0)return 'Now';return `${Math.floor(m/12)}y ${m%12}m`;}
function periodRegularIncome(periodId){return state.incomes.filter(i=>i.budgetPeriodId===periodId&&!i.deletedAt&&i.incomeType==='regular_income').reduce((a,b)=>a+Number(b.amount),0);}
function periodEligibleIncome(periodId){return state.incomes.filter(i=>i.budgetPeriodId===periodId&&!i.deletedAt&&i.titheEligible).reduce((a,b)=>a+Number(b.amount),0);}
function planFor(periodId){
  const p=state.periods.find(x=>x.id===periodId);
  if(p?.planSnapshot)return p.planSnapshot;
  const closedSnapshot=state.monthlyCloses.find(x=>(x.budgetPeriodId===periodId||x.id===periodId)&&x.planSnapshot);
  if(closedSnapshot?.planSnapshot)return closedSnapshot.planSnapshot;
  const salary=periodRegularIncome(periodId);
  return buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});
}
function expenseTotals(periodId){return aggregateExpenses(state.expenses,periodId);}
function completedCoreWealth(periodId){
  const completed=state.transfers.filter(t=>t.status==='completed'&&!t.deletedAt&&t.budgetPeriodId===periodId);
  const complete=new Set(completed.map(t=>t.id));
  const coreBucketIds=new Set(state.buckets.filter(b=>b.countsTowardCoreWealth).map(b=>b.id));
  const bucketCore=state.transferAllocations.filter(a=>complete.has(a.transferId)&&coreBucketIds.has(a.bucketId)).reduce((s,a)=>s+Number(a.amount),0);
  const investmentIds=new Set(state.accounts.filter(a=>a.role==='investment').map(a=>a.id));
  const invested=completed.filter(t=>investmentIds.has(t.toAccountId)&&!investmentIds.has(t.fromAccountId)).reduce((s,t)=>s+Number(t.amount||0),0);
  return bucketCore+invested;
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
function entryPeriodId(){
  const selected=currentPeriod();
  if(selected&&selected.state!=='closed')return selected.id;
  return [...state.periods].filter(p=>p.state!=='closed').sort((a,b)=>b.id.localeCompare(a.id))[0]?.id||null;
}
function activityRecords(){
  return [
    ...state.expenses.filter(x=>!x.deletedAt).map(x=>({...x,_kind:'expense',_date:x.date,_amount:-Number(x.amount),_title:category(x.categoryId)?.name||'Expense',_account:physicalAccount(x.accountId)?.name||'',_detail:['Physical expense',x.description||''].filter(Boolean).join(' · ')})),
    ...state.incomes.filter(x=>!x.deletedAt).map(x=>({...x,_kind:'income',_date:x.dateReceived,_amount:Number(x.amount),_title:INCOME_TYPES.find(t=>t[0]===x.incomeType)?.[1]||'Income',_account:physicalAccount(x.accountId)?.name||'',_detail:['Physical income',x.description||''].filter(Boolean).join(' · ')})),
    ...state.transfers.filter(x=>!x.deletedAt&&['planned','completed'].includes(x.status)).map(x=>{const virtualOnly=isPurposeOnlyTransfer(x);const internalName=physicalAccount(x.fromAccountId)?.name||'Account';return {...x,_kind:'transfer',_date:x.completedDate||x.plannedDate,_amount:Number(x.amount||0),_title:virtualOnly?`${internalName} purpose allocation`:`${physicalAccount(x.fromAccountId)?.name||x.fromAccountId} → ${physicalAccount(x.toAccountId)?.name||x.toAccountId}`,_account:virtualOnly?'Virtual purpose ledger':'Physical bank transfer',_detail:`${virtualOnly?'Virtual only · bank impact NT$0':'Physical transfer · spending impact NT$0'} · ${x.status}`};})
  ].sort((a,b)=>String(b._date).localeCompare(String(a._date))||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
function sweepInfo(periodId){const plan=planFor(periodId),base=calculateSweep({budgetLines:plan.lines,expenseTotals:expenseTotals(periodId)});const reserved=state.transfers.filter(t=>!t.deletedAt&&t.budgetPeriodId===periodId&&t.transferType==='month_end_sweep'&&['planned','completed'].includes(t.status)).reduce((s,t)=>s+Number(t.amount||0),0);return {...base,alreadySwept:reserved,available:Math.max(0,base.available-reserved),overSwept:Math.max(0,reserved-base.available),netAfterSweep:base.net-reserved};}
function monthCloseStatus(periodId){
  const p=state.periods.find(x=>x.id===periodId);
  const plan=planFor(periodId),totals=expenseTotals(periodId),sweep=sweepInfo(periodId);
  const pending=state.transfers.filter(t=>!t.deletedAt&&t.budgetPeriodId===periodId&&t.status==='planned');
  const fixedLines=plan.lines.filter(x=>x.ruleType==='fixed');
  const missingFixed=fixedLines.filter(x=>Number(totals[x.id]||0)+0.5<Number(x.budgetAmount||0));
  const ct=accountSnapshot('ctbc'),es=esunSnapshot();
  const reserveFunded=plan.lines.filter(x=>x.ruleType==='sinking_contribution').reduce((sum,x)=>sum+completedAllocationToBucket(periodId,x.bucketId),0);
  const titheAllocated=completedTithe(periodId),titheExpected=expectedTithe(periodId);
  const payday=paydayRequirements(periodId);
  const fundingOk=reserveFunded+0.5>=plan.sinking && payday.totalOutstanding<=0.5;
  const bankOk=ct.verified&&Math.abs(ct.difference)<0.5&&es.verified&&es.bankOk&&es.allocationOk;
  const hardBlockers=[];
  if(pending.length)hardBlockers.push(`${pending.length} planned transfer${pending.length===1?'':'s'} still pending`);
  if(sweep.available>0.5)hardBlockers.push(`${money(sweep.available)} still available to sweep`);
  if(sweep.overSwept>0.5)hardBlockers.push(`${money(sweep.overSwept)} was swept beyond the current available amount`);
  if(!fundingOk)hardBlockers.push('payday allocations are incomplete');
  if(titheAllocated+0.5<titheExpected)hardBlockers.push(`${money(titheExpected-titheAllocated)} of tithe is not yet allocated`);
  if(!bankOk)hardBlockers.push('bank reconciliation or E.SUN purpose allocation is incomplete');
  return {p,plan,totals,sweep,pending,missingFixed,ct,es,reserveFunded,titheAllocated,titheExpected,payday,fundingOk,bankOk,hardBlockers,ready:hardBlockers.length===0};
}
function latestInvestmentTwd(){
  const usd=Number(state.accountBalances?.ibkr||0);
  return usd*Number(state.settings.usdTwdRate||1);
}
function goalBal(g){return Number(state.bucketBalances[g.bucketId]||0);}
function goalStatus(g){
  const bal=goalBal(g),target=Number(g.targetAmount||0);
  if(target>0&&bal>=target)return {key:'complete',label:'Complete',className:'good-tag'};
  if(g.status==='paused')return {key:'paused',label:'Paused',className:''};
  if(g.prerequisiteGoalId){const pg=goal(g.prerequisiteGoalId);if(pg&&goalBal(pg)<Number(g.prerequisiteAmount||0))return {key:'waiting',label:'Waiting',className:'warn-tag'};}
  return {key:'active',label:'Active',className:'good-tag'};
}
function periodAllIncome(periodId){return state.incomes.filter(i=>i.budgetPeriodId===periodId&&!i.deletedAt).reduce((a,b)=>a+Number(b.amount||0),0);}
function periodRecord(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p)return null;
  const close=state.monthlyCloses.find(x=>(x.budgetPeriodId===periodId||x.id===periodId)&&x.status==='closed');
  const regularIncome=close?Number(close.income||0):periodRegularIncome(periodId);
  const totalIncome=close?Number(close.totalIncome??close.income??0):periodAllIncome(periodId);
  const expenses=close?Number(close.expenses||0):totalExpenses(periodId);
  const wealthContribution=close?Number(close.wealthContribution||0):completedCoreWealth(periodId);
  const actuals=close?.categoryActuals||expenseTotals(periodId);
  const contributionRate=regularIncome>0?wealthContribution/regularIncome:0;
  const latestId=[...state.periods].sort((a,b)=>a.id.localeCompare(b.id)).at(-1)?.id||null;
  const coreWealth=close?Number(close.endingCoreWealth||0):(periodId===latestId?Number(state.wealth.coreWealth||0):null);
  const financialNetWorth=close?Number(close.endingFinancialNetWorth||0):(periodId===latestId?Number(state.wealth.financialNetWorth||0):null);
  return {id:periodId,state:p.state,closed:!!close,regularIncome,totalIncome,expenses,wealthContribution,contributionRate,actuals,coreWealth,financialNetWorth};
}
function historyRecords(){return [...state.periods].sort((a,b)=>a.id.localeCompare(b.id)).map(p=>periodRecord(p.id)).filter(Boolean);}
function recentHistory(n=3){return historyRecords().slice(-n);}
function averageCoreContribution(n=3){const xs=recentHistory(n).filter(x=>x.regularIncome>0);return xs.length?xs.reduce((s,x)=>s+x.wealthContribution,0)/xs.length:0;}
function averageGoalContribution(bucketId,n=3){const xs=recentHistory(n);if(!xs.length)return 0;return xs.reduce((sum,x)=>sum+completedAllocationToBucket(x.id,bucketId),0)/xs.length;}
function dateAfterMonths(months){
  if(months===null||months===undefined||!isFinite(months))return '—';
  const d=new Date();d.setDate(1);d.setMonth(d.getMonth()+Math.max(0,Math.ceil(months)));
  return new Intl.DateTimeFormat('en-US',{month:'short',year:'numeric'}).format(d);
}
function titheContributedInYear(year){
  const completed=state.transfers.filter(t=>!t.deletedAt&&t.status==='completed');
  const byId=new Map(completed.map(t=>[t.id,t]));
  return state.transferAllocations.reduce((sum,a)=>{
    const t=byId.get(a.transferId);if(!t||a.bucketId!=='tithe')return sum;
    const d=String(t.completedDate||t.plannedDate||'');
    if(!d.startsWith(String(year)))return sum;
    // Purpose reallocations only rename existing E.SUN money and are not new Tithe.
    // Direct bucket allocations can represent newly recognized unassigned Tithe cash;
    // include both positive and negative amounts so later corrections net out cleanly.
    if(['purpose_reallocation','reserve_allocation'].includes(t.transferType))return sum;
    if(t.transferType==='allocation_reversal'){
      const original=byId.get(t.reversalOf)||state.transfers.find(x=>x.id===t.reversalOf);
      if(original&&['purpose_reallocation','reserve_allocation'].includes(original.transferType))return sum;
    }
    return sum+Number(a.amount||0);
  },0);
}
function completedContributionToBucketInYear(bucketId,year){
  const nonContributionTypes=new Set(['bucket_allocation','purpose_reallocation','allocation_reversal']);
  const completed=new Map(state.transfers.filter(t=>!t.deletedAt&&t.status==='completed').map(t=>[t.id,t]));
  return state.transferAllocations.reduce((sum,a)=>{
    const t=completed.get(a.transferId);if(!t||nonContributionTypes.has(t.transferType))return sum;
    const d=String(t.completedDate||t.plannedDate||'');
    if(!d.startsWith(String(year))||a.bucketId!==bucketId||Number(a.amount||0)<=0)return sum;
    return sum+Number(a.amount||0);
  },0);
}
function yearSummary(year){
  const prefix=String(year);
  const income=state.incomes.filter(x=>!x.deletedAt&&String(x.dateReceived||'').startsWith(prefix)).reduce((s,x)=>s+Number(x.amount||0),0);
  const regularIncome=state.incomes.filter(x=>!x.deletedAt&&x.incomeType==='regular_income'&&String(x.dateReceived||'').startsWith(prefix)).reduce((s,x)=>s+Number(x.amount||0),0);
  const expenses=state.expenses.filter(x=>!x.deletedAt&&String(x.date||'').startsWith(prefix)).reduce((s,x)=>s+Number(x.amount||0),0);
  const tithe=titheContributedInYear(year);
  const emergency=completedContributionToBucketInYear('emergency',year);
  const investments=state.transfers.filter(t=>!t.deletedAt&&t.status==='completed'&&t.toAccountId==='ibkr'&&t.fromAccountId!=='ibkr'&&String(t.completedDate||t.plannedDate||'').startsWith(prefix)).reduce((s,t)=>s+Number(t.amount||0),0);
  const coreBucketIds=new Set(state.buckets.filter(b=>b.countsTowardCoreWealth).map(b=>b.id));
  const coreBuckets=[...coreBucketIds].reduce((sum,id)=>sum+completedContributionToBucketInYear(id,year),0);
  const wealth=coreBuckets+investments;
  const points=historyRecords().filter(x=>x.id.startsWith(prefix)&&x.financialNetWorth!==null).map(x=>x.financialNetWorth);
  const netWorthChange=points.length>=2?points.at(-1)-points[0]:null;
  return {income,regularIncome,expenses,tithe,emergency,investments,wealth,netWorthChange,months:historyRecords().filter(x=>x.id.startsWith(prefix)).length};
}
function trendSvg(records,key,{percent=false}={}){
  const pts=records.filter(x=>Number.isFinite(Number(x[key])));if(pts.length<2)return '';
  const vals=pts.map(x=>Number(x[key]));const min=Math.min(...vals),max=Math.max(...vals),span=Math.max(1,max-min);
  const coords=vals.map((v,i)=>`${10+(i/(vals.length-1))*300},${90-((v-min)/span)*72}`).join(' ');
  const dots=vals.map((v,i)=>`<circle cx="${10+(i/(vals.length-1))*300}" cy="${90-((v-min)/span)*72}" r="3"/>`).join('');
  return `<div class="trend-wrap"><svg class="trend-svg" viewBox="0 0 320 100" preserveAspectRatio="none"><line x1="10" y1="90" x2="310" y2="90"/><polyline points="${coords}"/>${dots}</svg><div class="trend-labels">${pts.map(x=>`<span>${esc(monthLabel(x.id).split(' ')[0].slice(0,3))}</span>`).join('')}</div></div>`;
}
function contributionBars(records){
  if(!records.length)return '';
  const max=Math.max(.01,...records.map(x=>x.contributionRate));
  return `<div class="history-bars">${records.map(x=>`<div class="history-bar-item"><div class="history-bar-track"><span style="height:${Math.max(3,(x.contributionRate/max)*100)}%"></span></div><strong>${pct(x.contributionRate)}</strong><small>${esc(monthLabel(x.id).split(' ')[0].slice(0,3))}</small></div>`).join('')}</div>`;
}
function signedMoney(v){const n=Number(v||0);return `${n>0?'+':''}${money(n)}`;}
function deltaClass(v){return Number(v)>0?'good':Number(v)<0?'bad':'';}
function currentPaceMonthly(){const avg=averageCoreContribution(3);const p=currentPeriod();const planned=p?Math.max(0,planFor(p.id).immediateWealth):0;return avg>0?avg:planned;}
function latestRegularTakeHome(){
  const xs=historyRecords().filter(x=>Number(x.regularIncome||0)>0);
  return Number(xs.at(-1)?.regularIncome||0);
}
function forecastBaselineSalary(){return latestRegularTakeHome()||Number(state.settings.forecastSalary||0);}
function goalPaceText(g){
  const bal=goalBal(g),remaining=Math.max(0,Number(g.targetAmount||0)-bal);if(remaining<=0)return 'Complete';
  let pace=averageGoalContribution(g.bucketId,3);
  if(g.id==='goal-emergency'&&pace<=0)pace=currentPaceMonthly();
  if(pace<=0)return 'Need contribution history';
  const months=Math.ceil(remaining/pace);return `At current pace: ${dateAfterMonths(months)} · ~${money(pace)}/mo`;
}
function scenarioFor(returnPct,growthPct,extra=0,salaryOverride=null){
  const salary=Number((salaryOverride??forecastBaselineSalary()) || 0);
  const plan=buildBudgetPlan({income:salary,categories:state.categories,settings:state.settings});
  const monthly=Math.max(0,plan.immediateWealth+Number(extra||0)),em=goal('goal-emergency'),trip=goal('goal-home-trip');
  const targets=[1000000,3000000,5000000,10000000,30000000];
  const sim=simulateWealthStrategyWithGrowth({emergencyStart:Number(state.bucketBalances.emergency||0),travelStart:Number(state.bucketBalances['home-trip']||0),investmentStart:latestInvestmentTwd(),monthlyCapacity:monthly,startingSalary:salary,annualSalaryGrowth:Number(growthPct||0)/100,raiseCaptureRate:Number(state.settings.wealthRaisePercent||75)/100,annualReturn:Number(returnPct||0)/100,emergencyUnlock:Number(trip?.prerequisiteAmount||200000),emergencyTarget:Number(em?.targetAmount||300000),travelTarget:Number(trip?.targetAmount||100000),travelMonthly:Number(trip?.monthlyTarget||10000),months:600,milestones:targets});
  return {salary,monthly,targets,sim,returnPct:Number(returnPct||0),growthPct:Number(growthPct||0)};
}

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
function recordAfterReconciliation(rec,effectiveDate,stamp){
  const rd=String(rec?.date||''),ed=String(effectiveDate||'');
  if(ed>rd)return true;
  if(ed<rd)return false;
  return String(stamp||'')>String(rec?.createdAt||'');
}
function physicalDeltaSinceReconciliation(accountId,rec){
  let delta=0;
  for(const x of state.incomes||[]){if(!x.deletedAt&&x.accountId===accountId&&recordAfterReconciliation(rec,x.dateReceived||x.date,x.createdAt||x.updatedAt))delta+=Number(x.amount||0);}
  for(const x of state.expenses||[]){if(!x.deletedAt&&x.accountId===accountId&&recordAfterReconciliation(rec,x.dateReceived||x.date,x.createdAt||x.updatedAt))delta-=Number(x.amount||0);}
  for(const t of state.transfers||[]){
    if(t.deletedAt||t.status!=='completed')continue;
    const purposeOnly=t.affectsPhysicalBalance===false||t.fromAccountId===t.toAccountId||['bucket_allocation','reserve_allocation'].includes(t.transferType);
    if(purposeOnly||!recordAfterReconciliation(rec,t.completedDate||t.plannedDate,t.completedAt||t.updatedAt||t.createdAt))continue;
    if(t.toAccountId===accountId)delta+=Number(t.amount||0);
    if(t.fromAccountId===accountId)delta-=Number(t.amount||0);
  }
  for(const a of state.adjustments||[]){if(!a.deletedAt&&a.accountId===accountId&&recordAfterReconciliation(rec,a.date,a.createdAt||a.updatedAt))delta+=Number(a.amount||0);}
  return delta;
}
function accountSnapshot(accountId){
  const rawExpected=Number(state.accountBalances[accountId]||0);
  const rec=latestReconciliation(accountId);
  if(!rec) return {accountId,expected:rawExpected,rawExpected,actual:rawExpected,difference:0,verified:false,reconciliation:null,isEstimated:false,ledgerDeltaSinceCheck:0};
  // The exact bank check is the authoritative baseline. Only physical activity that
  // occurred after that check is allowed to roll the balance forward. Historical
  // adjustments that helped reach the checked balance are therefore never counted twice.
  const ledgerDeltaSinceCheck=physicalDeltaSinceReconciliation(accountId,rec);
  const tracked=Number(rec.actualBalance||0)+ledgerDeltaSinceCheck;
  return {accountId,expected:tracked,rawExpected,actual:tracked,difference:0,verified:true,reconciliation:rec,isEstimated:Math.abs(ledgerDeltaSinceCheck)>=0.5,ledgerDeltaSinceCheck};
}
function esunSnapshot(){
  const base=accountSnapshot('esun');
  const virtualTotal=state.buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(state.bucketBalances[b.id]||0),0);
  const unassigned=base.actual-virtualTotal;
  return {...base,virtualTotal,unassigned,allocationOk:Math.abs(unassigned)<0.5,bankOk:Math.abs(base.difference)<0.5};
}

function daysSince(dateStr){
  if(!dateStr)return null;
  const d=new Date(`${dateStr}T12:00:00`);if(Number.isNaN(d.getTime()))return null;
  return Math.max(0,Math.floor((new Date()-d)/86400000));
}
function duplicateGroups(records,keyFn){
  const groups=new Map();
  for(const r of records){const k=keyFn(r);if(!k)continue;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  return [...groups.values()].filter(g=>g.length>1);
}
function dataHealthReport(){
  const issues=[];
  const add=(severity,title,detail,action=null)=>issues.push({severity,title,detail,action});
  const ct=accountSnapshot('ctbc'),es=esunSnapshot();
  if(!ct.verified)add('warn','CTBC has no verified bank baseline','Update the CTBC balance from your bank app so the ledger has an authoritative starting point.','ctbc');
  if(ct.verified&&Math.abs(ct.difference)>=0.5)add('critical','CTBC does not reconcile',`Bank vs ledger differs by ${ct.difference>0?'+':''}${money(ct.difference)}.`,'ctbc');
  if(!es.verified)add('warn','E.SUN has no verified bank baseline','Update the E.SUN balance from your bank app.','esun');
  if(es.verified&&!es.bankOk)add('critical','E.SUN bank ledger mismatch',`Bank vs ledger differs by ${es.difference>0?'+':''}${money(es.difference)}.`,'esun');
  if(!es.allocationOk)add('critical','E.SUN purpose allocation mismatch',es.unassigned>0?`${money(es.unassigned)} is unassigned.`:`Virtual buckets exceed tracked E.SUN cash by ${money(Math.abs(es.unassigned))}.`,'esun');
  for(const [id,label] of [['ctbc','CTBC'],['esun','E.SUN']]){
    const rec=latestReconciliation(id),age=daysSince(rec?.date);
    if(age!==null&&age>45)add('warn',`${label} reconciliation is ${age} days old`,'Consider confirming the bank balance before month close.',id);
  }
  const pending=state.transfers.filter(t=>!t.deletedAt&&t.status==='planned');
  if(pending.length)add('warn',`${pending.length} planned transfer${pending.length===1?'':'s'} still pending`,'Planned transfers do not affect balances until completed or deleted.');
  const unrouted=state.incomes.filter(i=>!i.deletedAt&&i.incomeType!=='regular_income'&&i.incomeType!=='reimbursement'&&!routingTransfersForIncome(i.id).length);
  if(unrouted.length)add('warn',`${unrouted.length} supplemental income record${unrouted.length===1?' needs':'s need'} routing`,'Open the funding month or Activity and decide whether the money stays in operating cash, funds a goal, or goes to investments.');
  const negative=state.buckets.filter(b=>Number(state.bucketBalances[b.id]||0)<-0.5);
  for(const b of negative)add('critical',`${b.name} is negative`,`${money(state.bucketBalances[b.id])} indicates a reserve/bucket was used beyond its recorded funding.`);
  const expDup=duplicateGroups(state.expenses.filter(x=>!x.deletedAt),x=>[x.date,Number(x.amount||0),x.categoryId,x.accountId,(x.description||'').trim().toLowerCase()].join('|'));
  const incDup=duplicateGroups(state.incomes.filter(x=>!x.deletedAt),x=>[x.dateReceived,Number(x.amount||0),x.incomeType,x.accountId,(x.description||'').trim().toLowerCase()].join('|'));
  const trDup=duplicateGroups(state.transfers.filter(x=>!x.deletedAt),x=>[x.completedDate||x.plannedDate,Number(x.amount||0),x.fromAccountId,x.toAccountId,x.transferType,x.status].join('|'));
  const dupCount=expDup.length+incDup.length+trDup.length;
  if(dupCount)add('warn',`${dupCount} possible duplicate record group${dupCount===1?'':'s'}`,'These are exact same-day/same-amount matches. Review Activity before deleting anything.');
  const currentMonth=today().slice(0,7);
  for(const p of state.periods.filter(p=>p.state!=='closed'&&p.id<currentMonth))add('warn',`${monthLabel(p.id)} is still open`,'Review, reconcile, sweep and close old funding months so history remains clean.');
  const lastBackup=state.settings.lastBackupAt?new Date(state.settings.lastBackupAt):null;
  const backupAge=lastBackup?Math.floor((Date.now()-lastBackup.getTime())/86400000):null;
  if(backupAge===null)add('info','No JSON backup recorded','Export a backup before major corrections or device changes.');
  else if(backupAge>30)add('info',`Backup is ${backupAge} days old`,'Export a fresh JSON backup.');
  const closedWithoutSnapshot=state.periods.filter(p=>p.state==='closed'&&!state.monthlyCloses.some(c=>(c.id===p.id||c.budgetPeriodId===p.id)&&c.status==='closed'));
  for(const p of closedWithoutSnapshot)add('critical',`${monthLabel(p.id)} is closed without a close snapshot`,'Reopen and close the month again to rebuild the historical snapshot.');
  const severityRank={critical:0,warn:1,info:2};issues.sort((a,b)=>severityRank[a.severity]-severityRank[b.severity]);
  return {issues,critical:issues.filter(x=>x.severity==='critical').length,warn:issues.filter(x=>x.severity==='warn').length,info:issues.filter(x=>x.severity==='info').length,healthy:!issues.some(x=>x.severity==='critical'||x.severity==='warn')};
}
function dataHealthView(){
  const r=dataHealthReport();
  const status=r.healthy?'Healthy':r.critical?`${r.critical} critical issue${r.critical===1?'':'s'}`:`${r.warn} warning${r.warn===1?'':'s'}`;
  const summaryClass=r.critical?'danger-notice':r.warn?'':'good-notice';
  const items=r.issues.length?r.issues.map(x=>`<div class="health-item ${x.severity}"><span class="health-dot">${x.severity==='critical'?'!':x.severity==='warn'?'!':'i'}</span><div><strong>${esc(x.title)}</strong><div class="sub">${esc(x.detail)}</div>${x.action?`<button class="text-btn" data-action="account-audit" data-id="${x.action}">Open ${x.action==='ctbc'?'CTBC':'E.SUN'} audit</button>`:''}</div></div>`).join(''):`<div class="empty compact-empty"><strong>No data-health issues found.</strong><span>Accounts, virtual buckets and month states are internally consistent.</span></div>`;
  return `<div class="notice ${summaryClass}"><strong>${esc(status)}</strong><br>Data Health looks for reconciliation gaps, stale checks, negative buckets, exact duplicate patterns, pending transfers and month-state problems. It never changes data automatically.</div><section class="card health-list" style="margin-top:14px">${items}</section><div class="sub" style="margin-top:12px">Last evaluated live from the records currently stored on this device.</div>`;
}

function isPurposeOnlyTransfer(t){
  return !!t && (t.affectsPhysicalBalance===false || t.fromAccountId===t.toAccountId || ['bucket_allocation','reserve_allocation','allocation_reversal','purpose_reallocation'].includes(t.transferType));
}
function allocationsForTransfer(transferId){return state.transferAllocations.filter(a=>a.transferId===transferId);}
function accountAudit(accountId){
  const a=physicalAccount(accountId),rec=latestReconciliation(accountId);
  const baseline=rec?Number(rec.actualBalance||0):Number(a?.openingBalance||0);
  const baselineDate=rec?.date||null;
  const include=(date,stamp)=>!rec||recordAfterReconciliation(rec,date,stamp);
  const entries=[];
  for(const x of state.incomes.filter(x=>!x.deletedAt&&x.accountId===accountId)){
    const date=x.dateReceived||x.date;if(include(date,x.createdAt||x.updatedAt))entries.push({date,stamp:x.createdAt||x.updatedAt||'',type:'Income',detail:x.description||INCOME_TYPES.find(t=>t[0]===x.incomeType)?.[1]||'Income',delta:Number(x.amount||0),recordId:x.id});
  }
  for(const x of state.expenses.filter(x=>!x.deletedAt&&x.accountId===accountId)){
    if(include(x.date,x.createdAt||x.updatedAt))entries.push({date:x.date,stamp:x.createdAt||x.updatedAt||'',type:'Expense',detail:x.description||category(x.categoryId)?.name||'Expense',delta:-Number(x.amount||0),recordId:x.id});
  }
  for(const t of state.transfers.filter(t=>!t.deletedAt&&t.status==='completed'&&!isPurposeOnlyTransfer(t))){
    const date=t.completedDate||t.plannedDate,stamp=t.completedAt||t.updatedAt||t.createdAt||'';
    if(!include(date,stamp))continue;
    if(t.toAccountId===accountId)entries.push({date,stamp,type:'Bank transfer in',detail:`From ${physicalAccount(t.fromAccountId)?.name||t.fromAccountId}`,delta:Number(t.amount||0),recordId:t.id});
    if(t.fromAccountId===accountId)entries.push({date,stamp,type:'Bank transfer out',detail:`To ${physicalAccount(t.toAccountId)?.name||t.toAccountId}`,delta:-Number(t.amount||0),recordId:t.id});
  }
  for(const x of state.adjustments.filter(x=>!x.deletedAt&&x.accountId===accountId)){
    if(include(x.date,x.createdAt||x.updatedAt))entries.push({date:x.date,stamp:x.createdAt||x.updatedAt||'',type:'Adjustment',detail:x.note||'Account adjustment',delta:Number(x.amount||0),recordId:x.id});
  }
  entries.sort((x,y)=>String(x.date||'').localeCompare(String(y.date||''))||String(x.stamp||'').localeCompare(String(y.stamp||'')));
  let running=baseline;for(const e of entries){running+=e.delta;e.running=running;}
  const accountBucketIds=new Set(state.buckets.filter(b=>b.accountId===accountId).map(b=>b.id));
  const purposeEvents=state.transfers.filter(t=>!t.deletedAt&&t.status==='completed'&&allocationsForTransfer(t.id).some(a=>accountBucketIds.has(a.bucketId))).map(t=>({
    transfer:t,
    allocations:allocationsForTransfer(t.id).filter(a=>accountBucketIds.has(a.bucketId)),
    reversedBy:state.transfers.find(r=>!r.deletedAt&&r.reversalOf===t.id)||null
  })).sort((x,y)=>String(y.transfer.completedDate||y.transfer.plannedDate||'').localeCompare(String(x.transfer.completedDate||x.transfer.plannedDate||''))||String(y.transfer.createdAt||'').localeCompare(String(x.transfer.createdAt||'')));
  return {account:a,reconciliation:rec,baseline,baselineDate,entries,tracked:running,purposeEvents};
}
function canReversePurposeEvent(event){
  const t=event?.transfer;if(!t||event.reversedBy||t.systemGenerated||t.reversalOf)return false;
  return isPurposeOnlyTransfer(t)&&event.allocations.length>0;
}
function completedAllocationToBucket(periodId,bucketId){
  const complete=new Set(state.transfers.filter(t=>t.status==='completed'&&!t.deletedAt&&t.budgetPeriodId===periodId).map(t=>t.id));
  return state.transferAllocations.filter(a=>complete.has(a.transferId)&&a.bucketId===bucketId).reduce((s,a)=>s+Number(a.amount||0),0);
}
function completedTithe(periodId){return completedAllocationToBucket(periodId,'tithe');}
function expectedTithe(periodId){return Math.round(periodEligibleIncome(periodId)*Number(state.settings.tithePercent||10)/100);}
function paydayRequirements(periodId){
  const p=state.periods.find(x=>x.id===periodId);
  if(!p) return {groups:[],totalOutstanding:0,items:[]};
  const plan=planFor(periodId);

  // Reconstruct the goal-routing state from before this funding month's completed
  // allocations so already-completed contributions do not change the original plan.
  const preBalances={...state.bucketBalances};
  for(const b of state.buckets){
    preBalances[b.id]=Number(preBalances[b.id]||0)-completedAllocationToBucket(periodId,b.id);
  }
  const goalAllocs=Array.isArray(p.paydayRoutingSnapshot?.goalAllocs)
    ? p.paydayRoutingSnapshot.goalAllocs
    : allocateGoalSurplus({amount:Math.max(0,Math.round(plan.immediateWealth)),goals:state.goals,bucketBalances:preBalances});

  const intended=[];
  if(Number(plan.tithe||0)>0) intended.push({bucketId:'tithe',amount:Math.round(Number(plan.tithe)),label:'Tithe'});
  for(const a of goalAllocs){
    if(a.bucketId) intended.push({bucketId:a.bucketId,amount:Number(a.amount||0),label:a.label||bucket(a.bucketId)?.name||'Goal'});
  }

  const byDest=new Map();
  for(const item of intended){
    const b=bucket(item.bucketId);
    if(!b?.accountId) continue;
    const completed=completedAllocationToBucket(periodId,item.bucketId);
    const remaining=Math.max(0,Number(item.amount||0)-completed);
    if(remaining<=0.5) continue;
    if(!byDest.has(b.accountId)) byDest.set(b.accountId,[]);
    byDest.get(b.accountId).push({...item,remaining,accountId:b.accountId});
  }

  const investmentTarget=goalAllocs.filter(a=>a.accountId==='ibkr').reduce((sum,a)=>sum+Number(a.amount||0),0);
  const completedInvestment=state.transfers.filter(t=>!t.deletedAt&&t.status==='completed'&&t.budgetPeriodId===periodId&&t.toAccountId==='ibkr'&&t.fromAccountId!=='ibkr').reduce((sum,t)=>sum+Number(t.amount||0),0);
  const investmentRemaining=Math.max(0,investmentTarget-completedInvestment);
  if(investmentRemaining>0.5){
    if(!byDest.has('ibkr')) byDest.set('ibkr',[]);
    byDest.get('ibkr').push({bucketId:null,amount:investmentTarget,remaining:investmentRemaining,label:'Investment contribution',accountId:'ibkr'});
  }

  const groups=[...byDest.entries()].map(([accountId,items])=>({accountId,items,amount:items.reduce((sum,x)=>sum+Number(x.remaining||0),0)})).filter(g=>g.amount>0.5);
  return {groups,totalOutstanding:groups.reduce((sum,g)=>sum+g.amount,0),items:groups.flatMap(g=>g.items)};
}
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
  const ordered=[...state.periods].sort((a,b)=>a.id.localeCompare(b.id)),idx=ordered.findIndex(p=>p.id===selectedPeriodId),older=idx>0?ordered[idx-1]:null,newer=idx>=0&&idx<ordered.length-1?ordered[idx+1]:null;
  return `<div class="period-nav"><button class="period-step" data-action="period-step" data-id="${older?.id||''}" ${older?'':'disabled'} aria-label="Older funding month">‹</button><select id="period-select">${[...ordered].reverse().map(p=>`<option value="${p.id}" ${p.id===selectedPeriodId?'selected':''}>${monthLabel(p.id)} · ${p.state.replaceAll('_',' ')}</option>`).join('')}</select><button class="period-step" data-action="period-step" data-id="${newer?.id||''}" ${newer?'':'disabled'} aria-label="Newer funding month">›</button></div>`;
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
  const plan=planFor(p.id), spent=totalExpenses(p.id), core=completedCoreWealth(p.id), goalFunding=completedGoalFunding(p.id), contributionRate=plan.salary>0?core/plan.salary:0;
  const expTotals=expenseTotals(p.id);const sweep=sweepInfo(p.id);
  const payday=paydayRequirements(p.id);
  const paydayGroup=payday.groups.find(g=>g.amount>0.5);
  const pending=state.transfers.find(t=>t.budgetPeriodId===p.id&&t.status==='planned'&&!['payday','investment_contribution'].includes(t.transferType));
  const unroutedSupplemental=state.incomes.find(i=>!i.deletedAt&&i.budgetPeriodId===p.id&&i.incomeType!=='regular_income'&&i.incomeType!=='reimbursement'&&!routingTransfersForIncome(i.id).length);
  let action=`<button class="btn" data-action="add-expense">Add Expense</button>`;
  let actionText='Keep the ledger current';let actionSub='Record spending as it happens.';let actionMetric=money(sweep.available);
  if(p.state==='closed'){
    actionText=`${monthLabel(p.id)} is closed`;actionSub='Period-linked records are locked until you intentionally reopen the month.';actionMetric='Locked';action=`<button class="btn" data-action="reopen-period" data-id="${p.id}">Reopen Month</button>`;
  } else if(paydayGroup){
    const destination=physicalAccount(paydayGroup.accountId)?.name||paydayGroup.accountId;
    const detail=paydayGroup.items.map(x=>`${x.label} ${money(x.remaining)}`).join(' · ');
    actionText=`Transfer to ${destination}`;
    actionSub=`${detail}. Move only this remaining amount physically, then confirm it here.`;
    actionMetric=money(paydayGroup.amount);
    action=`<button class="btn" data-action="payday-transfer" data-account="${paydayGroup.accountId}" data-period="${p.id}">Record Transfer Completed</button>`;
  } else if(pending){
    actionText=`Transfer ${money(pending.amount)} pending`;actionSub=`Move the money physically, then confirm it here.`;actionMetric=money(pending.amount);action=`<button class="btn" data-action="complete-transfer" data-id="${pending.id}">Mark Transfer Completed</button>`;
  } else if(unroutedSupplemental){
    const due=unroutedSupplemental.titheEligible?Math.round(Number(unroutedSupplemental.amount||0)*Number(state.settings.tithePercent||10)/100):0;
    actionText='Route supplemental income';actionSub=`${INCOME_TYPES.find(t=>t[0]===unroutedSupplemental.incomeType)?.[1]||'Supplemental income'} ${money(unroutedSupplemental.amount)}${due?` · tithe due ${money(due)}`:''}. Decide what the remainder should do.`;actionMetric=money(unroutedSupplemental.amount);action=`<button class="btn" data-action="route-income" data-id="${unroutedSupplemental.id}">Open Routing Assistant</button>`;
  }
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
    <section class="card"><div class="metric-label">Wealth contributed</div><div class="metric">${money(core)}</div><div class="sub">${pct(contributionRate)} of take-home</div></section>
  </div>
  <div class="section-title"><h2>Flexible budget</h2><span class="sub">Potential month-end sweep ${money(sweep.available)}</span></div>
  <section class="card">${budgetMini('Food',food?.budgetAmount||0,foodSpent)}${budgetMini('Dating / Social',social?.budgetAmount||0,socialSpent)}</section>
  <div class="section-title"><h2>Next action</h2></div><section class="card hero-action"><div class="metric-label">${actionText}</div><div class="metric">${actionMetric}</div><p class="sub">${actionSub}</p>${action}</section>
  ${homeQuickCapture(p)}
  <div class="section-title"><h2>Monthly flow</h2></div><section class="card">
    ${row('Planned immediate wealth',money(Math.max(0,plan.immediateWealth)))}${row('Completed goal/reserve funding',money(goalFunding))}${row('Current sweep available',money(sweep.available))}
    <div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="add-income">Add Income</button><button class="btn secondary" data-action="month-close">Month-End Review</button></div>
  </section>`;
}

function homeQuickCapture(p){
  const recent=activityRecords().filter(x=>!p||x.budgetPeriodId===p.id).slice(0,3);
  return `<div class="section-title"><h2>Quick capture</h2><span class="sub">Common actions</span></div>
  <div class="quick-action-grid"><button class="quick-action" data-action="add-expense">${icon('expense')}<span>Expense</span></button><button class="quick-action" data-action="add-income">${icon('income')}<span>Income</span></button><button class="quick-action" data-action="manual-transfer">${icon('transfer')}<span>Transfer</span></button></div>
  <section class="card mini-activity">${recent.length?recent.map(x=>`<div class="mini-activity-row"><div><strong>${esc(x._title)}</strong><div class="sub">${esc(x._date||'')} · ${esc(x._account||'')}</div></div><span class="amount ${x._kind==='expense'?'bad':x._kind==='income'?'good':''}">${x._kind==='transfer'?'↔ ':''}${money(x._amount)}</span></div>`).join(''):`<div class="empty compact-empty"><strong>No activity in this month yet.</strong><span>Use the buttons above for fast entry.</span></div>`}</section>`;
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
  const sweep=sweepInfo(p.id),close=monthCloseStatus(p.id),closed=p.state==='closed';
  const lock=closed?`<div class="notice close-lock"><strong>Month closed</strong><br>${monthLabel(p.id)} is read-only. Reopen it intentionally before changing transactions or budget-linked records.</div>`:'';
  return `<div class="split"><div><h2 style="margin:0">Budget</h2><div class="sub">${monthLabel(p.id)} · Plan vs actual</div></div>${periodSelector()}</div>
  ${lock}
  <div class="budget-overview" style="margin-top:14px">
    ${budgetKpi('Income',money(plan.salary),'Exact take-home')}
    ${budgetKpi('Fixed',`${money(fixedActual)} / ${money(plan.fixed)}`,`${money(Math.max(0,plan.fixed-fixedActual))} remaining`)}
    ${budgetKpi('Flexible',`${money(flexActual)} / ${money(plan.caps)}`,`${money(plan.caps-flexActual)} remaining`,flexActual>plan.caps)}
    ${budgetKpi('Reserves',`${money(reserveFunded)} / ${money(plan.sinking)}`,'Completed funding')}
    ${budgetKpi('Wealth',`${money(wealthDone)} / ${money(Math.max(0,plan.immediateWealth))}`,'Completed core-wealth transfers')}
    ${budgetKpi('Buffer',money(plan.buffer),`Potential sweep ${money(sweep.available)}`)}
  </div>
  <div class="section-title"><h2>Monthly flow</h2><span class="sub">What this paycheck is doing</span></div>
  <section class="card flow-card">
    ${row('Tithe',`${money(titheAllocated)} / ${money(expectedTithe(p.id))}`)}
    ${row('Fixed obligations',`${money(fixedActual)} / ${money(plan.fixed)}`)}
    ${row('Flexible spending',`${money(flexActual)} / ${money(plan.caps)}`)}
    ${row('Reserve funding',`${money(reserveFunded)} / ${money(plan.sinking)}`)}
    ${row('Operating buffer',money(plan.buffer))}
    ${row('Immediate wealth capacity',money(Math.max(0,plan.immediateWealth)))}
    ${row('Potential month-end sweep',money(sweep.available))}
  </section>
  ${fixedObligationsView(p.id,plan,totals,closed)}
  ${budgetGroup('Fixed',lines,p.id)}
  ${budgetGroup('Flexible',lines,p.id)}
  ${budgetGroup('Reserve',lines,p.id)}
  ${budgetGroup('Giving',lines,p.id)}
  ${budgetGroup('Buffer',lines,p.id)}
  <div class="section-title"><h2>Month close</h2><span class="tag ${closed?'good-tag':close.ready?'good-tag':'warn-tag'}">${closed?'Closed':close.ready?'Ready':'Review'}</span></div>
  <section class="card close-summary-card"><div><strong>${closed?`${monthLabel(p.id)} is closed`:'Reconcile, sweep and lock the month'}</strong><div class="sub">${closed?'Period-linked records are protected until you reopen the month.':close.hardBlockers.length?`${close.hardBlockers.length} item${close.hardBlockers.length===1?'':'s'} still need attention.`:'Core close checks are clear.'}</div></div><button class="btn ${closed?'secondary':''}" data-action="month-close">${closed?'View Close Summary':'Month-End Review'}</button></section>
  ${fundingMonthControls(p)}`;
}

function fixedObligationsView(periodId,plan,totals,closed){
  const lines=plan.lines.filter(x=>x.ruleType==='fixed');
  if(!lines.length)return '';
  const paidCount=lines.filter(x=>Number(totals[x.id]||0)+0.5>=Number(x.budgetAmount||0)).length;
  return `<div class="section-title"><h2>Recurring obligations</h2><span class="sub">${paidCount} of ${lines.length} covered</span></div><section class="card obligation-list"><div class="sub" style="padding:0 0 10px">Expected obligations appear every funding month, but Wealth OS creates an expense only when you record the payment.</div>${lines.map(x=>{const actual=Number(totals[x.id]||0),planned=Number(x.budgetAmount||0),remaining=Math.max(0,planned-actual),paid=remaining<=0.5;return `<div class="obligation-row"><div class="obligation-status ${paid?'done':''}">${paid?'✓':'•'}</div><div class="obligation-copy"><strong>${esc(x.name)}</strong><div class="sub">Recurring monthly · ${money(actual)} of ${money(planned)}${paid?' · paid':actual>0?' · partially recorded':''}</div></div>${!paid&&!closed?`<button class="btn ghost small" data-action="record-fixed" data-category="${x.id}" data-amount="${remaining}">Record ${money(remaining)}</button>`:`<span class="tag ${paid?'good-tag':''}">${paid?'Paid':money(remaining)+' left'}</span>`}</div>`;}).join('')}</section>`;
}

function budgetKpi(label,value,sub,bad=false){return `<section class="card budget-kpi"><div class="metric-label">${label}</div><div class="kpi-value ${bad?'bad':''}">${value}</div><div class="sub">${sub}</div></section>`;}
function fundingMonthControls(p){
  const completed=state.transfers.filter(t=>!t.deletedAt&&t.budgetPeriodId===p.id&&t.status==='completed'&&!(t.systemGenerated&&t.fromAccountId===t.toAccountId&&t.transferType==='reserve_allocation'));
  const closed=p.state==='closed';
  if(closed){
    return `<div class="section-title"><h2>Funding month controls</h2></div><section class="card"><div class="split"><div><strong>Reopen ${monthLabel(p.id)}</strong><div class="sub">Use this only to correct a closed month. Changes may require a new reconciliation or sweep correction.</div></div><button class="btn secondary" data-action="reopen-period" data-id="${p.id}">Reopen Month</button></div></section>`;
  }
  const warning=completed.length?`${completed.length} completed transfer${completed.length===1?'':'s'} must be resolved before this month can be deleted.`:'Use this to remove a test or mistaken funding month and all of its period-linked draft data.';
  return `<div class="section-title"><h2>Funding month controls</h2></div><section class="card danger-zone"><div class="split"><div><strong>Delete ${monthLabel(p.id)} funding month</strong><div class="sub">${warning}</div></div><button class="btn danger" data-action="delete-period" data-id="${p.id}">Delete Month</button></div></section>`;
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
  const budget=x.ruleType==='percentage'?expectedTithe(periodId):Number(x.budgetAmount||0),remaining=budget-actual,ratio=budget?Math.max(0,Math.min(1,actual/budget)):0;
  return `<div class="budget-category"><div class="split"><div><strong>${esc(x.name)}</strong><div class="sub">${actualLabel} ${money(actual)} · ${remaining>=0?`${money(remaining)} left`:`${money(Math.abs(remaining))} over`}</div></div><div class="budget-numbers"><strong class="${remaining<0?'bad':''}">${money(actual)} / ${money(budget)}</strong><span>${pct(ratio)}</span></div></div><div class="progress ${remaining<0?'over':''}"><span style="width:${Math.min(100,ratio*100)}%"></span></div></div>`;
}

function transactionsView(){
  const all=activityRecords();
  const q=activitySearch.trim().toLowerCase();
  const filtered=activityFilter==='all'?all:all.filter(x=>x._kind===activityFilter);
  const list=q?filtered.filter(x=>[x._title,x._detail,x._account,x._date,x.description,category(x.categoryId)?.name].filter(Boolean).join(' ').toLowerCase().includes(q)):filtered;
  return `<div><h2 style="margin:0">Activity</h2><div class="sub">Expenses, income and transfers</div></div>
  <div class="activity-actions">
    <button class="activity-action-card" data-action="add-expense"><span class="action-icon">${icon('expense')}</span><span class="action-copy"><strong>Add Expense</strong><span>Record money actually spent on goods, services or obligations.</span></span><span class="action-chevron">›</span></button>
    <button class="activity-action-card" data-action="add-income"><span class="action-icon">${icon('income')}</span><span class="action-copy"><strong>Add Income</strong><span>Salary, bonus, reimbursement, asset sale or other money received.</span></span><span class="action-chevron">›</span></button>
    <button class="activity-action-card" data-action="manual-transfer"><span class="action-icon">${icon('transfer')}</span><span class="action-copy"><strong>Add Transfer</strong><span>Move money between accounts or assign it to a virtual bucket.</span></span><span class="action-chevron">›</span></button>
  </div>
  <div class="section-title"><h2>Recent activity</h2><span class="sub">${list.length} shown</span></div>
  <form id="activity-search-form" class="activity-search"><input id="activity-search-input" type="search" value="${esc(activitySearch)}" placeholder="Search description, category or account"><button class="btn ghost small" type="submit">Search</button>${activitySearch?'<button class="btn ghost small" type="button" data-action="clear-activity-search">Clear</button>':''}</form>
  <div class="filter-chips">${[['all','All'],['expense','Expenses'],['income','Income'],['transfer','Transfers']].map(([id,label])=>`<button class="filter-chip ${activityFilter===id?'active':''}" data-action="activity-filter" data-filter="${id}">${label}</button>`).join('')}</div>
  <section class="card activity-list">${list.length?list.slice(0,150).map(txLine).join(''):`<div class="empty compact-empty"><strong>No matching activity.</strong><span>Try another filter or search term.</span></div>`}</section>`;
}

function txLine(x){
  const meta=[x._date,x._account,x._detail].filter(Boolean).join(' · ');
  const protectedIncome=x._kind==='income'&&x.systemGenerated===true;
  const plannedTransfer=x._kind==='transfer'&&x.status==='planned';
  const canEdit=!protectedIncome&&(x._kind!=='transfer'||x.transferType==='manual');
  const canDelete=!protectedIncome&&(x._kind!=='transfer'||x.transferType==='bucket_allocation'||(plannedTransfer&&['manual','goal_contribution','supplemental_income_routing'].includes(x.transferType)));
  const canComplete=plannedTransfer;
  const canRoute=x._kind==='income'&&x.incomeType!=='regular_income'&&!routingTransfersForIncome(x.id).length&&!isClosedPeriod(x.budgetPeriodId);
  const canRepeat=x._kind==='expense'&&!!entryPeriodId();
  const amount=money(x._amount);
  return `<div class="tx"><div class="tx-main"><div class="tx-title">${esc(x._title)}</div><div class="tx-meta">${esc(meta)}</div><div class="tx-actions">${canComplete?`<button class="text-btn" data-action="complete-transfer" data-id="${x.id}">Complete</button>`:''}${canRoute?`<button class="text-btn" data-action="route-income" data-id="${x.id}">Route</button>`:''}${canRepeat?`<button class="text-btn" data-action="repeat-expense" data-id="${x.id}">Repeat</button>`:''}${canEdit?`<button class="text-btn" data-action="edit-transaction" data-kind="${x._kind}" data-id="${x.id}">Edit</button>`:''}${canDelete?`<button class="text-btn danger-text" data-action="delete-transaction" data-kind="${x._kind}" data-id="${x.id}">Delete</button>`:''}</div></div><div class="right"><div class="amount ${x._kind==='income'?'good':x._kind==='expense'?'bad':''}">${x._kind==='transfer'?'↔ ':''}${amount}</div><span class="tag ${plannedTransfer?'warn-tag':''}">${plannedTransfer?'planned':x._kind}</span></div></div>`;
}

function goalsView(){
  const emergency=goal('goal-emergency'),travel=goal('goal-home-trip');
  const emergencyBal=emergency?goalBal(emergency):0,travelBal=travel?goalBal(travel):0;
  const active=activeGoal(state.goals,state.bucketBalances),pace=currentPaceMonthly();
  const strategyForecast=scenarioFor(Number(state.settings.forecastInvestmentReturn||7),Number(state.settings.forecastSalaryGrowth||3),0,forecastBaselineSalary());
  const cards=[...state.goals].sort((a,b)=>a.priority-b.priority).map(g=>{
    const b=goalBal(g),target=Number(g.targetAmount||0),p=target?Math.min(1,b/target):0,remaining=Math.max(0,target-b),status=goalStatus(g);
    let rule='Manual goal';
    if(g.id==='goal-emergency')rule='Primary core-wealth goal';
    if(g.id==='goal-home-trip')rule=`Unlocks at ${money(g.prerequisiteAmount||0)} Emergency Fund · then ${money(g.monthlyTarget||0)}/month`;
    if(g.id==='goal-equipment')rule='Paused unless you deliberately activate it';
    let paceText=goalPaceText(g);
    if(g.id==='goal-home-trip'&&status.key==='waiting')paceText=`Expected unlock: ${dateAfterMonths(strategyForecast.sim.events.travelUnlockMonth)}`;
    return `<section class="card goal-card"><div class="split"><div><strong>${esc(g.name)}</strong><div class="sub">${esc(rule)}</div></div><span class="tag ${status.className}">${status.label}</span></div><div class="goal-metric-row"><div><div class="metric">${money(b)}</div><div class="sub">${money(remaining)} remaining</div></div><div class="right"><strong>${pct(p)}</strong><div class="sub">of ${money(target)}</div></div></div><div class="progress"><span style="width:${p*100}%"></span></div><div class="goal-pace">${esc(paceText)}</div>${g.targetDate?`<div class="sub">Target date: ${esc(g.targetDate)}</div>`:''}<div class="actions goal-actions"><button class="btn secondary" data-action="goal-contribution" data-id="${g.id}">Add Contribution</button><button class="btn ghost" data-action="edit-goal" data-id="${g.id}">Edit Goal</button></div></section>`;
  }).join('');
  return `<div><h2 style="margin:0">Goals</h2><div class="sub">Your wealth priorities, pace and planned-use funds.</div></div>
  <section class="card strategy-card" style="margin-top:14px"><div class="split"><div><div class="metric-label">Current routing strategy</div><strong>${esc(active?.name||'Core cash goals complete')}</strong></div><div class="right"><strong>${money(pace)}</strong><div class="sub">recent monthly core-wealth pace</div></div></div><div class="strategy-steps"><span class="${emergencyBal<200000?'active-step':''}">1. Emergency to ${money(200000)}</span><span class="${emergencyBal>=200000&&travelBal<(travel?.targetAmount||100000)?'active-step':''}">2. Home Travel ${money(travel?.monthlyTarget||10000)}/mo + continue Emergency</span><span class="${emergencyBal>=(emergency?.targetAmount||300000)?'active-step':''}">3. After Emergency target, remaining surplus becomes investable</span></div></section>
  <div class="grid g2 goals-grid" style="margin-top:14px">${cards}</div>`;
}

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
    <div class="account-balance-head"><div><div class="metric-label">Tracked current balance</div><div class="metric">${money(ct.actual)}</div>${ct.verified?`<div class="sub">Last checked ${esc(ct.reconciliation.date||'')}${ct.isEstimated?' · updated by recorded activity':''}</div>`:`<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid two-col">
      <div><span class="sub">Ledger expected</span><strong>${money(ct.expected)}</strong></div>
      <div><span class="sub">Bank vs ledger</span><strong class="${Math.abs(ct.difference)<0.5?'good':ct.difference<0?'bad':'warn'}">${ct.difference>0?'+':''}${money(ct.difference)}</strong></div>
    </div>
    <div class="row"><div><strong>Electricity Reserve</strong><div class="sub">Virtual reserve held inside CTBC · no bank transfer required</div></div><strong class="amount">${money(state.bucketBalances.electricity||0)}</strong></div>
    <div class="actions account-actions"><button class="btn secondary" data-action="account-reconcile" data-id="ctbc">Update Balance</button><button class="btn ghost" data-action="account-audit" data-id="ctbc">Audit Trail</button><button class="btn ghost" data-action="account-adjustment" data-id="ctbc">Add Adjustment</button></div>
  </section>

  <div class="section-title"><h2>E.SUN Reserved</h2><span class="tag${esStatusClass}">${esStatus}</span></div>
  <section class="card esun-card">
    <div class="account-balance-head"><div><div class="metric-label">Tracked current balance</div><div class="metric">${money(es.actual)}</div>${es.verified?`<div class="sub">Last checked ${esc(es.reconciliation.date||'')}${es.isEstimated?' · updated by recorded activity':''}</div>`:`<div class="sub">Using ledger balance until you confirm it</div>`}</div></div>
    <div class="reconcile-grid">
      <div><span class="sub">Ledger expected</span><strong>${money(es.expected)}</strong></div>
      <div><span class="sub">Virtual allocated</span><strong>${money(es.virtualTotal)}</strong></div>
      <div><span class="sub">Bank reconciliation</span><strong class="${es.bankOk?'good':es.difference<0?'bad':'warn'}">${es.bankOk?'Matched':`${es.difference>0?'+':''}${money(es.difference)}`}</strong></div>
      <div><span class="sub">Purpose allocation</span><strong class="${es.allocationOk?'good':'warn'}">${allocationText}</strong></div>
    </div>
    ${!es.allocationOk?`<div class="allocation-callout"><div><strong>${es.unassigned>0?`${money(es.unassigned)} needs a purpose`:`Allocations exceed the bank balance by ${money(Math.abs(es.unassigned))}`}</strong><div class="sub">Assign or reduce virtual buckets explicitly. Wealth OS will never guess.</div></div><button class="btn" data-action="esun-allocate">${es.unassigned>0?'Assign Money':'Reduce Allocation'}</button></div>`:''}
    <div class="actions account-actions"><button class="btn secondary" data-action="account-reconcile" data-id="esun">Update Balance</button><button class="btn ghost" data-action="account-audit" data-id="esun">Audit Trail</button><button class="btn ghost" data-action="esun-reallocate">Reallocate Purpose</button><button class="btn ghost" data-action="account-adjustment" data-id="esun">Add Adjustment</button></div>
  </section>
  <div class="section-title"><h2>E.SUN virtual composition</h2><span class="sub">Purpose ledger</span></div><section class="card">${state.buckets.filter(b=>b.accountId==='esun').map(b=>row(b.name,money(state.bucketBalances[b.id]||0))).join('')}<div class="row"><strong>Virtual total</strong><strong class="amount">${money(es.virtualTotal)}</strong></div>${!es.allocationOk?`<div class="row"><strong>${es.unassigned>0?'Unassigned':'Over-allocated'}</strong><strong class="amount ${es.unassigned<0?'bad':'warn'}">${es.unassigned>0?'+':''}${money(es.unassigned)}</strong></div>`:''}</section>
  <div class="section-title"><h2>Investments</h2></div><section class="card">${row('IBKR current value',money(latestInvestmentTwd()))}${row('USD/TWD rate',Number(fx).toFixed(2))}<div class="actions" style="margin-top:12px"><button class="btn secondary" data-action="investment-snapshot">Update IBKR Value</button></div></section>`;
}
function accountHealthRow(name,value,status,statusClass=''){return `<div class="account-health-row"><div><strong>${esc(name)}</strong><div class="sub">${money(value)}</div></div><span class="tag${statusClass}">${esc(status)}</span></div>`;}


function forecastView(){
  const records=historyRecords(),recent=records.slice(-6),current=records.at(-1)||null,previous=records.length>1?records.at(-2):null;
  const year=today().slice(0,4),annual=yearSummary(year),recent3=records.slice(-3),avgRate=recent3.length?recent3.reduce((s,x)=>s+x.contributionRate,0)/recent3.length:0;
  const salary=Number(current?.regularIncome||forecastBaselineSalary()||0);
  const base=scenarioFor(Number(state.settings.forecastInvestmentReturn||7),Number(state.settings.forecastSalaryGrowth||3),0,salary);
  const conservative=scenarioFor(Number(state.settings.conservativeInvestmentReturn||4),Number(state.settings.conservativeSalaryGrowth||1),0,salary);
  const aggressive=scenarioFor(Number(state.settings.aggressiveInvestmentReturn||9),Number(state.settings.aggressiveSalaryGrowth||5),0,salary);
  const currentRate=current?.contributionRate||0;
  const netWorthRecords=records.filter(x=>x.financialNetWorth!==null),coreRecords=records.filter(x=>x.coreWealth!==null);
  const compare=previous&&current?`<section class="card comparison-card">
    ${comparisonLine('Income',current.totalIncome,previous.totalIncome,false)}
    ${comparisonLine('Spending',current.expenses,previous.expenses,true)}
    ${comparisonLine('Core wealth contributed',current.wealthContribution,previous.wealthContribution,false)}
    ${comparisonLine('Contribution rate',current.contributionRate,previous.contributionRate,false,true)}
  </section>`:`<div class="notice"><strong>Monthly comparison needs one more funding month.</strong><br>Once two months exist, Wealth OS will show what changed in income, spending and wealth contributions.</div>`;
  const flexCats=state.categories.filter(c=>c.ruleType==='cap');
  const catRows=flexCats.map(c=>{
    const samples=recent3.map(r=>Number(r.actuals?.[c.id]||0));const avg=samples.length?samples.reduce((a,b)=>a+b,0)/samples.length:0;const cur=Number(current?.actuals?.[c.id]||0),budget=Number((planFor(current?.id||currentPeriod()?.id)?.lines?.find(x=>x.id===c.id)?.budgetAmount??c.defaultAmount) || 0);
    return {c,avg,cur,budget};
  }).sort((a,b)=>b.avg-a.avg);
  const catHistory=records.length<2?`<div class="notice"><strong>Category trends are still building.</strong><br>After another month, 3-month averages and recurring over/under-budget patterns will appear here.</div>`:`<section class="card insight-list">${catRows.map(x=>`<div class="insight-row"><div><strong>${esc(x.c.name)}</strong><div class="sub">Current ${money(x.cur)} · ${Math.min(3,recent3.length)}-mo avg ${money(x.avg)}</div></div><div class="right"><strong class="${x.avg>x.budget?'bad':x.avg<x.budget*.8?'good':''}">${money(x.budget)}</strong><div class="sub">monthly cap</div></div></div>`).join('')}</section>`;
  return `<div><h2 style="margin:0">Insights & Forecast</h2><div class="sub">Use actual history to understand the month, then model what comes next.</div></div>
  <div class="grid g3 summary-grid" style="margin-top:14px">
    <section class="card"><div class="metric-label">Current contribution rate</div><div class="metric">${pct(currentRate)}</div><div class="sub">Core wealth ÷ regular take-home</div></section>
    <section class="card"><div class="metric-label">Recent average</div><div class="metric">${pct(avgRate)}</div><div class="sub">${recent3.length}-month contribution rate</div></section>
    <section class="card"><div class="metric-label">${year} wealth contributed</div><div class="metric">${money(annual.wealth)}</div><div class="sub">Recorded core-wealth contributions</div></section>
  </div>

  <div class="section-title"><h2>Monthly comparison</h2><span class="sub">Latest vs previous funding month</span></div>${compare}

  <div class="section-title"><h2>Contribution history</h2><span class="sub">Completed core-wealth transfers</span></div>
  <section class="card">${recent.length?contributionBars(recent):'<div class="empty compact-empty"><strong>No funding-month history yet.</strong></div>'}</section>

  <div class="section-title"><h2>Core wealth trend</h2><span class="sub">Month-end snapshots + current month</span></div>
  <section class="card">${coreRecords.length>=2?trendSvg(coreRecords,'coreWealth'):`<div class="empty compact-empty"><strong>Not enough snapshots yet.</strong><span>Close another month to build a meaningful wealth trend.</span></div>`}</section>

  <div class="section-title"><h2>Flexible spending trends</h2><span class="sub">Recent behavior vs your caps</span></div>${catHistory}

  <div class="section-title"><h2>${year} recorded summary</h2><span class="sub">Only data entered in Wealth OS</span></div>
  <div class="grid g2 annual-grid">
    ${insightKpi('Income',annual.income,'All recorded income')}
    ${insightKpi('Expenses',annual.expenses,'Actual spending')}
    ${insightKpi('Tithe contributed',annual.tithe,'Net Tithe additions · purpose reallocations excluded')}
    ${insightKpi('Emergency added',annual.emergency,'Completed Emergency contributions')}
    ${insightKpi('Invested',annual.investments,'Transfers into IBKR')}
    ${insightKpi('Net-worth change',annual.netWorthChange===null?'—':signedMoney(annual.netWorthChange),annual.netWorthChange===null?'Need 2 recorded snapshots':'From first to latest recorded snapshot')}
  </div>

  <div class="section-title"><h2>Forecast assumptions</h2><span class="sub">What the base forecast is actually using</span></div>
  <section class="card forecast-assumptions">
    ${row('Take-home salary baseline',money(salary))}
    ${row('Current Emergency Fund',money(state.bucketBalances.emergency||0))}
    ${row('Starting monthly wealth capacity',money(base.monthly))}
    ${row('Home Travel unlock threshold',money(goal('goal-home-trip')?.prerequisiteAmount||200000))}
    ${row('Emergency Fund target',money(goal('goal-emergency')?.targetAmount||300000))}
    ${row('Home Travel monthly routing after unlock',money(goal('goal-home-trip')?.monthlyTarget||10000))}
    ${row('Current investments',money(latestInvestmentTwd()))}
    ${row('Raise captured to wealth',`${Number(state.settings.wealthRaisePercent||75)}%`)}
    <div class="sub" style="margin-top:10px">Emergency cash earns 0% in the model. Investment-return assumptions apply only to IBKR. When Home Travel unlocks, its monthly target temporarily reduces what flows to the Emergency Fund.</div>
  </section>

  <div class="section-title"><h2>Planning scenarios</h2><span class="sub">Salary growth and investment return modeled separately</span></div>
  <div class="grid g3 scenario-grid">
    ${scenarioCard('Conservative',conservative)}
    ${scenarioCard('Base',base,true)}
    ${scenarioCard('Aggressive',aggressive)}
  </div>
  <div class="section-title"><h2>Base milestones</h2><span class="sub">${base.returnPct}% return · ${base.growthPct}% annual salary growth</span></div>
  <section class="card forecast-events">${row(`Home Travel unlock · Emergency ${money(goal('goal-home-trip')?.prerequisiteAmount||200000)}`,formatMonths(base.sim.events.travelUnlockMonth))}${row(`Emergency Fund complete · ${money(goal('goal-emergency')?.targetAmount||300000)}`,formatMonths(base.sim.events.emergencyCompleteMonth))}${row('Home Travel funded',formatMonths(base.sim.events.travelCompleteMonth))}${base.targets.map(t=>row(money(t),formatMonths(base.sim.hits[t]))).join('')}</section>

  <div class="section-title"><h2>Long-range checkpoints</h2><span class="sub">Base scenario; return applies only to investments</span></div>
  <div class="grid g2 forecast-checkpoints">${base.sim.snapshots.map(x=>`<section class="card"><div class="metric-label">Year ${x.month/12}</div><div class="metric">${money(x.coreWealth)}</div><div class="sub">Emergency ${money(x.emergency)} · Investments ${money(x.investment)}</div><div class="sub">Modeled salary ${money(x.salary)}</div></section>`).join('')}</div>

  <div class="section-title"><h2>Scenario lab</h2></div><section class="card"><div class="notice">Test take-home salary, annual salary growth, investment return, or an extra monthly wealth contribution. This never changes your real budget.</div><div class="form-grid" style="margin-top:12px"><div class="field"><label>Take-home salary</label><input id="scenario-salary" type="number" value="${Math.round(salary)}"></div><div class="field"><label>Annual salary growth (%)</label><input id="scenario-growth" type="number" step="0.1" value="${Number(state.settings.forecastSalaryGrowth||3)}"></div><div class="field"><label>Annual investment return (%)</label><input id="scenario-return" type="number" step="0.1" value="${Number(state.settings.forecastInvestmentReturn||7)}"></div><div class="field"><label>Extra monthly wealth contribution</label><input id="scenario-extra" type="number" step="1" value="0"></div></div><button class="btn" data-action="run-scenario">Run Scenario</button><div id="scenario-result" style="margin-top:12px"></div></section>`;
}
function insightKpi(label,value,sub){return `<section class="card insight-kpi"><div class="metric-label">${esc(label)}</div><div class="kpi-value">${typeof value==='number'?money(value):value}</div><div class="sub">${esc(sub)}</div></section>`;}
function comparisonLine(label,current,previous,lowerIsBetter=false,isPercent=false){const delta=Number(current||0)-Number(previous||0),good=lowerIsBetter?delta<0:delta>0,bad=lowerIsBetter?delta>0:delta<0;const value=isPercent?pct(current):money(current),deltaText=isPercent?`${delta>0?'+':''}${(delta*100).toFixed(1)} pp`:signedMoney(delta);return `<div class="comparison-line"><div><strong>${esc(label)}</strong><div class="sub">Previous ${isPercent?pct(previous):money(previous)}</div></div><div class="right"><strong>${value}</strong><div class="sub ${good?'good':bad?'bad':''}">${deltaText}</div></div></div>`;}
function scenarioCard(label,s,featured=false){return `<section class="card scenario-card ${featured?'featured':''}"><div class="split"><strong>${esc(label)}</strong>${featured?'<span class="tag good-tag">Base</span>':''}</div><div class="scenario-assumptions">${s.returnPct}% investment return · ${s.growthPct}% salary growth</div><div class="scenario-milestone"><span>Emergency complete</span><strong>${formatMonths(s.sim.events.emergencyCompleteMonth)}</strong></div><div class="scenario-milestone"><span>${money(1000000)}</span><strong>${formatMonths(s.sim.hits[1000000])}</strong></div><div class="scenario-milestone"><span>${money(5000000)}</span><strong>${formatMonths(s.sim.hits[5000000])}</strong></div></section>`;}

function renderModal(){
  if(modal.type==='paycheck') return modalWrap('New Paycheck',paycheckForm());
  if(modal.type==='expense') return modalWrap(modal.id?'Edit Expense':'Add Expense',expenseForm(modal.id?state.expenses.find(x=>x.id===modal.id):null,modal.prefill||null,modal.periodId||null));
  if(modal.type==='income') return modalWrap(modal.id?'Edit Income':'Add Income',incomeForm(modal.id?state.incomes.find(x=>x.id===modal.id):null));
  if(modal.type==='income-routing') return modalWrap('Route Supplemental Income',incomeRoutingView(modal.incomeId));
  if(modal.type==='manual-transfer'){const x=modal.draft?{id:modal.draft.id||'',amount:modal.draft.amount,fromAccountId:modal.draft.from,toAccountId:modal.draft.to,budgetPeriodId:modal.draft.periodId,status:modal.draft.status,plannedDate:modal.draft.date,completedDate:modal.draft.status==='completed'?modal.draft.date:null,_bucketId:modal.draft.bucketId}:modal.id?state.transfers.find(x=>x.id===modal.id):null;return modalWrap(modal.id?'Edit Transfer':'Record Transfer',manualTransferForm(x));}
  if(modal.type==='transfer') return modalWrap('Confirm Transfer',transferConfirm(modal.id));
  if(modal.type==='payday-transfer') return modalWrap('Confirm Payday Transfer',paydayTransferConfirm(modal.periodId,modal.accountId));
  if(modal.type==='close') return modalWrap('Month-End Review',monthCloseView());
  if(modal.type==='settings') return modalWrap('Settings',settingsView());
  if(modal.type==='data-health') return modalWrap('Data Health',dataHealthView());
  if(modal.type==='investment') return modalWrap('Update IBKR Value',investmentForm());
  if(modal.type==='account-reconcile') return modalWrap(`Update ${physicalAccount(modal.accountId)?.name||'Account'} Balance`,accountReconciliationForm(modal.accountId));
  if(modal.type==='reconcile-preview') return modalWrap('Review Balance Update',reconciliationPreviewView());
  if(modal.type==='account-audit') return modalWrap(`${physicalAccount(modal.accountId)?.name||'Account'} Audit Trail`,accountAuditView(modal.accountId));
  if(modal.type==='account-adjustment') return modalWrap(`Add ${physicalAccount(modal.accountId)?.name||'Account'} Adjustment`,accountAdjustmentForm(modal.accountId));
  if(modal.type==='esun-allocate') return modalWrap('Assign E.SUN Money',esunAllocationForm());
  if(modal.type==='esun-reallocate') return modalWrap('Reallocate E.SUN Purpose',esunReallocationForm());
  if(modal.type==='manual-transfer-review') return modalWrap('Review Bank Transfer',manualTransferReview());
  if(modal.type==='delete-period') return modalWrap('Delete Funding Month',deleteFundingMonthView(modal.periodId));
  if(modal.type==='edit-goal') return modalWrap('Edit Goal',goalEditForm(modal.goalId));
  if(modal.type==='goal-contribution') return modalWrap('Add Goal Contribution',goalContributionForm(modal.goalId));
  return '';
}
function modalWrap(title,body){return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" onclick="event.stopPropagation()"><div class="split"><h3>${title}</h3><button class="btn ghost small" data-action="close-modal">Close</button></div>${body}</section></div>`;}
function paycheckForm(){const d=today(),mid=nextMonthId(d);return `<form id="paycheck-form"><div class="field"><label>Exact take-home salary</label><input name="amount" type="number" min="0" step="1" required placeholder="e.g. 82137"></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${d}" required></div><div class="field"><label>Funding month</label><input name="period" type="month" value="${mid}" required></div></div><div class="notice">The paycheck date and funding month are separate. A salary received at month-end can fund the following month.</div><button class="btn" style="margin-top:14px;width:100%">Calculate & Create Funding Plan</button></form>`;}
function expenseForm(x=null,prefill=null,targetPeriodId=null){
  const periodId=x?.budgetPeriodId||targetPeriodId||entryPeriodId();
  if(!periodId)return `<div class="empty">Create an open funding month first.</div>`;
  if(isClosedPeriod(periodId))return `<div class="notice"><strong>${monthLabel(periodId)} is closed.</strong><br>Reopen the month before adding or editing expenses.</div>`;
  const catId=x?.categoryId||prefill?.categoryId||'food',accountId=x?.accountId||prefill?.accountId||'ctbc',bucketId=x?.fundingBucketId||prefill?.fundingBucketId||'';
  const amount=x?.amount??prefill?.amount??'',description=x?.description??prefill?.description??'';
  return `<form id="expense-form"><input type="hidden" name="id" value="${x?.id||''}"><input type="hidden" name="periodId" value="${periodId}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${amount}" required></div><div class="field"><label>Category</label><select name="category">${state.categories.filter(c=>['fixed','cap','expense_only'].includes(c.ruleType)).map(c=>`<option value="${c.id}" ${c.id===catId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.date||today()}" required></div><div class="field"><label>Account used</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Funding bucket (optional)</label><select name="fundingBucket"><option value="">Operating cash</option>${state.buckets.filter(b=>b.bucketType!=='restricted').map(b=>`<option value="${b.id}" ${b.id===bucketId?'selected':''}>${esc(b.name)}</option>`).join('')}</select></div><div class="field"><label>Description (optional)</label><input name="description" value="${esc(description)}" placeholder="Lunch, rent, electricity..."></div><button class="btn" style="width:100%">${x?'Save Changes':'Save Expense'}</button></form>`;
}
function routingTransfersForIncome(incomeId){return state.transfers.filter(t=>!t.deletedAt&&t.sourceIncomeId===incomeId);}
function incomeForm(x=null){
  const p=currentPeriod(),type=x?.incomeType||'bonus',accountId=x?.accountId||'ctbc',period=x?.budgetPeriodId||p?.id||'';
  if(x&&isClosedPeriod(x.budgetPeriodId))return `<div class="notice"><strong>${monthLabel(x.budgetPeriodId)} is closed.</strong><br>Reopen the month before editing this income entry.</div>`;
  const periods=state.periods.filter(y=>y.state!=='closed'||y.id===period);
  if(!periods.length)return `<div class="empty">Create or reopen a funding month first.</div>`;
  const defaultTithe=x?!!x.titheEligible:['regular_income','bonus'].includes(type);
  const hasRouting=x?routingTransfersForIncome(x.id).length>0:false;
  return `<form id="income-form"><input type="hidden" name="id" value="${x?.id||''}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount||''}" required></div><div class="field"><label>Income type</label><select name="type" id="income-type">${INCOME_TYPES.map(t=>`<option value="${t[0]}" ${t[0]===type?'selected':''}>${t[1]}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date received</label><input name="date" type="date" value="${x?.dateReceived||today()}" required></div><div class="field"><label>Budget period</label><select name="period">${periods.map(y=>`<option value="${y.id}" ${y.id===period?'selected':''}>${monthLabel(y.id)}</option>`).join('')}</select></div></div><div class="field"><label>Account</label><select name="account">${state.accounts.filter(a=>a.role!=='investment').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div><div class="field"><label>Description</label><input name="description" value="${esc(x?.description||'')}" placeholder="e.g. Bonus or camera sale"></div><label class="check-line"><input id="income-tithe" name="tithe" type="checkbox" ${defaultTithe?'checked':''}> Tithe eligible</label>${!x?`<label class="check-line"><input id="income-routing" name="routing" type="checkbox" ${type!=='regular_income'&&type!=='reimbursement'?'checked':''}> Open routing assistant after saving</label>`:''}${hasRouting?`<div class="notice"><strong>This income already has routing records.</strong><br>Delete any uncompleted routing transfers before changing the amount, type or tithe eligibility.</div>`:''}<button class="btn" style="width:100%;margin-top:14px">${x?'Save Changes':'Save Income'}</button></form>`;
}
function incomeRoutingView(incomeId){
  const i=state.incomes.find(x=>x.id===incomeId&&!x.deletedAt);if(!i)return '<div class="empty">Income record not found.</div>';
  const existing=routingTransfersForIncome(incomeId);if(existing.length)return `<div class="notice"><strong>Routing already exists for this income.</strong><br>${existing.length} routing record${existing.length===1?'':'s'} are already linked to it. Manage planned transfers from Activity.</div>`;
  const pctValue=Number(state.settings.tithePercent||10),tithe=i.titheEligible?Math.round(Number(i.amount||0)*pctValue/100):0,available=Math.max(0,Number(i.amount||0)-tithe),active=activeGoal(state.goals,state.bucketBalances);
  return `<div class="notice"><strong>Nothing moves automatically.</strong><br>This assistant creates a clear plan for supplemental income. Physical transfers remain planned until you mark them completed.</div><section class="card routing-summary" style="margin-top:14px">${row('Income',money(i.amount))}${row('Tithe',i.titheEligible?`${money(tithe)} · ${pctValue}%`:'Not applicable')}${row('Available after tithe',money(available))}${row('Current priority',esc(active?.name||'Investments'))}</section><form id="income-routing-form" data-income="${i.id}"><div class="field"><label>What should the after-tithe money do?</label><select name="strategy"><option value="priority">Current wealth priority</option><option value="emergency">Emergency Fund</option><option value="home-trip">Home Travel Fund</option><option value="equipment">Equipment Fund</option><option value="invest">Investments</option><option value="keep">Keep in operating cash</option></select></div><div class="field"><label>Amount to route after tithe</label><input name="routeAmount" type="number" min="0" step="1" max="${Math.round(available)}" value="${Math.round(available)}"></div><div class="sub">Any un-routed remainder stays in the income account as operating cash.</div><button class="btn" style="width:100%;margin-top:14px">Create Routing Plan</button><button class="btn secondary" type="button" style="width:100%;margin-top:8px" data-action="skip-income-routing">Skip for Now</button></form>`;
}

function manualTransferForm(x=null){
  const p=currentPeriod(),period=x?.budgetPeriodId||p?.id||'';
  if(x&&x.budgetPeriodId&&isClosedPeriod(x.budgetPeriodId))return `<div class="notice"><strong>${monthLabel(x.budgetPeriodId)} is closed.</strong><br>Reopen the month before editing this transfer.</div>`;
  const alloc=x?state.transferAllocations.find(a=>a.transferId===x.id):null,selectedBucket=x?._bucketId||alloc?.bucketId||'';
  const periods=state.periods.filter(y=>y.state!=='closed'||y.id===period);
  return `<form id="manual-transfer-form"><input type="hidden" name="id" value="${x?.id||''}"><div class="field"><label>Amount</label><input name="amount" type="number" min="0" step="1" value="${x?.amount||''}" required></div><div class="form-grid"><div class="field"><label>From account</label><select name="from">${state.accounts.map(a=>`<option value="${a.id}" ${a.id===(x?.fromAccountId||'ctbc')?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div><div class="field"><label>To account</label><select name="to">${state.accounts.map(a=>`<option value="${a.id}" ${a.id===(x?.toAccountId||'esun')?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div></div><div class="field"><label>Purpose / virtual bucket</label><select name="bucket"><option value="">No bucket allocation</option>${state.buckets.map(b=>`<option value="${b.id}" ${b.id===selectedBucket?'selected':''}>${esc(b.name)}</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${x?.completedDate||x?.plannedDate||today()}"></div><div class="field"><label>Budget period</label><select name="period"><option value="">None</option>${periods.map(y=>`<option value="${y.id}" ${y.id===period?'selected':''}>${monthLabel(y.id)}</option>`).join('')}</select></div></div><label><input name="completed" type="checkbox" ${!x||x.status==='completed'?'checked':''}> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">${x?'Save Changes':'Save Transfer'}</button></form>`;
}
function transferConfirm(id){const t=state.transfers.find(x=>x.id===id);if(!t)return'';const allocs=state.transferAllocations.filter(a=>a.transferId===id);const details=allocs.length?allocs.map(a=>row(`Virtual · ${bucket(a.bucketId)?.name||a.label||'Allocation'}`,`+${money(a.amount)}`)).join(''):'';return `<div class="notice">Confirm only after you actually moved the money in your banking app. This transfer does not count as spending.</div><div class="section-title"><h2>Impact preview</h2></div><section class="card">${row(`Physical · ${physicalAccount(t.fromAccountId)?.name||t.fromAccountId}`,`−${money(t.amount)}`)}${row(`Physical · ${physicalAccount(t.toAccountId)?.name||t.toAccountId}`,`+${money(t.amount)}`)}${details}${row('Spending impact',money(0))}<div class="row"><strong>Total bank movement</strong><strong>${money(t.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-transfer" data-id="${id}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;}
function paydayTransferConfirm(periodId,accountId){
  const req=paydayRequirements(periodId),group=req.groups.find(g=>g.accountId===accountId);
  if(!group)return `<div class="notice">This payday transfer is already fully satisfied.</div>`;
  const destination=physicalAccount(accountId)?.name||accountId;
  return `<div class="notice">Confirm only after you physically moved this exact remaining amount. Already-completed payday items are excluded automatically. Transfers are not spending.</div><div class="section-title"><h2>Impact preview</h2></div><section class="card">${row('Physical · CTBC Operating',`−${money(group.amount)}`)}${row(`Physical · ${destination}`,`+${money(group.amount)}`)}${group.items.filter(x=>x.bucketId).map(x=>row(`Virtual · ${x.label}`,`+${money(x.remaining)}`)).join('')}${row('Spending impact',money(0))}<div class="row"><strong>Total bank movement</strong><strong>${money(group.amount)}</strong></div></section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-payday-transfer" data-period="${periodId}" data-account="${accountId}">Yes — Transfer Completed</button><button class="btn secondary" data-action="close-modal">Not Yet</button></div>`;
}
function monthCloseView(){
  const p=currentPeriod();if(!p)return'';
  const c=monthCloseStatus(p.id),closeRecord=state.monthlyCloses.find(x=>x.budgetPeriodId===p.id||x.id===p.id),health=dataHealthReport();
  if(p.state==='closed'){
    const accounts=closeRecord?.endingAccountBalances||{};
    return `<div class="notice"><strong>${monthLabel(p.id)} is closed.</strong><br>This month-end snapshot is read-only until you intentionally reopen the month.</div>
    <div class="grid g2" style="margin-top:14px"><section class="card"><div class="metric-label">Expenses</div><div class="metric">${money(closeRecord?.expenses??totalExpenses(p.id))}</div></section><section class="card"><div class="metric-label">Core wealth contributed</div><div class="metric">${money(closeRecord?.wealthContribution??completedCoreWealth(p.id))}</div></section></div>
    <div class="section-title"><h2>Saved month-end snapshot</h2><span class="tag good-tag">Locked</span></div><section class="card">
      ${row('Closed',esc((closeRecord?.closedAt||p.closedAt||'').slice(0,10)))}
      ${row('Ending Core Wealth',money(closeRecord?.endingCoreWealth??state.wealth.coreWealth))}
      ${row('Ending Financial Net Worth',money(closeRecord?.endingFinancialNetWorth??state.wealth.financialNetWorth))}
      ${row('CTBC',money(accounts.ctbc??closeRecord?.ctbcActual??0))}
      ${row('E.SUN',money(accounts.esun??closeRecord?.esunActual??0))}
      ${row('IBKR (TWD)',money(accounts.ibkrTwd??0))}
    </section><button class="btn secondary" style="width:100%;margin-top:14px" data-action="reopen-period" data-id="${p.id}">Reopen Month</button>`;
  }
  const fixedText=c.missingFixed.length?`${c.missingFixed.length} fixed obligation${c.missingFixed.length===1?'':'s'} not fully recorded`:'All fixed obligations recorded';
  const steps=[
    ['1','Transactions',c.pending.length===0&&c.missingFixed.length===0,c.pending.length?`${c.pending.length} planned transfer${c.pending.length===1?'':'s'} still pending`:fixedText],
    ['2','Payday allocations',c.fundingOk,c.fundingOk?'Tithe, CTBC reserves and wealth routing complete':`${money(c.payday.totalOutstanding)} of payday bank transfers still outstanding`],
    ['3','Account reconciliation',c.bankOk,c.bankOk?'CTBC and E.SUN are reconciled':'Update CTBC/E.SUN and resolve E.SUN purpose allocation'],
    ['4','Month-end sweep',c.sweep.available<=0.5&&c.sweep.overSwept<=0.5,c.sweep.overSwept>0?`${money(c.sweep.overSwept)} over-swept`:c.sweep.available>0?`${money(c.sweep.available)} still available`:'Sweep is complete'],
    ['5','Snapshot & lock',c.ready,c.ready?'Ready to save the month-end snapshot and lock the month':'Complete the earlier steps first']
  ];
  let action='';
  if(c.pending.length) action=`<div class="notice" style="margin-top:14px">Complete or remove all planned transfers before creating the sweep or closing the month.</div>`;
  else if(c.sweep.overSwept>0.5) action=`<div class="notice danger-notice" style="margin-top:14px"><strong>Sweep correction required.</strong><br>The completed sweep exceeds the amount currently supported by this budget by ${money(c.sweep.overSwept)}. Correct the transactions or record the appropriate reverse movement before closing.</div>`;
  else if(c.sweep.available>0.5) action=`<button class="btn" style="width:100%;margin-top:14px" data-action="create-sweep">Create ${money(c.sweep.available)} Sweep Transfer</button>`;
  else if(!c.fundingOk||!c.bankOk) action=`<div class="notice" style="margin-top:14px">Resolve the funding and reconciliation steps above before closing the month.</div>`;
  else action=`${c.missingFixed.length?`<div class="notice" style="margin-top:14px"><strong>Review fixed obligations.</strong><br>${fixedText}. You can close only after confirming this is intentional.</div>`:''}<button class="btn" style="width:100%;margin-top:14px" data-action="close-period">Save Snapshot & Close ${monthLabel(p.id)}</button>`;
  const snapshotRows=`${row('Income',money(periodAllIncome(p.id)))}${row('Expenses',money(totalExpenses(p.id)))}${row('Core wealth contributed',money(completedCoreWealth(p.id)))}${row('Ending Core Wealth',money(state.wealth.coreWealth))}${row('Ending Financial Net Worth',money(state.wealth.financialNetWorth))}${row('CTBC tracked',money(c.ct.actual))}${row('E.SUN tracked',money(c.es.actual))}${row('IBKR',money(latestInvestmentTwd()))}`;
  const healthText=health.critical?`${health.critical} critical Data Health issue${health.critical===1?'':'s'}`:health.warn?`${health.warn} Data Health warning${health.warn===1?'':'s'}`:'No Data Health warnings';
  return `<div class="grid g2"><section class="card"><div class="metric-label">Unused flexible + buffer</div><div class="metric">${money(c.sweep.grossUnused)}</div></section><section class="card"><div class="metric-label">Overspending deficits</div><div class="metric ${c.sweep.deficits?'bad':''}">${money(c.sweep.deficits)}</div></section></div>
  <section class="card" style="margin-top:14px"><div class="metric-label">Available month-end sweep</div><div class="metric">${money(c.sweep.available)}</div><div class="sub">Only this funding month is included; next-month income is excluded.</div></section>
  <div class="section-title"><h2>Guided close</h2><span class="sub">Five-step month operation</span></div><section class="card close-checklist">${steps.map(([n,label,ok,detail])=>`<div class="close-check"><span class="check-dot ${ok?'ok':'attention'}">${ok?'✓':n}</span><div><strong>${label}</strong><div class="sub">${detail}</div></div></div>`).join('')}</section>
  <div class="section-title"><h2>Snapshot preview</h2><span class="sub">Saved when you close</span></div><section class="card">${snapshotRows}</section>
  <div class="notice ${health.critical?'danger-notice':''}" style="margin-top:14px"><strong>Data Health: ${esc(healthText)}</strong><br>Data Health does not automatically change your records. <button class="text-btn" data-action="data-health">Review details</button></div>${action}`;
}
function goalEditForm(goalId){
  const g=goal(goalId);if(!g)return `<div class="empty">Goal not found.</div>`;
  const prereq=g.prerequisiteGoalId?goal(g.prerequisiteGoalId):null;
  return `<form id="goal-edit-form" data-goal="${g.id}"><div class="field"><label>Target amount</label><input name="targetAmount" type="number" min="0" step="1000" value="${Number(g.targetAmount||0)}" required></div><div class="form-grid"><div class="field"><label>Target date (optional)</label><input name="targetDate" type="date" value="${g.targetDate||''}"></div><div class="field"><label>Monthly target (optional)</label><input name="monthlyTarget" type="number" min="0" step="1000" value="${Number(g.monthlyTarget||0)}"></div></div><div class="field"><label>Status</label><select name="status"><option value="active" ${g.status==='active'?'selected':''}>Active</option><option value="waiting" ${g.status==='waiting'?'selected':''}>Waiting</option><option value="paused" ${g.status==='paused'?'selected':''}>Paused</option></select></div>${prereq?`<div class="notice">Funding prerequisite: ${esc(prereq.name)} must reach ${money(g.prerequisiteAmount||0)}. This routing dependency is preserved.</div>`:''}<button class="btn" style="width:100%;margin-top:14px">Save Goal</button></form>`;
}
function goalContributionForm(goalId){
  const g=goal(goalId);if(!g)return `<div class="empty">Goal not found.</div>`;
  const b=bucket(g.bucketId);if(!b)return `<div class="empty">Goal bucket not found.</div>`;
  const openPeriods=state.periods.filter(p=>p.state!=='closed');
  return `<form id="goal-contribution-form" data-goal="${g.id}"><div class="notice">This records a real transfer into ${esc(g.name)}. Confirm completion only after you actually move the money.</div><div class="field" style="margin-top:14px"><label>Contribution amount</label><input name="amount" type="number" min="1" step="1" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Funding month (optional)</label><select name="period"><option value="">None</option>${openPeriods.map(p=>`<option value="${p.id}" ${p.id===selectedPeriodId?'selected':''}>${monthLabel(p.id)}</option>`).join('')}</select></div></div><label><input name="completed" type="checkbox"> Transfer already completed</label><button class="btn" style="width:100%;margin-top:14px">Save Goal Contribution</button></form>`;
}
function investmentForm(){const snap=[...state.investmentSnapshots].sort((a,b)=>String(a.date).localeCompare(String(b.date))).at(-1),estimated=Number(state.accountBalances?.ibkr??snap?.value??3536);return `<form id="investment-form"><div class="notice">Enter the total portfolio value shown in IBKR. This snapshot replaces the interim estimate from any contributions recorded since the previous snapshot.</div><div class="field" style="margin-top:14px"><label>IBKR portfolio value (USD)</label><input name="value" type="number" step="0.01" value="${estimated.toFixed(2)}" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>USD/TWD rate</label><input name="fx" type="number" step="0.0001" value="${state.settings.usdTwdRate}" required></div></div><button class="btn" style="width:100%">Save Snapshot</button></form>`;}
function accountReconciliationForm(accountId){const a=physicalAccount(accountId),snap=accountId==='esun'?esunSnapshot():accountSnapshot(accountId);return `<form id="account-reconcile-form" data-account="${accountId}"><div class="notice">Enter the exact balance shown in your ${esc(a?.name||'bank')} app. Nothing is changed until you review and confirm the impact.</div><div class="field" style="margin-top:14px"><label>Actual bank balance</label><input name="actualBalance" type="number" step="1" min="0" value="${Math.round(snap.actual)}" required></div><div class="form-grid"><div class="field"><label>Date checked</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Current tracked balance</label><input type="text" value="${money(snap.actual)}" disabled></div></div><div class="field"><label>Note (optional)</label><input name="note" placeholder="Checked in bank app"></div><button class="btn" style="width:100%">Review Balance Update</button></form>`;}
function accountAdjustmentForm(accountId){const snap=accountSnapshot(accountId);return `<form id="account-adjustment-form" data-account="${accountId}"><div class="notice">Use an adjustment only when the difference is real and is not better recorded as an expense, income or transfer.</div><div class="field" style="margin-top:14px"><label>Adjustment amount</label><input name="amount" type="number" step="1" value="${Math.round(snap.difference)||''}" placeholder="Use + to add or − to subtract" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Current bank vs ledger</label><input type="text" value="${snap.difference>0?'+':''}${money(snap.difference)}" disabled></div></div><div class="field"><label>Reason</label><input name="note" placeholder="Bank interest, correction, opening-balance fix..." required></div><button class="btn" style="width:100%">Save Adjustment</button></form>`;}
function esunAllocationForm(){const es=esunSnapshot();const diff=Number(modal.amount??es.unassigned);const reducing=diff<0;const amount=Math.abs(diff);return `<form id="esun-allocation-form"><div class="notice"><strong>${reducing?'Reduce':'Assign'} ${money(amount)}</strong><br>${reducing?'Choose which virtual buckets should be reduced.':'Choose what the unassigned E.SUN money is for.'} You can split it across several buckets or leave part unassigned.</div><div class="allocation-fields">${state.buckets.filter(b=>b.accountId==='esun').map(b=>`<div class="allocation-row"><div><strong>${esc(b.name)}</strong><div class="sub">Current ${money(state.bucketBalances[b.id]||0)}</div></div><input name="bucket-${b.id}" type="number" min="0" step="1" value="0" ${reducing?`max="${Math.max(0,Math.floor(state.bucketBalances[b.id]||0))}"`:''}></div>`).join('')}</div><input type="hidden" name="direction" value="${reducing?'-1':'1'}"><input type="hidden" name="limit" value="${amount}"><div class="sub" style="margin:10px 0">Maximum to ${reducing?'reduce':'assign'} now: ${money(amount)}</div><button class="btn" style="width:100%">Save Purpose Allocation</button></form>`;}

function reconciliationPreviewView(){
  const d=modal.draft||{},accountId=d.accountId,a=physicalAccount(accountId),snap=accountId==='esun'?esunSnapshot():accountSnapshot(accountId);
  const actual=Number(d.actualBalance||0),difference=actual-Number(snap.actual||0);
  const es=accountId==='esun'?esunSnapshot():null;
  const purposeAfter=es?actual-Number(es.virtualTotal||0):null;
  return `<div class="notice"><strong>No transaction will be created.</strong><br>This only establishes a new verified bank baseline. Existing expenses, income, transfers and virtual allocations remain unchanged.</div>
  <section class="card audit-summary" style="margin-top:14px">
    ${row('Account',esc(a?.name||accountId))}
    ${row('Current tracked balance',money(snap.actual))}
    ${row('Bank balance entered',money(actual))}
    ${row('Difference to acknowledge',`${difference>0?'+':''}${money(difference)}`)}
    ${row('Date checked',esc(d.date||today()))}
  </section>
  ${es?`<section class="card" style="margin-top:12px"><div class="metric-label">E.SUN purpose impact</div>${row('Current virtual allocation',money(es.virtualTotal))}${row('Unassigned after new baseline',`${purposeAfter>0?'+':''}${money(purposeAfter)}`)}<div class="sub">If this is not zero, Wealth OS will ask you to assign or reduce purpose buckets after the bank baseline is saved.</div></section>`:''}
  <div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-reconciliation">Confirm New Baseline</button><button class="btn secondary" data-action="account-reconcile" data-id="${accountId}">Go Back</button></div>`;
}
function accountAuditView(accountId){
  const audit=accountAudit(accountId),snap=accountId==='esun'?esunSnapshot():accountSnapshot(accountId);
  const physical=audit.entries.length?audit.entries.slice(-100).map(e=>`<div class="audit-line"><div><strong>${esc(e.type)}</strong><div class="sub">${esc(e.date||'')} · ${esc(e.detail||'')}</div></div><div class="right"><strong class="${e.delta<0?'bad':e.delta>0?'good':''}">${e.delta>0?'+':''}${money(e.delta)}</strong><div class="sub">→ ${money(e.running)}</div></div></div>`).join(''):`<div class="empty compact-empty"><strong>No physical activity after the baseline.</strong><span>The tracked balance equals the verified baseline.</span></div>`;
  const purpose=audit.purposeEvents.length?audit.purposeEvents.slice(0,60).map(ev=>{
    const t=ev.transfer,allocText=ev.allocations.map(a=>`${bucket(a.bucketId)?.name||a.bucketId} ${a.amount>=0?'+':''}${money(a.amount)}`).join(' · ');
    const physical=!isPurposeOnlyTransfer(t);
    return `<div class="audit-line"><div><strong>${physical?'Bank transfer + purpose':'Virtual allocation only'}</strong><div class="sub">${esc(t.completedDate||t.plannedDate||'')} · ${esc(allocText)}</div>${ev.reversedBy?`<div class="sub good">Reversed by ${esc(ev.reversedBy.completedDate||ev.reversedBy.plannedDate||'later record')}</div>`:''}</div><div class="right"><span class="tag ${physical?'':'good-tag'}">${physical?'physical + virtual':'virtual only'}</span>${canReversePurposeEvent(ev)?`<button class="text-btn danger-text" data-action="reverse-allocation" data-id="${t.id}">Reverse</button>`:''}</div></div>`;
  }).join(''):`<div class="empty compact-empty"><strong>No purpose-allocation history.</strong><span>Virtual bucket changes will appear here.</span></div>`;
  const buckets=state.buckets.filter(b=>b.accountId===accountId),crossDiff=Number(snap.rawExpected??snap.actual)-Number(audit.tracked||0);
  return `<div class="notice"><strong>Audit view is read-only except explicit reversals.</strong><br>Physical money movements and virtual-purpose changes are shown separately so one cannot be mistaken for the other.</div>
  ${Math.abs(crossDiff)>=0.5?`<div class="notice danger-notice" style="margin-top:12px"><strong>Historical ledger differs from the verified bank trail by ${crossDiff>0?'+':''}${money(crossDiff)}.</strong><br>The verified bank baseline remains authoritative. Use the trail below to identify the historical record; do not create a compensating transaction just to force the old raw ledger to match.</div>`:''}
  <section class="card audit-summary" style="margin-top:14px">
    ${row('Verified baseline',money(audit.baseline))}
    ${row('Baseline date',esc(audit.baselineDate||'Opening balance'))}
    ${row('Physical activity after baseline',`${audit.entries.reduce((s,e)=>s+e.delta,0)>=0?'+':''}${money(audit.entries.reduce((s,e)=>s+e.delta,0))}`)}
    ${row('Tracked current balance',money(audit.tracked))}
    ${row('Raw ledger cross-check',money(snap.rawExpected??snap.actual))}
    ${row('Current screen balance',money(snap.actual))}
  </section>
  <div class="section-title"><h2>Physical bank trail</h2><span class="sub">Changes the bank balance</span></div><section class="card audit-list">${physical}</section>
  ${buckets.length?`<div class="section-title"><h2>Current purpose buckets</h2><span class="sub">Does not move bank cash</span></div><section class="card">${buckets.map(b=>row(b.name,money(state.bucketBalances[b.id]||0))).join('')}</section>`:''}
  <div class="section-title"><h2>Purpose-allocation history</h2><span class="sub">Physical and virtual effects labeled separately</span></div><section class="card audit-list">${purpose}</section>
  ${accountId==='esun'?`<button class="btn secondary" style="width:100%;margin-top:14px" data-action="esun-reallocate">Reallocate E.SUN Purpose</button>`:''}`;
}
function esunReallocationForm(){
  const buckets=state.buckets.filter(b=>b.accountId==='esun'&&Number(state.bucketBalances[b.id]||0)>0);
  const all=state.buckets.filter(b=>b.accountId==='esun');
  if(!buckets.length)return `<div class="notice">There is no E.SUN bucket balance available to move.</div>`;
  return `<form id="esun-reallocation-form"><div class="notice"><strong>Virtual-purpose change only.</strong><br>This moves purpose between E.SUN buckets and does not change the physical E.SUN bank balance.</div><div class="form-grid" style="margin-top:14px"><div class="field"><label>Move from</label><select name="fromBucket">${buckets.map(b=>`<option value="${b.id}">${esc(b.name)} · ${money(state.bucketBalances[b.id]||0)}</option>`).join('')}</select></div><div class="field"><label>Move to</label><select name="toBucket">${all.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div></div><div class="field"><label>Amount</label><input name="amount" type="number" min="1" step="1" required></div><div class="form-grid"><div class="field"><label>Date</label><input name="date" type="date" value="${today()}" required></div><div class="field"><label>Bank impact</label><input type="text" value="NT$0" disabled></div></div><div class="field"><label>Note (optional)</label><input name="note" placeholder="Why the purpose changed"></div><button class="btn" style="width:100%">Save Virtual Reallocation</button></form>`;
}
function manualTransferReview(){
  const d=modal.draft||{},from=physicalAccount(d.from),to=physicalAccount(d.to),b=d.bucketId?bucket(d.bucketId):null;
  return `<div class="notice"><strong>${d.status==='completed'?'Completed bank movement':'Planned bank movement'}.</strong><br>${d.status==='completed'?'Confirm only if the money has already moved in your bank.':'This will not affect balances until you later mark it completed.'}</div><section class="card" style="margin-top:14px">${row('Physical · '+(from?.name||d.from),`−${money(d.amount)}`)}${row('Physical · '+(to?.name||d.to),`+${money(d.amount)}`)}${b?row('Virtual · '+b.name,`+${money(d.amount)}`):row('Virtual allocation','None')}${row('Spending impact',money(0))}${row('Date',esc(d.date))}</section><div class="actions" style="margin-top:14px"><button class="btn" data-action="confirm-manual-transfer">Confirm & Save</button><button class="btn secondary" data-action="manual-transfer-back">Go Back</button></div>`;
}

function deleteFundingMonthView(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p)return '<div class="empty">Funding month not found.</div>';
  const incomes=state.incomes.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const expenses=state.expenses.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const transfers=state.transfers.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const completed=transfers.filter(x=>x.status==='completed'&&!(x.systemGenerated&&x.fromAccountId===x.toAccountId&&x.transferType==='reserve_allocation'));
  if(p.state==='closed') return `<div class="notice"><strong>${monthLabel(periodId)} is closed.</strong><br>Closed months are protected from deletion.</div>`;
  if(completed.length) return `<div class="notice"><strong>Deletion is blocked.</strong><br>This month has ${completed.length} completed transfer${completed.length===1?'':'s'}. Wealth OS will not silently reverse money you may have actually moved between accounts.</div><section class="card" style="margin-top:14px">${row('Income entries',incomes.length)}${row('Expenses',expenses.length)}${row('Transfers',transfers.length)}${row('Completed transfers',completed.length)}</section><div class="sub" style="margin-top:12px">If this was only a test, leave system transfers uncompleted before deleting the month.</div>`;
  return `<div class="notice"><strong>This action is intended for test or mistaken funding months.</strong><br>It will permanently remove the month and its period-linked entries from this device.</div><section class="card" style="margin-top:14px">${row('Funding month',monthLabel(periodId))}${row('Income entries',incomes.length)}${row('Expenses',expenses.length)}${row('Planned transfers',transfers.length)}</section><div class="sub" style="margin:12px 0">E.SUN/CTBC reconciliations, account adjustments, IBKR snapshots, and unrelated transactions are not touched.</div><button class="btn danger" style="width:100%" data-action="confirm-delete-period" data-id="${periodId}">Delete Month & Test Data</button>`;
}

function settingsView(){
  const lastBackup=state.settings.lastBackupAt?new Date(state.settings.lastBackupAt).toLocaleString():'Never';
  const backupAge=state.settings.lastBackupAt?Math.floor((Date.now()-new Date(state.settings.lastBackupAt).getTime())/86400000):null;
  const backupStatus=backupAge===null?'No backup yet':backupAge>30?`Backup is ${backupAge} days old`:backupAge===0?'Backed up today':`Backed up ${backupAge} day${backupAge===1?'':'s'} ago`;
  return `<section class="card app-info-card"><div class="split"><div><div class="metric-label">Installed build</div><strong>Wealth OS v${APP_VERSION}</strong><div class="sub">Data model ${DATA_MODEL_VERSION}</div></div><span class="tag good-tag">Local-first</span></div>${row('Last backup',esc(lastBackup))}<div class="sub ${backupAge===null||backupAge>30?'bad':''}" style="margin-top:8px">${esc(backupStatus)}</div><div class="actions settings-export-actions" style="margin-top:12px"><button class="btn secondary" data-action="export-backup">Export Backup</button><label class="btn secondary">Restore Backup<input id="restore-file" type="file" accept="application/json" hidden></label><button class="btn ghost" data-action="export-activity-csv">Activity CSV</button><button class="btn ghost" data-action="export-monthly-csv">Monthly CSV</button></div></section>
  <div class="section-title"><h2>Reliability tools</h2><span class="sub">Inspect before correcting</span></div><section class="card"><div class="row"><div><strong>Data Health</strong><div class="sub">Duplicates, stale reconciliations, bucket mismatches and month-state checks</div></div><button class="btn ghost small" type="button" data-action="data-health">Run Check</button></div><div class="row"><div><strong>CTBC audit trail</strong><div class="sub">Verified baseline + physical movements + virtual reserves</div></div><button class="btn ghost small" type="button" data-action="account-audit" data-id="ctbc">Open</button></div><div class="row"><div><strong>E.SUN audit trail</strong><div class="sub">Bank movements separated from purpose allocations</div></div><button class="btn ghost small" type="button" data-action="account-audit" data-id="esun">Open</button></div></section>
  <form id="settings-form"><div class="section-title"><h2>Planning settings</h2></div><div class="form-grid"><div class="field"><label>Fallback forecast salary</label><input name="forecastSalary" type="number" value="${state.settings.forecastSalary}"><div class="sub">Used only when no real paycheck history exists.</div></div><div class="field"><label>USD/TWD rate</label><input name="usdTwdRate" type="number" step="0.0001" value="${state.settings.usdTwdRate}"></div><div class="field"><label>Raise → wealth (%)</label><input name="wealthRaisePercent" type="number" min="0" max="100" value="${state.settings.wealthRaisePercent}"></div></div>
  <div class="section-title"><h2>Forecast assumptions</h2><span class="sub">Salary growth and returns are independent</span></div><div class="grid g3 scenario-settings"><section class="card nested-card"><strong>Conservative</strong><div class="field"><label>Investment return (%)</label><input name="conservativeInvestmentReturn" type="number" step="0.1" value="${state.settings.conservativeInvestmentReturn??4}"></div><div class="field"><label>Salary growth (%)</label><input name="conservativeSalaryGrowth" type="number" step="0.1" value="${state.settings.conservativeSalaryGrowth??1}"></div></section><section class="card nested-card"><strong>Base</strong><div class="field"><label>Investment return (%)</label><input name="forecastInvestmentReturn" type="number" step="0.1" value="${state.settings.forecastInvestmentReturn??7}"></div><div class="field"><label>Salary growth (%)</label><input name="forecastSalaryGrowth" type="number" step="0.1" value="${state.settings.forecastSalaryGrowth??3}"></div></section><section class="card nested-card"><strong>Aggressive</strong><div class="field"><label>Investment return (%)</label><input name="aggressiveInvestmentReturn" type="number" step="0.1" value="${state.settings.aggressiveInvestmentReturn??9}"></div><div class="field"><label>Salary growth (%)</label><input name="aggressiveSalaryGrowth" type="number" step="0.1" value="${state.settings.aggressiveSalaryGrowth??5}"></div></section></div>
  <div class="section-title"><h2>Budget rules</h2></div><div class="notice">Budget-rule changes apply only to funding months created after the change. Existing funding months keep their saved plan.</div>${state.categories.filter(c=>c.ruleType!=='expense_only').map(c=>`<div class="row"><div><strong>${esc(c.name)}</strong><div class="sub">${c.ruleType.replaceAll('_',' ')}</div></div><input name="cat-${c.id}" type="number" step="1" value="${c.defaultAmount}" style="width:120px;padding:9px;border:1px solid #d1d5db;border-radius:9px;text-align:right"></div>`).join('')}<button class="btn" style="width:100%;margin-top:14px">Save Settings</button></form>`;
}


async function createPaycheck(form){
  const fd=new FormData(form),amount=Number(fd.get('amount')),date=fd.get('date'),periodId=fd.get('period');
  if(state.periods.some(p=>p.id===periodId))throw new Error('That budget month already exists.');
  const plan=buildBudgetPlan({income:amount,categories:state.categories,settings:state.settings}),stamp=new Date().toISOString();
  const goalAllocs=allocateGoalSurplus({amount:Math.max(0,Math.round(plan.immediateWealth)),goals:state.goals,bucketBalances:state.bucketBalances});
  await put('periods',{
    id:periodId,state:'funded',createdAt:stamp,fundedAt:date,planSnapshot:plan,
    paydayRoutingSnapshot:{goalAllocs:goalAllocs.map(a=>({...a})),createdAt:stamp}
  });
  await put('incomes',{id:uid('inc'),dateReceived:date,budgetPeriodId:periodId,amount,incomeType:'regular_income',accountId:'ctbc',description:'Monthly salary',titheEligible:true,includedInRegularIncomeMetrics:true,systemGenerated:true,createdAt:stamp});

  // Reserves that live in CTBC are funded by purpose designation, not by moving cash
  // to another bank. The money is already physically in CTBC when salary arrives.
  const ctbcReserveLines=plan.lines.filter(x=>x.ruleType==='sinking_contribution'&&x.bucketId&&bucket(x.bucketId)?.accountId==='ctbc'&&Number(x.budgetAmount||0)>0);
  if(ctbcReserveLines.length){
    const total=ctbcReserveLines.reduce((sum,x)=>sum+Number(x.budgetAmount||0),0),tid=uid('tr');
    await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'ctbc',amount:total,budgetPeriodId:periodId,status:'completed',plannedDate:date,completedDate:date,completedAt:stamp,transferType:'reserve_allocation',affectsPhysicalBalance:false,systemGenerated:true,createdAt:stamp,updatedAt:stamp});
    await bulkPut('transferAllocations',ctbcReserveLines.map(x=>({id:uid('ta'),transferId:tid,bucketId:x.bucketId,amount:Number(x.budgetAmount||0),goalId:null,label:x.name})));
  }

  // Bank-transfer actions are now derived from the funding plan and what has already
  // been completed. This prevents a separately-recorded tithe transfer from leaving
  // behind an obsolete combined payday transfer.
  selectedPeriodId=periodId;modal=null;await load();
}
async function saveExpense(form){
  const fd=new FormData(form),id=fd.get('id'),existing=id?state.expenses.find(x=>x.id===id):null;
  const periodId=existing?.budgetPeriodId||fd.get('periodId')||selectedPeriodId;assertPeriodEditable(periodId);
  const cat=category(fd.get('category'));let fundingBucketId=fd.get('fundingBucket')||cat?.defaultFundingBucketId||null;let accountId=fd.get('account');
  if(fundingBucketId){const b=bucket(fundingBucketId);if(b?.accountId)accountId=b.accountId;}
  const obj={...(existing||{}),id:existing?.id||uid('exp'),amount:Number(fd.get('amount')),categoryId:fd.get('category'),date:fd.get('date'),accountId,budgetPeriodId:periodId,description:fd.get('description')||'',fundingBucketId,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  await put('expenses',obj);modal=null;await load();
}
function prepareManualTransfer(form){
  const fd=new FormData(form),id=fd.get('id')||null,existing=id?state.transfers.find(x=>x.id===id):null;
  const amount=Number(fd.get('amount')),from=fd.get('from'),to=fd.get('to'),periodId=fd.get('period')||null,bucketId=fd.get('bucket')||null;
  if(amount<=0)throw new Error('Enter a transfer amount greater than zero.');
  if(from===to)throw new Error('From and to accounts must be different for a bank transfer.');
  assertPeriodEditable(periodId||existing?.budgetPeriodId||null);
  if(bucketId){const b=bucket(bucketId);if(b?.accountId!==to)throw new Error(`${b?.name||'Selected bucket'} belongs to ${physicalAccount(b?.accountId)?.name||'another account'}, not ${physicalAccount(to)?.name||'the destination account'}.`);}
  modal={type:'manual-transfer-review',draft:{id,amount,from,to,periodId,status:fd.get('completed')==='on'?'completed':'planned',date:fd.get('date')||today(),bucketId}};
  render();
}
async function commitManualTransfer(){
  const d=modal?.draft;if(!d)throw new Error('Transfer preview is no longer available.');
  const existing=d.id?state.transfers.find(x=>x.id===d.id):null;assertPeriodEditable(d.periodId||existing?.budgetPeriodId||null);
  const tid=existing?.id||uid('tr'),stamp=new Date().toISOString();
  await put('transfers',{...(existing||{}),id:tid,fromAccountId:d.from,toAccountId:d.to,amount:d.amount,budgetPeriodId:d.periodId,status:d.status,plannedDate:d.date,completedDate:d.status==='completed'?d.date:null,completedAt:d.status==='completed'?(existing?.completedAt||stamp):null,transferType:'manual',affectsPhysicalBalance:true,createdAt:existing?.createdAt||stamp,updatedAt:stamp,deletedAt:null});
  for(const a of state.transferAllocations.filter(a=>a.transferId===tid))await remove('transferAllocations',a.id);
  if(d.bucketId)await put('transferAllocations',{id:uid('ta'),transferId:tid,bucketId:d.bucketId,amount:d.amount,goalId:null,label:'Manual allocation'});
  modal=null;await load();
}

async function saveIncome(form){
  const fd=new FormData(form),id=fd.get('id'),type=fd.get('type'),existing=id?state.incomes.find(x=>x.id===id):null,periodId=fd.get('period');
  assertPeriodEditable(periodId||existing?.budgetPeriodId||null);
  const amount=Number(fd.get('amount')),titheEligible=fd.get('tithe')==='on';
  if(existing&&routingTransfersForIncome(existing.id).length){
    const changed=amount!==Number(existing.amount||0)||type!==existing.incomeType||titheEligible!==!!existing.titheEligible||fd.get('account')!==existing.accountId||periodId!==existing.budgetPeriodId;
    if(changed)throw new Error('This income already has routing records. Delete any uncompleted routing transfers before changing the amount, type, account, period or tithe eligibility.');
  }
  const incomeId=existing?.id||uid('inc');
  await put('incomes',{...(existing||{}),id:incomeId,amount,incomeType:type,dateReceived:fd.get('date'),accountId:fd.get('account'),budgetPeriodId:periodId,description:fd.get('description')||'',titheEligible,includedInRegularIncomeMetrics:type==='regular_income',createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),deletedAt:null});
  if(!existing&&type!=='regular_income'&&fd.get('routing')==='on'){modal={type:'income-routing',incomeId};await load();return;}
  modal=null;await load();
}
async function saveIncomeRouting(form){
  const incomeId=form.dataset.income,i=state.incomes.find(x=>x.id===incomeId&&!x.deletedAt);if(!i)throw new Error('Income record not found.');
  assertPeriodEditable(i.budgetPeriodId||null);
  if(routingTransfersForIncome(incomeId).length)throw new Error('Routing already exists for this income.');
  const fd=new FormData(form),strategy=fd.get('strategy'),tithePct=Number(state.settings.tithePercent||10),tithe=i.titheEligible?Math.round(Number(i.amount||0)*tithePct/100):0,available=Math.max(0,Number(i.amount||0)-tithe),routeAmount=Number(fd.get('routeAmount')||0);
  if(routeAmount<0||routeAmount>available+0.5)throw new Error(`After-tithe routing cannot exceed ${money(available)}.`);
  const routes=[];
  if(tithe>0)routes.push({accountId:'esun',bucketId:'tithe',amount:tithe,label:'Tithe'});
  if(strategy!=='keep'&&routeAmount>0.5){
    if(strategy==='priority'){
      const allocations=allocateGoalSurplus({amount:routeAmount,goals:state.goals,bucketBalances:state.bucketBalances});
      for(const a of allocations){if(a.bucketId)routes.push({accountId:bucket(a.bucketId)?.accountId,bucketId:a.bucketId,amount:Number(a.amount||0),label:a.label||bucket(a.bucketId)?.name||'Goal'});else if(a.accountId)routes.push({accountId:a.accountId,bucketId:null,amount:Number(a.amount||0),label:a.label||'Investments'});}
    }else if(strategy==='invest')routes.push({accountId:'ibkr',bucketId:null,amount:routeAmount,label:'Investments'});
    else{
      const targetBucket=bucket(strategy);if(!targetBucket)throw new Error('Selected routing destination is not available.');
      const g=state.goals.find(x=>x.bucketId===strategy),room=g?Math.max(0,Number(g.targetAmount||0)-goalBal(g)):Infinity;
      if(Number.isFinite(room)&&routeAmount>room+0.5)throw new Error(`${g.name} only has ${money(room)} remaining to its target.`);
      routes.push({accountId:targetBucket.accountId,bucketId:strategy,amount:routeAmount,label:targetBucket.name});
    }
  }
  const groups=new Map();for(const r of routes.filter(r=>r.accountId&&r.amount>0.5)){if(!groups.has(r.accountId))groups.set(r.accountId,[]);groups.get(r.accountId).push(r);}
  const stamp=new Date().toISOString(),date=i.dateReceived||today();
  for(const [dest,items] of groups){
    const total=items.reduce((sum,x)=>sum+Number(x.amount||0),0),same=dest===i.accountId,tid=uid('tr');
    await put('transfers',{id:tid,fromAccountId:i.accountId,toAccountId:dest,amount:total,budgetPeriodId:i.budgetPeriodId,status:same?'completed':'planned',plannedDate:date,completedDate:same?date:null,completedAt:same?stamp:null,transferType:same?'supplemental_income_allocation':'supplemental_income_routing',affectsPhysicalBalance:!same,sourceIncomeId:i.id,systemGenerated:true,createdAt:stamp,updatedAt:stamp});
    const allocs=items.filter(x=>x.bucketId);if(allocs.length)await bulkPut('transferAllocations',allocs.map(x=>({id:uid('ta'),transferId:tid,bucketId:x.bucketId,amount:Number(x.amount||0),goalId:state.goals.find(g=>g.bucketId===x.bucketId)?.id||null,label:x.label})));
  }
  modal=null;await load();
}

async function completeTransfer(id){
  const t=state.transfers.find(x=>x.id===id);if(!t)return;
  assertPeriodEditable(t.budgetPeriodId||null);
  const stamp=new Date().toISOString();
  await put('transfers',{...t,status:'completed',completedDate:today(),completedAt:stamp,updatedAt:stamp});modal=null;await load();
}
async function completePaydayTransfer(periodId,accountId){
  assertPeriodEditable(periodId);
  const req=paydayRequirements(periodId),group=req.groups.find(g=>g.accountId===accountId);
  if(!group||group.amount<=0.5){modal=null;await load();return;}
  const stamp=new Date().toISOString(),tid=uid('tr'),date=today();
  await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:accountId,amount:group.amount,budgetPeriodId:periodId,status:'completed',plannedDate:date,completedDate:date,completedAt:stamp,transferType:accountId==='ibkr'?'investment_contribution':'payday',systemGenerated:true,createdAt:stamp,updatedAt:stamp});
  const allocs=group.items.filter(x=>x.bucketId);
  if(allocs.length) await bulkPut('transferAllocations',allocs.map(x=>({id:uid('ta'),transferId:tid,bucketId:x.bucketId,amount:x.remaining,goalId:null,label:x.label})));
  modal=null;await load();
}
async function createSweep(){
  const p=currentPeriod();if(!p)return;assertPeriodEditable(p.id);
  const sweep=sweepInfo(p.id);if(sweep.available<=0.5)return;
  const allocs=allocateGoalSurplus({amount:sweep.available,goals:state.goals,bucketBalances:state.bucketBalances});
  const bucketAllocs=allocs.filter(a=>a.bucketId),investmentAmount=allocs.filter(a=>a.accountId==='ibkr').reduce((sum,a)=>sum+Number(a.amount||0),0),ids=[];
  const esunAmount=bucketAllocs.reduce((sum,a)=>sum+Number(a.amount||0),0);
  if(esunAmount>0){
    const tid=uid('tr');ids.push(tid);
    await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'esun',amount:esunAmount,budgetPeriodId:p.id,status:'planned',plannedDate:today(),transferType:'month_end_sweep',createdAt:new Date().toISOString()});
    await bulkPut('transferAllocations',bucketAllocs.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:a.goalId||null,label:a.label})));
  }
  if(investmentAmount>0){const tid=uid('tr');ids.push(tid);await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:'ibkr',amount:investmentAmount,budgetPeriodId:p.id,status:'planned',plannedDate:today(),transferType:'month_end_sweep',createdAt:new Date().toISOString()});}
  modal=ids.length?{type:'transfer',id:ids[0]}:null;await load();
}
async function closePeriod(){
  const p=currentPeriod();if(!p)return;if(p.state==='closed')return;
  const c=monthCloseStatus(p.id);
  if(c.hardBlockers.length)throw new Error(`Month cannot close yet: ${c.hardBlockers.join('; ')}.`);
  if(c.missingFixed.length&&!confirm(`${c.missingFixed.length} fixed obligation${c.missingFixed.length===1?' is':'s are'} not fully recorded. Close the month anyway?`))return;
  const stamp=new Date().toISOString(),allIncome=state.incomes.filter(i=>i.budgetPeriodId===p.id&&!i.deletedAt).reduce((sum,i)=>sum+Number(i.amount||0),0),regularIncome=periodRegularIncome(p.id),health=dataHealthReport();
  await put('periods',{...p,state:'closed',closedAt:stamp,updatedAt:stamp});
  await put('monthlyCloses',{id:p.id,budgetPeriodId:p.id,status:'closed',closedAt:stamp,snapshotVersion:1,snapshotDate:today(),income:regularIncome,totalIncome:allIncome,eligibleIncome:periodEligibleIncome(p.id),expenses:totalExpenses(p.id),wealthContribution:completedCoreWealth(p.id),contributionRate:regularIncome>0?completedCoreWealth(p.id)/regularIncome:0,goalFunding:completedGoalFunding(p.id),titheAllocated:completedTithe(p.id),sweepAmount:c.sweep.alreadySwept,endingCoreWealth:state.wealth.coreWealth,endingFinancialNetWorth:state.wealth.financialNetWorth,endingAccountBalances:{ctbc:c.ct.actual,esun:c.es.actual,ibkrTwd:latestInvestmentTwd()},endingBucketBalances:{...state.bucketBalances},endingEmergency:Number(state.bucketBalances.emergency||0),endingTithe:Number(state.bucketBalances.tithe||0),endingHomeTravel:Number(state.bucketBalances['home-trip']||0),endingElectricity:Number(state.bucketBalances.electricity||0),fxRate:Number(state.settings.usdTwdRate||0),dataHealthSummary:{critical:health.critical,warn:health.warn,info:health.info},planSnapshot:c.plan,categoryActuals:c.totals,ctbcActual:c.ct.actual,esunActual:c.es.actual,missingFixedIds:c.missingFixed.map(x=>x.id)});
  modal=null;await load();
}
async function reopenPeriod(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p||p.state!=='closed')return;
  const stamp=new Date().toISOString();
  await put('periods',{...p,state:'reopened',reopenedAt:stamp,updatedAt:stamp});
  const rec=state.monthlyCloses.find(x=>x.budgetPeriodId===periodId||x.id===periodId);if(rec)await put('monthlyCloses',{...rec,status:'reopened',reopenedAt:stamp});
  selectedPeriodId=periodId;modal=null;await load();
}
async function saveGoal(form){
  const fd=new FormData(form),g=goal(form.dataset.goal);if(!g)throw new Error('Goal not found.');
  const targetAmount=Number(fd.get('targetAmount'));if(targetAmount+0.5<goalBal(g))throw new Error(`Target cannot be lower than the current ${g.name} balance of ${money(goalBal(g))}.`);
  const requiredThreshold=Math.max(0,...state.goals.filter(x=>x.prerequisiteGoalId===g.id).map(x=>Number(x.prerequisiteAmount||0)));if(targetAmount+0.5<requiredThreshold)throw new Error(`${g.name} cannot be set below ${money(requiredThreshold)} because another goal unlocks at that threshold.`);
  await put('goals',{...g,targetAmount,targetDate:fd.get('targetDate')||null,monthlyTarget:Number(fd.get('monthlyTarget')||0)||null,status:fd.get('status'),updatedAt:new Date().toISOString()});modal=null;await load();
}
async function saveGoalContribution(form){
  const fd=new FormData(form),g=goal(form.dataset.goal);if(!g)throw new Error('Goal not found.');
  const b=bucket(g.bucketId);if(!b)throw new Error('Goal bucket not found.');
  const amount=Number(fd.get('amount'));if(amount<=0)throw new Error('Enter a contribution amount.');
  const remaining=Math.max(0,Number(g.targetAmount||0)-goalBal(g));if(remaining>0&&amount>remaining+0.5)throw new Error(`This contribution exceeds the remaining ${money(remaining)} needed for ${g.name}.`);
  const periodId=fd.get('period')||null;assertPeriodEditable(periodId);
  const status=fd.get('completed')==='on'?'completed':'planned';if(status==='planned'&&!periodId)throw new Error('Choose an open funding month for a planned contribution, or mark the transfer completed.');
  const stamp=new Date().toISOString(),tid=uid('tr'),date=fd.get('date');
  await put('transfers',{id:tid,fromAccountId:'ctbc',toAccountId:b.accountId,amount,budgetPeriodId:periodId,status,plannedDate:date,completedDate:status==='completed'?date:null,completedAt:status==='completed'?stamp:null,transferType:'goal_contribution',createdAt:stamp,updatedAt:stamp});
  await put('transferAllocations',{id:uid('ta'),transferId:tid,bucketId:g.bucketId,amount,goalId:g.id,label:g.name});modal=null;await load();
}
async function saveInvestment(form){const fd=new FormData(form);const fx=Number(fd.get('fx'));await put('investmentSnapshots',{id:uid('snap'),accountId:'ibkr',date:fd.get('date'),value:Number(fd.get('value')),currency:'USD',fxRate:fx,createdAt:new Date().toISOString()});await put('settings',{...state.settings,usdTwdRate:fx,updatedAt:new Date().toISOString()});modal=null;await load();}
function prepareAccountReconciliation(form){
  const fd=new FormData(form),accountId=form.dataset.account,actualBalance=Number(fd.get('actualBalance'));
  if(!Number.isFinite(actualBalance)||actualBalance<0)throw new Error('Enter a valid non-negative bank balance.');
  modal={type:'reconcile-preview',draft:{accountId,actualBalance,date:fd.get('date')||today(),note:fd.get('note')||''}};
  render();
}
async function confirmAccountReconciliation(){
  const d=modal?.draft;if(!d)throw new Error('Balance preview is no longer available.');
  const snap=d.accountId==='esun'?esunSnapshot():accountSnapshot(d.accountId),expected=Number(snap.actual||0),stamp=new Date().toISOString();
  await put('reconciliations',{id:uid('rec'),accountId:d.accountId,date:d.date,actualBalance:Number(d.actualBalance),expectedBalance:expected,difference:Number(d.actualBalance)-expected,note:d.note||'',createdAt:stamp,appVersion:APP_VERSION});
  if(d.accountId==='esun'){
    const virtualTotal=state.buckets.filter(b=>b.accountId==='esun').reduce((sum,b)=>sum+Number(state.bucketBalances[b.id]||0),0);
    const unassigned=Number(d.actualBalance)-virtualTotal;
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
  const tid=uid('tr');await put('transfers',{id:tid,fromAccountId:'esun',toAccountId:'esun',amount:total,budgetPeriodId:null,status:'completed',plannedDate:today(),completedDate:today(),transferType:'bucket_allocation',affectsPhysicalBalance:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await bulkPut('transferAllocations',allocations.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:a.amount,goalId:null,label:a.label})));
  modal=null;await load();
}
async function saveEsunReallocation(form){
  const fd=new FormData(form),fromBucket=fd.get('fromBucket'),toBucket=fd.get('toBucket'),amount=Number(fd.get('amount'));
  if(fromBucket===toBucket)throw new Error('Choose two different purpose buckets.');
  if(amount<=0)throw new Error('Enter a reallocation amount greater than zero.');
  if(amount>Number(state.bucketBalances[fromBucket]||0)+0.5)throw new Error(`Cannot move more than the current ${bucket(fromBucket)?.name||'source'} balance of ${money(state.bucketBalances[fromBucket]||0)}.`);
  const stamp=new Date().toISOString(),tid=uid('tr'),date=fd.get('date')||today();
  await put('transfers',{id:tid,fromAccountId:'esun',toAccountId:'esun',amount,budgetPeriodId:null,status:'completed',plannedDate:date,completedDate:date,completedAt:stamp,transferType:'purpose_reallocation',affectsPhysicalBalance:false,note:fd.get('note')||'',createdAt:stamp,updatedAt:stamp});
  await bulkPut('transferAllocations',[
    {id:uid('ta'),transferId:tid,bucketId:fromBucket,amount:-amount,goalId:null,label:`Move from ${bucket(fromBucket)?.name||fromBucket}`},
    {id:uid('ta'),transferId:tid,bucketId:toBucket,amount:amount,goalId:null,label:`Move to ${bucket(toBucket)?.name||toBucket}`}
  ]);
  modal=null;await load();
}
async function reversePurposeAllocation(transferId){
  const t=state.transfers.find(x=>x.id===transferId&&!x.deletedAt);if(!t)throw new Error('Allocation record not found.');
  const event={transfer:t,allocations:allocationsForTransfer(t.id),reversedBy:state.transfers.find(r=>!r.deletedAt&&r.reversalOf===t.id)||null};
  if(!canReversePurposeEvent(event))throw new Error('This allocation cannot be reversed here. System-generated or already-reversed records are protected.');
  for(const a of event.allocations){if(Number(a.amount)>0&&Number(a.amount)>Number(state.bucketBalances[a.bucketId]||0)+0.5)throw new Error(`Cannot reverse ${bucket(a.bucketId)?.name||a.bucketId}; part of that allocation has already been used or moved.`);}
  const stamp=new Date().toISOString(),tid=uid('tr'),date=today();
  await put('transfers',{id:tid,fromAccountId:t.fromAccountId,toAccountId:t.toAccountId,amount:Number(t.amount||event.allocations.reduce((sum,a)=>sum+Math.abs(Number(a.amount||0)),0)),budgetPeriodId:null,status:'completed',plannedDate:date,completedDate:date,completedAt:stamp,transferType:'allocation_reversal',affectsPhysicalBalance:false,reversalOf:t.id,createdAt:stamp,updatedAt:stamp});
  await bulkPut('transferAllocations',event.allocations.map(a=>({id:uid('ta'),transferId:tid,bucketId:a.bucketId,amount:-Number(a.amount||0),goalId:null,label:`Reversal · ${a.label||bucket(a.bucketId)?.name||'allocation'}`})));
  modal={type:'account-audit',accountId:t.fromAccountId};await load();
}

async function deleteFundingMonth(periodId){
  const p=state.periods.find(x=>x.id===periodId);if(!p)throw new Error('Funding month not found.');
  if(p.state==='closed')throw new Error('Closed months cannot be deleted.');
  const transfers=state.transfers.filter(x=>x.budgetPeriodId===periodId&&!x.deletedAt);
  const completed=transfers.filter(x=>x.status==='completed'&&!(x.systemGenerated&&x.fromAccountId===x.toAccountId&&x.transferType==='reserve_allocation'));
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
  let x=null;
  if(kind==='expense')x=state.expenses.find(e=>e.id===id);
  if(kind==='income')x=state.incomes.find(e=>e.id===id);
  if(kind==='transfer')x=state.transfers.find(e=>e.id===id);
  if(!x)return;assertPeriodEditable(x.budgetPeriodId||null);
  if(kind==='expense')await put('expenses',{...x,deletedAt:new Date().toISOString()});
  if(kind==='income')await put('incomes',{...x,deletedAt:new Date().toISOString()});
  if(kind==='transfer')await put('transfers',{...x,deletedAt:new Date().toISOString()});
  await load();
}
async function saveSettings(form){
  const fd=new FormData(form);
  await put('settings',{...state.settings,forecastSalary:Number(fd.get('forecastSalary')),usdTwdRate:Number(fd.get('usdTwdRate')),operatingBuffer:Number(state.categories.find(c=>c.id==='operating-buffer')?.defaultAmount||3000),wealthRaisePercent:Number(fd.get('wealthRaisePercent')),forecastInvestmentReturn:Number(fd.get('forecastInvestmentReturn')),forecastSalaryGrowth:Number(fd.get('forecastSalaryGrowth')),conservativeInvestmentReturn:Number(fd.get('conservativeInvestmentReturn')),conservativeSalaryGrowth:Number(fd.get('conservativeSalaryGrowth')),aggressiveInvestmentReturn:Number(fd.get('aggressiveInvestmentReturn')),aggressiveSalaryGrowth:Number(fd.get('aggressiveSalaryGrowth')),appVersion:APP_VERSION,dataModelVersion:DATA_MODEL_VERSION,updatedAt:new Date().toISOString()});
  for(const c of state.categories){const v=fd.get(`cat-${c.id}`);if(v!==null)await put('categories',{...c,defaultAmount:Number(v),updatedAt:new Date().toISOString()});}
  const ob=fd.get('cat-operating-buffer');if(ob!==null)await put('settings',{...(await getOne('settings','app')),operatingBuffer:Number(ob),updatedAt:new Date().toISOString()});
  modal=null;await load();
}
async function backup(){const data=await exportData();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`wealth-os-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);await put('settings',{...state.settings,lastBackupAt:new Date().toISOString()});await load();}
function csvCell(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}
function downloadText(filename,text,type='text/csv;charset=utf-8'){const blob=new Blob([text],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();URL.revokeObjectURL(a.href);}
function exportActivityCsv(){
  const rows=[['Date','Type','Status','Title','Description','Account / Ledger','Amount (TWD)','Funding Month']];
  for(const x of activityRecords())rows.push([x._date||'',x._kind,x.status||'completed',x._title||'',x.description||x._detail||'',x._account||'',Number(x._amount||0),x.budgetPeriodId||'']);
  downloadText(`wealth-os-activity-${today()}.csv`,rows.map(r=>r.map(csvCell).join(',')).join('\n'));
}
function exportMonthlyCsv(){
  const rows=[['Month','State','Regular Income','Total Income','Expenses','Core Wealth Contribution','Contribution Rate','Core Wealth','Financial Net Worth']];
  for(const r of historyRecords())rows.push([r.id,r.state,Math.round(r.regularIncome||0),Math.round(r.totalIncome||0),Math.round(r.expenses||0),Math.round(r.wealthContribution||0),(Number(r.contributionRate||0)*100).toFixed(2),r.coreWealth===null?'':Math.round(r.coreWealth),r.financialNetWorth===null?'':Math.round(r.financialNetWorth)]);
  downloadText(`wealth-os-monthly-summary-${today()}.csv`,rows.map(r=>r.map(csvCell).join(',')).join('\n'));
}
async function restore(file){const text=await file.text();await importData(JSON.parse(text));modal=null;selectedPeriodId=null;await load();}
function runScenario(){
  const salary=Number(document.querySelector('#scenario-salary').value||0),annual=Number(document.querySelector('#scenario-return').value||0),growth=Number(document.querySelector('#scenario-growth').value||0),extra=Number(document.querySelector('#scenario-extra').value||0);
  const result=scenarioFor(annual,growth,extra,salary),sim=result.sim;
  document.querySelector('#scenario-result').innerHTML=`<div class="notice"><strong>${money(result.monthly)}/month</strong> starting modeled wealth capacity.<br>Salary growth: <strong>${growth.toFixed(1)}%</strong> · Investment return: <strong>${annual.toFixed(1)}%</strong><br>Emergency target: <strong>${formatMonths(sim.events.emergencyCompleteMonth)}</strong><br>${money(1000000)}: <strong>${formatMonths(sim.hits[1000000])}</strong> · ${money(5000000)}: <strong>${formatMonths(sim.hits[5000000])}</strong> · ${money(10000000)}: <strong>${formatMonths(sim.hits[10000000])}</strong><br><span class="sub">${Number(state.settings.wealthRaisePercent||75)}% of modeled salary raises is added to wealth capacity. Investment return applies only to investments.</span></div>`;
}

function bind(){
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;render();});
  const ps=document.querySelector('#period-select');if(ps)ps.onchange=()=>{selectedPeriodId=ps.value;render();};
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const a=b.dataset.action;try{
    if(a==='new-paycheck')modal={type:'paycheck'};
    if(a==='add-expense')modal={type:'expense',periodId:entryPeriodId()};
    if(a==='add-income')modal={type:'income'};
    if(a==='route-income')modal={type:'income-routing',incomeId:b.dataset.id};
    if(a==='skip-income-routing'){modal=null;return render();}
    if(a==='manual-transfer')modal={type:'manual-transfer'};
    if(a==='complete-transfer')modal={type:'transfer',id:b.dataset.id};
    if(a==='payday-transfer')modal={type:'payday-transfer',periodId:b.dataset.period,accountId:b.dataset.account};
    if(a==='confirm-payday-transfer')return completePaydayTransfer(b.dataset.period,b.dataset.account);
    if(a==='confirm-manual-transfer')return commitManualTransfer();
    if(a==='manual-transfer-back'){const d=modal?.draft;modal={type:'manual-transfer',id:d?.id||null,draft:d};return render();}
    if(a==='confirm-reconciliation')return confirmAccountReconciliation();
    if(a==='confirm-transfer')return completeTransfer(b.dataset.id);
    if(a==='month-close')modal={type:'close'};
    if(a==='create-sweep')return createSweep();
    if(a==='close-period')return closePeriod();
    if(a==='settings')modal={type:'settings'};
    if(a==='data-health')modal={type:'data-health'};
    if(a==='period-step'&&b.dataset.id){selectedPeriodId=b.dataset.id;return render();}
    if(a==='investment-snapshot')modal={type:'investment'};
    if(a==='account-reconcile')modal={type:'account-reconcile',accountId:b.dataset.id};
    if(a==='account-audit')modal={type:'account-audit',accountId:b.dataset.id};
    if(a==='esun-reallocate')modal={type:'esun-reallocate'};
    if(a==='account-adjustment')modal={type:'account-adjustment',accountId:b.dataset.id};
    if(a==='esun-allocate')modal={type:'esun-allocate',amount:esunSnapshot().unassigned};
    if(a==='delete-period')modal={type:'delete-period',periodId:b.dataset.id};
    if(a==='reopen-period')return reopenPeriod(b.dataset.id||currentPeriod()?.id);
    if(a==='edit-goal')modal={type:'edit-goal',goalId:b.dataset.id};
    if(a==='goal-contribution')modal={type:'goal-contribution',goalId:b.dataset.id};
    if(a==='confirm-delete-period'){
      if(confirm(`Delete ${monthLabel(b.dataset.id)} and all of its test data? This cannot be undone.`)) return deleteFundingMonth(b.dataset.id);
      return;
    }
    if(a==='reverse-allocation'){if(confirm('Reverse this virtual-purpose allocation? This creates a new audit record and does not move bank cash.'))return reversePurposeAllocation(b.dataset.id);return;}
    if(a==='activity-filter'){activityFilter=b.dataset.filter;return render();}
    if(a==='clear-activity-search'){activitySearch='';return render();}
    if(a==='record-fixed'){const c=category(b.dataset.category);modal={type:'expense',periodId:entryPeriodId(),prefill:{amount:Number(b.dataset.amount||0),categoryId:b.dataset.category,accountId:'ctbc',description:c?.name||'Fixed obligation'}};}
    if(a==='repeat-expense'){const x=state.expenses.find(e=>e.id===b.dataset.id);if(x){modal={type:'expense',periodId:entryPeriodId(),prefill:{amount:Number(x.amount||0),categoryId:x.categoryId,accountId:x.accountId||'ctbc',fundingBucketId:x.fundingBucketId||'',description:x.description||''}};}}
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
    if(a==='export-activity-csv')return exportActivityCsv();
    if(a==='export-monthly-csv')return exportMonthlyCsv();
    if(a==='run-scenario')return runScenario();
    render();
  }catch(err){alert(err.message||String(err));}});
  const pf=document.querySelector('#paycheck-form');if(pf)pf.onsubmit=e=>{e.preventDefault();createPaycheck(pf).catch(err=>alert(err.message));};
  const ef=document.querySelector('#expense-form');if(ef)ef.onsubmit=e=>{e.preventDefault();saveExpense(ef).catch(err=>alert(err.message));};
  const inf=document.querySelector('#income-form');if(inf){inf.onsubmit=e=>{e.preventDefault();saveIncome(inf).catch(err=>alert(err.message));};const it=inf.querySelector('#income-type'),tc=inf.querySelector('#income-tithe'),rc=inf.querySelector('#income-routing');if(it&&!inf.querySelector('input[name=id]').value)it.onchange=()=>{if(tc)tc.checked=['regular_income','bonus'].includes(it.value);if(rc)rc.checked=!['regular_income','reimbursement'].includes(it.value);};}
  const irf=document.querySelector('#income-routing-form');if(irf)irf.onsubmit=e=>{e.preventDefault();saveIncomeRouting(irf).catch(err=>alert(err.message));};
  const mtf=document.querySelector('#manual-transfer-form');if(mtf)mtf.onsubmit=e=>{e.preventDefault();try{prepareManualTransfer(mtf);}catch(err){alert(err.message);}};
  const inv=document.querySelector('#investment-form');if(inv)inv.onsubmit=e=>{e.preventDefault();saveInvestment(inv).catch(err=>alert(err.message));};
  const arf=document.querySelector('#account-reconcile-form');if(arf)arf.onsubmit=e=>{e.preventDefault();try{prepareAccountReconciliation(arf);}catch(err){alert(err.message);}};
  const aaf=document.querySelector('#account-adjustment-form');if(aaf)aaf.onsubmit=e=>{e.preventDefault();saveAccountAdjustment(aaf).catch(err=>alert(err.message));};
  const eal=document.querySelector('#esun-allocation-form');if(eal)eal.onsubmit=e=>{e.preventDefault();saveEsunAllocation(eal).catch(err=>alert(err.message));};
  const erl=document.querySelector('#esun-reallocation-form');if(erl)erl.onsubmit=e=>{e.preventDefault();saveEsunReallocation(erl).catch(err=>alert(err.message));};
  const gef=document.querySelector('#goal-edit-form');if(gef)gef.onsubmit=e=>{e.preventDefault();saveGoal(gef).catch(err=>alert(err.message));};
  const gcf=document.querySelector('#goal-contribution-form');if(gcf)gcf.onsubmit=e=>{e.preventDefault();saveGoalContribution(gcf).catch(err=>alert(err.message));};
  const sf=document.querySelector('#settings-form');if(sf)sf.onsubmit=e=>{e.preventDefault();saveSettings(sf).catch(err=>alert(err.message));};
  const asf=document.querySelector('#activity-search-form');if(asf)asf.onsubmit=e=>{e.preventDefault();activitySearch=document.querySelector('#activity-search-input')?.value||'';render();};
  const rf=document.querySelector('#restore-file');if(rf)rf.onchange=()=>{if(rf.files[0]&&confirm('Replace all local Wealth OS data with this backup?'))restore(rf.files[0]).catch(err=>alert(err.message));};
}

if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
load().catch(err=>{root.innerHTML=`<pre style="padding:20px">${esc(err.stack||err.message)}</pre>`;});
