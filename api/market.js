export const config = { maxDuration: 30 };

const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://7.push2.eastmoney.com',
  'https://43.push2.eastmoney.com',
  'https://89.push2.eastmoney.com'
];

const UA = 'Mozilla/5.0 AShareQuant/10.0.4';

function secid(code) {
  return /^(6|68)/.test(code) ? `1.${code}` : `0.${code}`;
}

function parseMaybeJsonp(text) {
  const t = String(text || '').trim();

  if (!t) {
    throw new Error('empty upstream response');
  }

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

async function fetchParsed(url, timeout = 8500) {
  const ctrl = new AbortController();

  const timer = setTimeout(
    () => ctrl.abort(),
    timeout
  );

  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept':
          'application/json,text/javascript,*/*;q=0.8',
        'referer':
          'https://quote.eastmoney.com/'
      }
    });

    if (!r.ok) {
      throw new Error(
        `upstream HTTP ${r.status}`
      );
    }

    return parseMaybeJsonp(
      await r.text()
    );
  } finally {
    clearTimeout(timer);
  }
}

function marketUrl(host, page, pz) {
  const p = new URLSearchParams({
    pn: String(page),
    pz: String(pz),
    po: '1',
    np: '1',
    fltt: '2',
    invt: '2',
    fid: 'f6',
    fs:
      'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
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
    fields1:
      'f1,f2,f3,f4,f5,f6',
    fields2:
      'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
  });

  return (
    'https://push2his.eastmoney.com/' +
    `api/qt/stock/kline/get?${p}`
  );
}

function flowUrl(code) {
  const p = new URLSearchParams({
    lmt: '30',
    klt: '101',
    secid: secid(code),
    fields1:
      'f1,f2,f3,f7',
    fields2:
      'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63'
  });

  return (
    'https://push2his.eastmoney.com/' +
    `api/qt/stock/fflow/daykline/get?${p}`
  );
}

function quoteUrl(code) {
  const p = new URLSearchParams({
    secid: secid(code),
    fields:
      'f43,f57,f58,f169,f170,f46,f44,f45,f47,f48,f60,f62,f184,f168,f100',
    fltt: '2',
    invt: '2'
  });

  return (
    'https://push2.eastmoney.com/' +
    `api/qt/stock/get?${p}`
  );
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
    'https://search-api-web.eastmoney.com/' +
    'search/jsonp?param=' +
    encodeURIComponent(
      JSON.stringify(body)
    ) +
    '&cb=quantcb'
  );
}

function send(
  res,
  status,
  data,
  maxAge = 20
) {
  res.setHeader(
    'content-type',
    'application/json; charset=utf-8'
  );

  res.setHeader(
    'cache-control',
    `public, s-maxage=${maxAge}, stale-while-revalidate=${Math.max(
      30,
      maxAge * 3
    )}`
  );

  res
    .status(status)
    .send(JSON.stringify(data));
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

async function fetchMarketPage(
  page,
  pz = 100
) {
  let last;

  for (const host of EM_HOSTS) {
    try {
      const j = await fetchParsed(
        marketUrl(
          host,
          page,
          pz
        ),
        6500
      );

      if (j?.data) {
        return j;
      }
    } catch (e) {
      last = e;
    }
  }

  throw (
    last ||
    new Error(
      'market upstream unavailable'
    )
  );
}

async function fetchMarketPageRetry(
  page,
  pz = 100,
  retries = 2
) {
  let last;

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      return await fetchMarketPage(
        page,
        pz
      );
    } catch (e) {
      last = e;

      if (attempt < retries) {
        await sleep(
          180 * (attempt + 1)
        );
      }
    }
  }

  throw (
    last ||
    new Error(
      `market page ${page} unavailable`
    )
  );
}

async function mapLimit(
  items,
  n,
  fn
) {
  const out =
    new Array(items.length);

  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;

      if (i >= items.length) {
        return;
      }

      try {
        out[i] =
          await fn(
            items[i],
            i
          );
      } catch (e) {
        out[i] = {
          error:
            e?.message ||
            String(e)
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.max(
          1,
          n
        )
      },
      worker
    )
  );

  return out;
}

function parseCodes(raw, max) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(
      s => /^\d{6}$/.test(s)
    )
    .slice(0, max);
}

export default async function handler(
  req,
  res
) {
  const u = new URL(
    req.url,
    'http://localhost'
  );

  const action =
    u.searchParams.get('action') ||
    '';

  const code =
    u.searchParams.get('code') ||
    '';

  try {
    if (action === 'market') {
      const page = Math.max(
        1,
        Math.min(
          100,
          Number(
            u.searchParams.get('page')
          ) || 1
        )
      );

      const pz = Math.max(
        20,
        Math.min(
          100,
          Number(
            u.searchParams.get('pz')
          ) || 100
        )
      );

      return send(
        res,
        200,
        await fetchMarketPage(
          page,
          pz
        ),
        10
      );
    }

    if (
      action === 'market_chunk'
    ) {
      const pz = 100;

      const start = Math.max(
        1,
        Math.min(
          100,
          Number(
            u.searchParams.get(
              'start'
            )
          ) || 1
        )
      );

      const count = Math.max(
        1,
        Math.min(
          10,
          Number(
            u.searchParams.get(
              'count'
            )
          ) || 10
        )
      );

      const pageNums =
        Array.from(
          { length: count },
          (_, i) => start + i
        ).filter(
          p => p <= 100
        );

      const fetched =
        await mapLimit(
          pageNums,
          3,
          async p => {
            const j =
              await fetchMarketPageRetry(
                p,
                pz,
                2
              );

            return {
              page: p,
              total:
                +j?.data?.total ||
                0,
              rows:
                j?.data?.diff ||
                []
            };
          }
        );

      const rows = [];
      const failedPages = [];
      let total = 0;

      for (
        let i = 0;
        i < fetched.length;
        i++
      ) {
        const z =
          fetched[i];

        if (z?.error) {
          failedPages.push(
            pageNums[i]
          );
        } else {
          total =
            total ||
            +z?.total ||
            0;

          rows.push(
            ...(z?.rows || [])
          );
        }
      }

      return send(
        res,
        200,
        {
          data: {
            total,
            start,
            count,
            diff: rows,
            failedPages
          }
        },
        15
      );
    }

    if (
      action === 'market_pages'
    ) {
      const pz = 100;

      const pages = String(
        u.searchParams.get(
          'pages'
        ) || ''
      )
        .split(',')
        .map(x => Number(x))
        .filter(
          x =>
            Number.isInteger(x) &&
            x >= 1 &&
            x <= 100
        )
        .slice(0, 12);

      if (!pages.length) {
        return send(
          res,
          400,
          {
            error:
              'no valid pages'
          },
          0
        );
      }

      const fetched =
        await mapLimit(
          pages,
          3,
          async p => {
            const j =
              await fetchMarketPageRetry(
                p,
                pz,
                3
              );

            return {
              page: p,
              total:
                +j?.data?.total ||
                0,
              rows:
                j?.data?.diff ||
                []
            };
          }
        );

      const rows = [];
      const failedPages = [];
      let total = 0;

      for (
        let i = 0;
        i < fetched.length;
        i++
      ) {
        const z =
          fetched[i];

        if (z?.error) {
          failedPages.push(
            pages[i]
          );
        } else {
          total =
            total ||
            +z?.total ||
            0;

          rows.push(
            ...(z?.rows || [])
          );
        }
      }

      return send(
        res,
        200,
        {
          data: {
            total,
            diff: rows,
            failedPages
          }
        },
        10
      );
    }

    if (
      action === 'market_all'
    ) {
      return send(
        res,
        410,
        {
          error:
            'market_all retired; use market_chunk'
        },
        0
      );
    }

    if (
      action === 'deep_batch'
    ) {
      const codes =
        parseCodes(
          u.searchParams.get(
            'codes'
          ),
          30
        );

      if (!codes.length) {
        return send(
          res,
          400,
          {
            error:
              'no valid codes'
          },
          0
        );
      }

      const items =
        await mapLimit(
          codes,
          5,
          async c => {
            const [
              kline,
              flow
            ] =
              await Promise.all([
                fetchParsed(
                  klineUrl(c),
                  9000
                ),
                fetchParsed(
                  flowUrl(c),
                  9000
                ).catch(
                  () => null
                )
              ]);

            return {
              code: c,
              kline,
              flow
            };
          }
        );

      return send(
        res,
        200,
        {
          items:
            items.map(
              (z, i) =>
                z?.error
                  ? {
                      code:
                        codes[i],
                      error:
                        z.error
                    }
                  : z
            )
        },
        60
      );
    }

    if (
      action === 'news_batch'
    ) {
      const codes =
        parseCodes(
          u.searchParams.get(
            'codes'
          ),
          8
        );

      if (!codes.length) {
        return send(
          res,
          400,
          {
            error:
              'no valid codes'
          },
          0
        );
      }

      const items =
        await mapLimit(
          codes,
          4,
          async c => {
            const news =
              await fetchParsed(
                newsUrl(c),
                9000
              ).catch(
                () => null
              );

            return {
              code: c,
              news
            };
          }
        );

      return send(
        res,
        200,
        {
          items:
            items.map(
              (z, i) =>
                z?.error
                  ? {
                      code:
                        codes[i],
                      error:
                        z.error
                    }
                  : z
            )
        },
        120
      );
    }

    if (
      !/^\d{6}$/.test(code)
    ) {
      return send(
        res,
        400,
        {
          error:
            'invalid stock code'
        },
        0
      );
    }

    if (action === 'kline') {
      return send(
        res,
        200,
        await fetchParsed(
          klineUrl(code),
          9000
        ),
        300
      );
    }

    if (action === 'flow') {
      return send(
        res,
        200,
        await fetchParsed(
          flowUrl(code),
          9000
        ),
        120
      );
    }

    if (action === 'quote') {
      return send(
        res,
        200,
        await fetchParsed(
          quoteUrl(code),
          7000
        ),
        8
      );
    }

    if (action === 'news') {
      return send(
        res,
        200,
        await fetchParsed(
          newsUrl(code),
          9000
        ),
        180
      );
    }

    return send(
      res,
      400,
      {
        error:
          'unknown action'
      },
      0
    );
  } catch (e) {
    return send(
      res,
      502,
      {
        error:
          e?.message ||
          String(e),
        action
      },
      0
    );
  }
}
