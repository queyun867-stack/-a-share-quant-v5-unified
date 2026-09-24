
'use strict';
// V10.3.7 independent SHADOW universe. Does not modify /api/market or create BUY.
// Uses the provider's Shanghai/Shenzhen main-board segment filters; verification is scoped
// to the provider's returned universe, NOT to an exchange-certified full-list registry.
const DEFAULT_SEGMENTS = Object.freeze([
  {key:'SZ_MAIN',fs:'m:0+t:6'},
  {key:'SH_MAIN',fs:'m:1+t:2'}
]);
const FIELDS='f12,f14,f2,f3,f6,f8,f20,f24,f62,f100,f124,f184';
const PAGE_SIZE=200;
const MAX_PAGES=40;
function n(v){if(v===null||v===undefined||v==='-'||v==='')return NaN;const x=Number(v);return Number.isFinite(x)?x:NaN;}
function isMainBoard(code){return /^(00|60)\d{4}$/.test(code);}
function shanghaiDate(ms){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));}
function marketOpen(now){const p=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),get=k=>p.find(x=>x.type===k)?.value;const h=Number(get('hour')),m=Number(get('minute')),t=h*60+m;return ['Mon','Tue','Wed','Thu','Fri'].includes(get('weekday'))&&((t>=570&&t<690)||(t>=780&&t<900));}
function normalize(row,segment){const code=String(row?.f12??''),timestamp=n(row?.f124);return{
  code,name:String(row?.f14??''),segment,price:n(row?.f2),pct:n(row?.f3),amount:n(row?.f6),turn:n(row?.f8),mcap:n(row?.f20),pct60:n(row?.f24),mainNet:n(row?.f62),mainPct:n(row?.f184),industry:!row?.f100||row.f100==='-'?'':String(row.f100),quoteAt:Number.isFinite(timestamp)&&timestamp>=1e9&&timestamp<=2.2e9?new Date(timestamp*1000).toISOString():null,
  specialTreatment:/ST|退/i.test(String(row?.f14??'')),mainBoard:isMainBoard(code)
};}
function metrics(rows,now,startedAt,finishedAt,minUniverse){
 const errors=[],eligible=rows.filter(x=>x.mainBoard&&!x.specialTreatment&&x.price>=2&&x.amount>=8e7&&Number.isFinite(x.pct));
 const numericQuote=rows.filter(x=>x.quoteAt),validDate=numericQuote.filter(x=>shanghaiDate(Date.parse(x.quoteAt))===shanghaiDate(now));
 const fresh=validDate.filter(x=>{const lag=(now-Date.parse(x.quoteAt))/1000;return lag>=-60&&lag<=180;});
 const industry=rows.filter(x=>x.industry&&x.industry!=='未知');
 const quoteCoverage=numericQuote.length/Math.max(1,rows.length),freshRatio=fresh.length/Math.max(1,rows.length),industryCoverage=industry.length/Math.max(1,rows.length);
 if(rows.length<minUniverse)errors.push('universe-below-minimum');
 if(quoteCoverage<.95)errors.push('quote-timestamp-coverage-below-95pct');
 if(freshRatio<.90)errors.push('fresh-quote-coverage-below-90pct');
 if(industryCoverage<.90)errors.push('industry-coverage-below-90pct');
 if(finishedAt-startedAt>120000)errors.push('page-collection-span-over-120s');
 if(!marketOpen(now))errors.push('outside-continuous-trading');
 const quoteTimes=numericQuote.map(x=>Date.parse(x.quoteAt));
 return{qualified:errors.length===0,errors,quoteCoverage,freshRatio,industryCoverage,eligibleCount:eligible.length,
   quoteMinAt:quoteTimes.length?new Date(Math.min(...quoteTimes)).toISOString():null,
   quoteMaxAt:quoteTimes.length?new Date(Math.max(...quoteTimes)).toISOString():null,
   providerDate:shanghaiDate(now),session:marketOpen(now)?'CONTINUOUS_TRADING':'OUTSIDE_SESSION',
   collectionSpanMs:finishedAt-startedAt,approximatePointInTime:true,notCertifiedSynchronousSnapshot:true};
}
function aggregate(rows){
 const g=new Map();for(const r of rows){if(!r.mainBoard||r.specialTreatment||!Number.isFinite(r.pct)||!r.industry||r.industry==='未知')continue;const a=g.get(r.industry)||[];a.push(r);g.set(r.industry,a);}
 const sectors=[...g.entries()].map(([industry,a])=>{const pct=a.map(x=>x.pct).sort((x,y)=>x-y),mid=Math.floor(pct.length/2),median=pct.length%2?pct[mid]:(pct[mid-1]+pct[mid])/2;
  return{industry,n:a.length,breadth:a.filter(x=>x.pct>0).length/a.length,strongCount:a.filter(x=>x.pct>=3).length,nearTenPctCount:a.filter(x=>x.pct>=9.5).length,medianPct:median,
    leaders:a.filter(x=>x.price>=2&&x.amount>=8e7).sort((x,y)=>y.pct-x.pct||y.amount-x.amount||x.code.localeCompare(y.code)).slice(0,3).map(x=>({code:x.code,name:x.name,pct:x.pct,amount:x.amount,quoteAt:x.quoteAt}))};
 }).filter(x=>x.n>=5).sort((a,b)=>b.strongCount/b.n-a.strongCount/a.n||b.breadth-a.breadth||b.medianPct-a.medianPct||a.industry.localeCompare(b.industry));
 const eligible=rows.filter(x=>x.mainBoard&&!x.specialTreatment&&x.price>=2&&x.amount>=8e7&&Number.isFinite(x.pct));
 const leaders=[...eligible].sort((a,b)=>b.pct-a.pct||b.amount-a.amount||a.code.localeCompare(b.code)).slice(0,20).map(x=>({code:x.code,name:x.name,industry:x.industry,pct:x.pct,pct60:Number.isFinite(x.pct60)?x.pct60:null,amount:x.amount,turn:Number.isFinite(x.turn)?x.turn:null,quoteAt:x.quoteAt,
  notLimitUpVerified:true,notExecutableVerified:true}));
 return{sectors,leaders,nearTenPctIsApproximate:true,noSealedOrderBookData:true,noConceptConstituentMapping:true};
}
function createHandler({fetchImpl=fetch,now=()=>Date.now(),pageSize=PAGE_SIZE,minUniverse=500,segments=DEFAULT_SEGMENTS,host='https://push2.eastmoney.com',timeoutMs=6500}={}){
 async function fetchPage(segment,page){const url=new URL('/api/qt/clist/get',host);url.search=new URLSearchParams({pn:String(page),pz:String(pageSize),po:'1',np:'1',ut:'bd1d9ddb04089700cf9c27f6f7426281',fltt:'2',invt:'2',fid:'f3',fs:segment.fs,fields:FIELDS}).toString();
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{const response=await fetchImpl(url.toString(),{signal:ctrl.signal,headers:{accept:'application/json'},cache:'no-store'});if(!response.ok)throw Error('upstream-http-'+response.status);const j=await response.json();const total=n(j?.data?.total),d=j?.data?.diff;const diff=Array.isArray(d)?d:(d&&typeof d==='object'?Object.values(d):null);
   if(!Number.isInteger(total)||total<0||!Array.isArray(diff))throw Error('upstream-malformed-page');return{page,total,diff};
  }finally{clearTimeout(timer);}}
 async function collect(){const started=now(),pageMeta=[],records=[],seen=new Set(),totals={};
  for(const s of segments){const first=await fetchPage(s,1),pages=Math.ceil(first.total/pageSize);if(!first.total||pages>MAX_PAGES)throw Error('universe-total-invalid-'+s.key);totals[s.key]=first.total;
   const append=p=>{pageMeta.push({segment:s.key,page:p.page,total:p.total,count:p.diff.length,receivedAt:new Date(now()).toISOString()});if(p.total!==first.total)throw Error('universe-total-drift-'+s.key);const expected=Math.min(pageSize,first.total-(p.page-1)*pageSize);if(p.diff.length!==expected)throw Error('page-size-mismatch-'+s.key+'-'+p.page);
    for(const row of p.diff){const x=normalize(row,s.key);if(!x.mainBoard)throw Error('segment-non-main-board-'+s.key+'-'+x.code);if(seen.has(x.code))throw Error('duplicate-code-'+x.code);seen.add(x.code);records.push(x);}};
   append(first);
   // 4 concurrent page requests keep the endpoint bounded without trusting partial results.
   for(let p=2;p<=pages;p+=4){const batch=await Promise.all(Array.from({length:Math.min(4,pages-p+1)},(_,i)=>fetchPage(s,p+i)));for(const item of batch)append(item);}
  }
  const expected=Object.values(totals).reduce((a,b)=>a+b,0);if(records.length!==expected)throw Error('universe-count-mismatch');
  const finished=now(),quality=metrics(records,finished,started,finished,minUniverse);
  return{schema:'ashare-independent-main-board-v1',status:quality.qualified?'QUALIFIED_OBSERVATION':'UNQUALIFIED_OBSERVATION',qualifiedForDiscovery:quality.qualified,neverTradeSignal:true,
    source:{provider:'Eastmoney-clist',scope:'provider-main-board-segments-only',segments,counts:totals,notExchangeCertified:true},
    asOf:{collectionStartedAt:new Date(started).toISOString(),collectionFinishedAt:new Date(finished).toISOString(),quoteTimestampField:'f124',notAtomicSnapshot:true},
    quality:{...quality,pages:pageMeta.length,records:records.length},pageMeta,sectorResearch:aggregate(records),records:records.map(r=>({...r,price:Number.isFinite(r.price)?r.price:null,pct:Number.isFinite(r.pct)?r.pct:null,amount:Number.isFinite(r.amount)?r.amount:null,turn:Number.isFinite(r.turn)?r.turn:null,mcap:Number.isFinite(r.mcap)?r.mcap:null,pct60:Number.isFinite(r.pct60)?r.pct60:null,mainNet:Number.isFinite(r.mainNet)?r.mainNet:null,mainPct:Number.isFinite(r.mainPct)?r.mainPct:null}))};
 }
 return async function handler(req,res){res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Content-Type','application/json; charset=utf-8');if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try{return res.status(200).json(await collect());}catch(e){return res.status(503).json({schema:'ashare-independent-main-board-v1',status:'SOURCE_FAILED',qualifiedForDiscovery:false,neverTradeSignal:true,asOf:{failedAt:new Date(now()).toISOString()},error:String(e?.message||'unknown-upstream-error').slice(0,180),records:[],noPartialUniverse:true});}
 };
}

export default createHandler();
export { createHandler };
export const _internal = {normalize,metrics,aggregate,isMainBoard,marketOpen};
