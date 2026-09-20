export const config = { maxDuration: 30 };

const HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];

const UA = 'Mozilla/5.0 AShareQuant/10.0.1';

function secid(code) {
  return /^(6|68)/.test(code) ? `1.${code}` : `0.${code}`;
}

function parseData(text) {
  const t = String(text || '').trim();

  try {
    return JSON.parse(t);
  } catch {}

  const a = t.indexOf('(');
  const b = t.lastIndexOf(')');

  if (a >= 0 && b > a) {
    return JSON.parse(t.slice(a + 1, b));
  }

  throw new Error('invalid upstream response');
}

async function request(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json,text/javascript,*/*',
        referer: 'https://quote.eastmoney.com/'
      }
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    return parseData(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

function marketUrl(host, page, size) {
  const p = new URLSearchParams({
    pn: String(page),
    pz: String(size),
    po: '1',
    np: '1',
    fltt: '2',
    invt: '2',
    fid: 'f6',
    fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
    fields:
      'f12,f14,f2,f3,f5,f6,f8,f9,f10,f20,f21,f23,f24,f25,f62,f184,f100'
  });

  return `${host}/api/qt/clist/get?${p}`;
}

function klineUrl(code) {
  const p = new URLSearchParams({
    secid: secid(code),
    klt: '101',
    fqt: '1',
    beg: '0',
    end: '20500101',
    lmt: '120',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });

  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${p}`;
}

function flowUrl(code) {
  const p = new URLSearchParams({
    lmt: '30',
    klt: '101',
    secid: secid(code),
    fields1: 'f1,f2,f3,f7',
    fields2:
      'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
  });

  return `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${p}`;
}

function quoteUrl(code) {
  const p = new URLSearchParams({
    secid: secid(code),
    fltt: '2',
    invt: '2',
    fields:
      'f43,f57,f58,f169,f170,f46,f44,f45,f47,f48,f60,f62,f184,f168,f100'
  });

  return `https://push2.eastmoney.com/api/qt/stock/get?${p}`;
}

function newsUrl(code) {
  const body = {
    uid: '',
    keyword: code,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize: 12,
        preTag: '',
        postTag: ''
      }
    }
  };

  return (
    'https://search-api-web.eastmoney.com/search/jsonp?param=' +
    encodeURIComponent(JSON.stringify(body)) +
    '&cb=quantcb'
  );
}

function send(res, status, data, cache = 20) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader(
    'cache-control',
    `public, s-maxage=${cache}, stale-while-revalidate=60`
  );
  res.status(status).send(JSON.stringify(data));
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || '';
  const code = url.searchParams.get('code') || '';

  try {
    if (action === 'market') {
      const page = Math.max(
        1,
        Math.min(30, Number(url.searchParams.get('page')) || 1)
      );

      const size = Math.max(
        20,
        Math.min(500, Number(url.searchParams.get('pz')) || 500)
      );

      let lastError = null;

      for (const host of HOSTS) {
        try {
          const data = await request(
            marketUrl(host, page, size),
            7000
          );

          if (data?.data) {
            return send(res, 200, data, 10);
          }
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError || new Error('market unavailable');
    }

    if (!/^\d{6}$/.test(code)) {
      return send(res, 400, { error: 'invalid stock code' }, 0);
    }

    if (action === 'kline') {
      return send(
        res,
        200,
        await request(klineUrl(code)),
        300
      );
    }

    if (action === 'flow') {
      return send(
        res,
        200,
        await request(flowUrl(code)),
        120
      );
    }

    if (action === 'quote') {
      return send(
        res,
        200,
        await request(quoteUrl(code), 7000),
        8
      );
    }

    if (action === 'news') {
      return send(
        res,
        200,
        await request(newsUrl(code)),
        180
      );
    }

    return send(res, 400, { error: 'unknown action' }, 0);
  } catch (e) {
    return send(
      res,
      502,
      {
        error: e?.message || String(e),
        action
      },
      0
    );
  }
}
