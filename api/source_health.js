// Read-only upstream diagnostic. Never creates stock picks, BUY signals or full-market claims.
export const config = { maxDuration: 30 };
const BASE = 'https://push2.eastmoney.com';
const TX = 'https://qt.gtimg.cn';
const TXX = 'https://web.ifzq.gtimg.cn';
const FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const FIELDS = 'f12,f14,f2,f3,f5,f6,f8,f9,f10,f20,f21,f23,f24,f25,f62,f184,f100';
const TOKEN = 'bd1d9ddb04089700cf9c27f6f7426281';
const UA = 'Mozilla/5.0 AShareQuant/source-health-v1';
const probes = [
  {id:'em-production-parameters',provider:'eastmoney',kind:'em-list',token:false},
  {id:'em-token-parameters',provider:'eastmoney',kind:'em-list',token:true},
  {id:'em-single-quote',provider:'eastmoney',kind:'em-quote'},
  {id:'tencent-batch-quote',provider:'tencent',kind:'tx-quote'},
  {id:'tencent-daily-kline',provider:'tencent',kind:'tx-kline'}
];
function urlFor(p){
  if(p.kind==='em-list'){
    const u=new URL('/api/qt/clist/get',BASE);
    const args={pn:'1',pz:'20',po:'1',np:'1',fltt:'2',invt:'2',fid:'f6',fs:FS,fields:FIELDS};
    if(p.token)args.ut=TOKEN;
    u.search=new URLSearchParams(args).toString();return u.toString();
  }
  if(p.kind==='em-quote'){
    const u=new URL('/api/qt/stock/get',BASE);
    u.search=new URLSearchParams({secid:'1.600707',fields:'f43,f57,f58,f60,f124',fltt:'2',invt:'2'}).toString();return u.toString();
  }
  if(p.kind==='tx-quote')return TX+'/q=sh600707,sz002436';
  return TXX+'/appstock/app/fqkline/get?param=sh600707,day,,,5,qfq';
}
function headersFor(p){return {'user-agent':UA,'accept':p.provider==='eastmoney'?'application/json,text/javascript,*/*;q=0.8':'text/plain,application/json,*/*','referer':p.provider==='eastmoney'?'https://quote.eastmoney.com/':'https://gu.qq.com/'};}
function parseMaybeJsonp(raw){const s=String(raw).trim();try{return JSON.parse(s);}catch{}const l=s.indexOf('('),r=s.lastIndexOf(')');if(l>=0&&r>l)return JSON.parse(s.slice(l+1,r));throw Error('invalid-json');}
function parsePayload(p,raw){
  if(p.kind==='tx-quote'){
    const matches=[...raw.matchAll(/v_(sh|sz)(\d{6})="([^"]*)"/g)];
    const quotes=matches.map(m=>{const a=m[3].split('~');return {code:m[2],price:Number(a[3]),prevClose:Number(a[4]),quoteTime:a[30]||null,fields:a.length};});
    const valid=quotes.length===2&&quotes.every(x=>x.fields>=35&&Number.isFinite(x.price)&&x.price>0&&Number.isFinite(x.prevClose)&&x.prevClose>0&&/^\d{14}$/.test(x.quoteTime||''));
    return {valid,returned:quotes.length,quotes};
  }
  const j=parseMaybeJsonp(raw);
  if(p.kind==='em-list'){
    const v=j?.data?.diff,rows=Array.isArray(v)?v:v&&typeof v==='object'?Object.values(v):null;
    return {valid:Array.isArray(rows)&&rows.length>0&&Number.isInteger(Number(j?.data?.total)),providerRc:j?.rc??null,providerTotal:j?.data?.total??null,returned:rows?.length??null,firstCode:rows?.[0]?.f12??null};
  }
  if(p.kind==='em-quote')return {valid:Number.isFinite(Number(j?.data?.f43))&&Number(j.data.f43)>0,providerRc:j?.rc??null,code:j?.data?.f57??null,quoteTime:j?.data?.f124??null};
  const box=j?.data?.sh600707||{},rows=box.qfqday||box.day;
  return {valid:Array.isArray(rows)&&rows.length>0,returned:rows?.length??null,lastDate:rows?.at(-1)?.[0]??null};
}
export function makeHandler({fetchImpl=fetch,now=()=>Date.now(),timeoutMs=4000}={}){
 async function inspect(p){const started=now(),ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
   const head={id:p.id,provider:p.provider};
   try{
     const r=await fetchImpl(urlFor(p),{signal:ctrl.signal,headers:headersFor(p),cache:'no-store'});
     const raw=await r.text();
     const common={...head,httpStatus:r.status,elapsedMs:now()-started,contentType:r.headers?.get?.('content-type')??null};
     if(!r.ok)return {...common,valid:false,error:'upstream-http-'+r.status,responseKind:raw.trim().startsWith('<')?'html':'other'};
     try{return {...common,...parsePayload(p,raw)};}catch(e){return {...common,valid:false,error:'parse-failed',detail:String(e?.message||e).slice(0,80)};}
   }catch(e){return {...head,valid:false,elapsedMs:now()-started,error:ctrl.signal.aborted?'request-timeout':String(e?.name||'fetch-failed'),detail:String(e?.message||e).slice(0,80)};}
   finally{clearTimeout(timer);}
 }
 return async function handler(req,res){res.setHeader('Cache-Control','no-store');
   if(req.method!=='GET')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
   const results=new Array(probes.length);let next=0;
   await Promise.all(Array.from({length:2},async()=>{while(next<probes.length){const i=next++;results[i]=await inspect(probes[i]);}}));
   return res.status(200).json({schema:'ashare-source-health-v1',capturedAt:new Date(now()).toISOString(),diagnosticOnly:true,neverTradeSignal:true,notFullMarketScan:true,qualifiedForDiscovery:false,results,healthy:results.filter(x=>x.valid).map(x=>x.id)});
 };
}
export default makeHandler();
