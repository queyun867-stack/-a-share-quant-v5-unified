export const config = { maxDuration: 30 };

const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];

const UA = 'Mozilla/5.0 AShareQuant/10.1.7-S';
const MARKET_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const MARKET_FIELDS = 'f12,f14,f2,f3,f5,f6,f8,f9,f10,f20,f21,f23,f24,f25,f62,f184,f100';

function secid(code) {
  return /^(6|68)/.test(code) ? `1.${code}` : `0.${code}`;
}

function parseMaybeJsonp(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('empty upstream response');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('('), b = t.lastIndexOf(')');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a + 1, b));
  throw new Error('invalid upstream response');
}

async function fetchParsed(url, timeout = 8500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'application/json,text/javascript,*/*;q=0.8',
        'referer': 'https://quote.eastmoney.com/'
      }
    });
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    return parseMaybeJsonp(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

function marketUrl(host, page, pz, fid = 'f6', po = '1') {
  const p = new URLSearchParams({
    pn: String(page), pz: String(pz), po: String(po), np: '1',
    fltt: '2', invt: '2', fid,
    fs: MARKET_FS,
    fields: MARKET_FIELDS
  });
  return `${host}/api/qt/clist/get?${p}`;
}

function ymdDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function klineUrl(code) {
  const p = new URLSearchParams({
    secid: secid(code), klt: '101', fqt: '1', beg: ymdDaysAgo(300), end: '20500101', lmt: '180',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${p}`;
}
function flowUrl(code) {
  const p = new URLSearchParams({
    lmt: '30', klt: '101', secid: secid(code),
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
  });
  return `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${p}`;
}

function quoteUrl(code) {
  const p = new URLSearchParams({
    secid: secid(code),
    fields: 'f43,f57,f58,f169,f170,f46,f44,f45,f47,f48,f60,f62,f184,f168,f100',
    fltt: '2', invt: '2'
  });
  return `https://push2.eastmoney.com/api/qt/stock/get?${p}`;
}

function indexQuoteUrl(id) {
  const p = new URLSearchParams({
    secid: id,
    fields: 'f43,f57,f58,f169,f170,f60',
    fltt: '2', invt: '2'
  });
  return `https://push2.eastmoney.com/api/qt/stock/get?${p}`;
}

function newsUrl(code) {
  const body = {
    uid: '', keyword: code, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: 12, preTag: '', postTag: '' } }
  };
  return `https://search-api-web.eastmoney.com/search/jsonp?param=${encodeURIComponent(JSON.stringify(body))}&cb=quantcb`;
}

function send(res, status, data, maxAge = 20) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', `public, s-maxage=${maxAge}, stale-while-revalidate=${Math.max(60, maxAge * 4)}`);
  res.status(status).send(JSON.stringify(data));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchMarketRank(fid, page = 1, pz = 100, seed = 0) {
  let last;
  const hosts = [
    EM_HOSTS[seed % EM_HOSTS.length],
    EM_HOSTS[(seed + 1) % EM_HOSTS.length]
  ];

  for (const host of hosts) {
    try {
      const j = await fetchParsed(marketUrl(host, page, pz, fid, '1'), 3500);
      if (j?.data) return j;
    } catch (e) {
      last = e;
    }
  }

  throw last || new Error(`rank source ${fid} unavailable`);
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { error: e?.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  return out;
}

function parseCodes(raw, max) {
  return String(raw || '').split(',').map(s => s.trim()).filter(s => /^\d{6}$/.test(s)).slice(0, max);
}

let rankedMemory = null;

async function rankedCandidates() {
  const now = Date.now();

  if (rankedMemory && now - rankedMemory.t < 120000) {
    return rankedMemory.value;
  }

  const specs = [
    { key: 'mainNet', fid: 'f62', weight: 1.00 },
    { key: 'mainPct', fid: 'f184', weight: 0.90 },
    { key: 'amount', fid: 'f6', weight: 0.60 },
    { key: 'turnover', fid: 'f8', weight: 0.45 },
    { key: 'dayMomentum', fid: 'f3', weight: 0.35 },
    { key: 'swingMomentum', fid: 'f24', weight: 0.45 }
  ];

  const indexSpecs = [
    ['ä¸è¯', '1.000001'],
    ['æ·±è¯', '0.399001'],
    ['åä¸æ¿', '0.399006'],
    ['ç§å50', '1.000688']
  ];

  const indexPromise = Promise.allSettled(
    indexSpecs.map(async ([name, id]) => {
      const j = await fetchParsed(indexQuoteUrl(id), 2500);
      return { name, id, pct: +j?.data?.f170, price: +j?.data?.f43 };
    })
  );

  const lists = await mapLimit(specs, 6, async (spec, i) => {
    const first = await fetchMarketRank(spec.fid, 1, 100, i);
    return {
      spec,
      total: +first?.data?.total || 0,
      rows: first?.data?.diff || []
    };
  });

  const merged = new Map();
  let universeTotal = 0;
  let okLists = 0;
  const failures = [];

  for (let i = 0; i < lists.length; i++) {
    const z = lists[i];
    const spec = specs[i];

    if (!z || z.error) {
      failures.push({ key: spec.key, error: z?.error || 'unknown' });
      continue;
    }

    okLists++;
    universeTotal = universeTotal || z.total || 0;

    for (let r = 0; r < z.rows.length; r++) {
      const row = z.rows[r];
      const code = String(row?.f12 || '');
      if (!/^(0|3|6)\d{5}$/.test(code)) continue;

      const old = merged.get(code) || {
        ...row,
        _rankPoints: 0,
        _rankHits: 0,
        _ranks: {}
      };

      const decay = Math.max(0, 1 - r / Math.max(1, z.rows.length));
      old._rankPoints += spec.weight * decay;
      old._rankHits += 1;
      old._ranks[spec.key] = r + 1;
      merged.set(code, old);
    }
  }

  if (okLists < 3) {
    if (rankedMemory && now - rankedMemory.t < 30 * 60 * 1000) {
      return {
        data: {
          ...rankedMemory.value.data,
          serverStale: true,
          serverStaleAgeMin: Math.round((now - rankedMemory.t) / 60000)
        }
      };
    }
    throw new Error(`rank sources insufficient: ${okLists}/${specs.length}`);
  }

  const rows = [...merged.values()]
    .map(row => ({
      ...row,
      rankScore: Math.min(100, row._rankPoints / 1.55 * 100),
      rankHits: row._rankHits,
      ranks: row._ranks
    }))
    .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));

  const indexSettled = await indexPromise;
  const indices = indexSettled
    .filter(x => x.status === 'fulfilled' && Number.isFinite(x.value?.pct))
    .map(x => x.value);

  const value = {
    data: {
      universeTotal,
      candidates: rows.slice(0, 420),
      candidateCount: rows.length,
      listsOk: okLists,
      listsTotal: specs.length,
      failures,
      indices,
      generatedAt: new Date().toISOString(),
      method: 'full-universe-ranked-preselection-fast-v2',
      serverStale: false
    }
  };

  rankedMemory = { t: now, value };
  return value;
}
export default async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const action = u.searchParams.get('action') || '';
  const code = u.searchParams.get('code') || '';

  try {
    if (action === 'ranked_candidates') {
      return send(res, 200, await rankedCandidates(), 300);
    }

    if (action === 'deep_batch') {
      const codes = parseCodes(u.searchParams.get('codes'), 30);
      if (!codes.length) return send(res, 400, { error: 'no valid codes' }, 0);
      const items = await mapLimit(codes, 5, async c => {
        const [kline, flow] = await Promise.all([
          fetchParsed(klineUrl(c), 9000),
          fetchParsed(flowUrl(c), 9000).catch(() => null)
        ]);
        return { code: c, kline, flow };
      });
      return send(res, 200, { items: items.map((z, i) => z?.error ? { code: codes[i], error: z.error } : z) }, 60);
    }

    if (action === 'news_batch') {
      const codes = parseCodes(u.searchParams.get('codes'), 8);
      if (!codes.length) return send(res, 400, { error: 'no valid codes' }, 0);
      const items = await mapLimit(codes, 4, async c => {
        const news = await fetchParsed(newsUrl(c), 9000).catch(() => null);
        return { code: c, news };
      });
      return send(res, 200, { items: items.map((z, i) => z?.error ? { code: codes[i], error: z.error } : z) }, 120);
    }

    if (!/^\d{6}$/.test(code)) return send(res, 400, { error: 'invalid stock code' }, 0);

    if (action === 'kline') return send(res, 200, await fetchParsed(klineUrl(code), 9000), 300);
    if (action === 'flow') return send(res, 200, await fetchParsed(flowUrl(code), 9000), 120);
    if (action === 'quote') return send(res, 200, await fetchParsed(quoteUrl(code), 7000), 8);
    if (action === 'news') return send(res, 200, await fetchParsed(newsUrl(code), 9000), 180);

    return send(res, 400, { error: 'unknown action' }, 0);
  } catch (e) {
    return send(res, 502, { error: e?.message || String(e), action }, 0);
  }
}
