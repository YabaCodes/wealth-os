import { DEFAULTS } from './defaults.js';

const DB_NAME='wealth-os-db';
const DB_VERSION=2;
const STORES=['accounts','buckets','categories','goals','periods','incomes','expenses','transfers','transferAllocations','investmentSnapshots','reconciliations','adjustments','monthlyCloses','settings'];
let dbPromise;

function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      for(const s of STORES){ if(!db.objectStoreNames.contains(s)) db.createObjectStore(s,{keyPath:'id'}); }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}

export async function getAll(store){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly');const r=tx.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});
}
export async function getOne(store,id){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly');const r=tx.objectStore(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
export async function put(store,obj){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(obj);tx.oncomplete=()=>resolve(obj);tx.onerror=()=>reject(tx.error);});
}
export async function bulkPut(store,items){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');const os=tx.objectStore(store);items.forEach(x=>os.put(x));tx.oncomplete=()=>resolve(items);tx.onerror=()=>reject(tx.error);});
}
export async function remove(store,id){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
}
export async function clearStore(store){
  const db=await openDb();
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
}
export const uid=(prefix='id')=>`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

export async function seedIfNeeded(){
  const existing=await getAll('settings');
  if(existing.length) return;
  await bulkPut('accounts',DEFAULTS.accounts);
  await bulkPut('buckets',DEFAULTS.buckets);
  await bulkPut('categories',DEFAULTS.categories);
  await bulkPut('goals',DEFAULTS.goals);
  await put('settings',{id:'app',...DEFAULTS.settings});
  await put('investmentSnapshots',{id:'initial-ibkr',accountId:'ibkr',date:'2026-09-28',value:3536,currency:'USD',fxRate:DEFAULTS.settings.usdTwdRate,createdAt:new Date().toISOString()});
}

export async function exportData(){
  const out={version:1,exportedAt:new Date().toISOString(),data:{}};
  for(const s of STORES) out.data[s]=await getAll(s);
  return out;
}
export async function importData(payload){
  if(!payload || payload.version!==1 || !payload.data) throw new Error('Unsupported backup file.');
  for(const s of STORES){
    await clearStore(s);
    if(Array.isArray(payload.data[s]) && payload.data[s].length) await bulkPut(s,payload.data[s]);
  }
}

export async function bucketBalances(){
  const [buckets,allocs,expenses]=await Promise.all([getAll('buckets'),getAll('transferAllocations'),getAll('expenses')]);
  const out={};
  buckets.forEach(b=>out[b.id]=Number(b.openingBalance||0));
  const transfers=await getAll('transfers');
  const completed=new Set(transfers.filter(t=>t.status==='completed'&&!t.deletedAt).map(t=>t.id));
  for(const a of allocs){ if(completed.has(a.transferId)) out[a.bucketId]=(out[a.bucketId]||0)+Number(a.amount||0); }
  for(const e of expenses){ if(!e.deletedAt && e.fundingBucketId) out[e.fundingBucketId]=(out[e.fundingBucketId]||0)-Number(e.amount||0); }
  return out;
}

export async function accountBalances(){
  const [accounts,incomes,expenses,transfers,snaps,adjustments,settings]=await Promise.all([
    getAll('accounts'),getAll('incomes'),getAll('expenses'),getAll('transfers'),getAll('investmentSnapshots'),getAll('adjustments'),getOne('settings','app')
  ]);
  const out={};
  accounts.forEach(a=>out[a.id]=Number(a.openingBalance||0));
  for(const i of incomes){ if(!i.deletedAt) out[i.accountId]=(out[i.accountId]||0)+Number(i.amount||0); }
  for(const e of expenses){ if(!e.deletedAt) out[e.accountId]=(out[e.accountId]||0)-Number(e.amount||0); }
  for(const t of transfers.filter(t=>t.status==='completed'&&!t.deletedAt)){
    out[t.fromAccountId]=(out[t.fromAccountId]||0)-Number(t.amount||0);
    out[t.toAccountId]=(out[t.toAccountId]||0)+Number(t.amount||0);
  }
  for(const a of adjustments){
    if(!a.deletedAt) out[a.accountId]=(out[a.accountId]||0)+Number(a.amount||0);
  }
  // Brokerage is snapshot-driven, not cash-ledger-driven, because market movement changes its value.
  const ibkr=accounts.find(a=>a.role==='investment');
  if(ibkr){
    const relevant=snaps.filter(s=>s.accountId===ibkr.id).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    if(relevant.length) out[ibkr.id]=Number(relevant.at(-1).value||0);
  }
  return out;
}

export async function wealthMetrics(){
  const [accounts,buckets,bb,ab,snaps,settings,reconciliations]=await Promise.all([
    getAll('accounts'),getAll('buckets'),bucketBalances(),accountBalances(),getAll('investmentSnapshots'),getOne('settings','app'),getAll('reconciliations')
  ]);
  const fx=Number(settings?.usdTwdRate||1);
  const latestActual={};
  for(const r of [...reconciliations].sort((a,b)=>`${a.date||''}${a.createdAt||''}`.localeCompare(`${b.date||''}${b.createdAt||''}`))){
    if(!r.deletedAt) latestActual[r.accountId]=Number(r.actualBalance||0);
  }
  let financialNetWorth=0;
  // Reserved E.SUN is classified by virtual purpose buckets so tithe stays excluded.
  for(const a of accounts){
    if(a.role==='reserved') continue;
    const raw=(a.role!=='investment' && latestActual[a.id]!==undefined)?latestActual[a.id]:Number(ab[a.id]||0);
    const v=raw*(a.currency==='USD'?fx:1);
    financialNetWorth += v;
  }
  for(const b of buckets){ if(b.countsTowardNetWorth) financialNetWorth += Number(bb[b.id]||0); }
  let coreWealth=0;
  for(const b of buckets){ if(b.countsTowardCoreWealth) coreWealth += Number(bb[b.id]||0); }
  for(const a of accounts.filter(x=>x.role==='investment')) coreWealth += Number(ab[a.id]||0)*(a.currency==='USD'?fx:1);
  return {financialNetWorth,coreWealth,bucketBalances:bb,accountBalances:ab,latestActual};
}
