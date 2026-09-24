// Independent V10.3.7 provider diagnostic. Never supplies stock picks or BUY signals.
export const config = { maxDuration: 30 };
const FIELDS = 'f12,f14,f2,f3,f6,f8,f100,f124';
const TARGETS = [
  { segment: 'SZ_MAIN', fs: 'm:0+t:6' },
  { segment: 'SH_MAIN', fs: 'm:1+t:2' }
];
const HOSTS = [
  { name: 'primary', url: 'https://push2.eastmoney.com' },
  { name: 'mirror', url: 'https://7.push2.eastmoney.com' }
];
const CASES = TARGETS.flatMap(t => [
  ...[20, 100, 200].map(pz => ({...t, host: HOSTS[0], pn: 1, pz})),
  {...t, host: HOSTS[0], pn: 2, pz: 100},
  {...t, host: HOSTS[1], pn: 1, pz: 20}
]);

export function createProbeHandler({fetchImpl = fetch, clock = () => Date.now(), timeoutMs = 4500} = {}) {
  async function inspect(c) {
    const started = clock();
    const summary = {host: c.host.name, segment: c.segment, page: c.pn, requestedPageSize: c.pz};
    const u = new URL('/api/qt/clist/get', c.host.url);
    u.search = new URLSearchParams({pn: String(c.pn), pz: String(c.pz), po: '1', np: '1',
      ut: 'bd1d9ddb04089700cf9c27f6f7426281', fltt: '2', invt: '2', fid: 'f3', fs: c.fs, fields: FIELDS}).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl(u.toString(), {signal: ctrl.signal, cache: 'no-store', headers: {accept: 'application/json'}});
      const body = await response.text();
      let j;
      try {j = JSON.parse(body);} catch {
        return {...summary, elapsedMs: clock() - started, ok: false, httpStatus: response.status, error: 'not-json',
          contentType: response.headers?.get?.('content-type') ?? null, prefix: body.slice(0, 90)};
      }
      const diff = j?.data?.diff;
      const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : null;
      const total = Number(j?.data?.total);
      const expected = Number.isInteger(total) && total >= 0 ? Math.max(0, Math.min(c.pz, total - (c.pn - 1) * c.pz)) : null;
      const codes = (rows ?? []).map(x => String(x?.f12 ?? ''));
      return {...summary, elapsedMs: clock() - started, ok: response.ok && rows !== null && expected !== null,
        httpStatus: response.status, providerRc: j?.rc ?? null, providerMessage: j?.message ?? null,
        providerTotal: j?.data?.total ?? null, returned: rows?.length ?? null, expected,
        countMatches: rows !== null && expected !== null && rows.length === expected,
        firstCode: codes[0] ?? null, lastCode: codes.at(-1) ?? null,
        missingQuoteTime: rows?.filter(x => !Number.isFinite(Number(x?.f124))).length ?? null,
        error: !response.ok ? 'upstream-http' : rows === null ? 'missing-diff' : expected === null ? 'invalid-total' : null};
    } catch (e) {
      return {...summary, elapsedMs: clock() - started, ok: false, error: ctrl.signal.aborted ? 'upstream-timeout' : (e?.name ?? 'fetch-error'),
        detail: String(e?.message ?? e).slice(0, 110)};
    } finally {
      clearTimeout(timer);
    }
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({error: 'METHOD_NOT_ALLOWED'});
    let next = 0;
    const results = new Array(CASES.length);
    await Promise.all(Array.from({length: 2}, async () => {
      while (next < CASES.length) {const i = next++; results[i] = await inspect(CASES[i]);}
    }));
    return res.status(200).json({schema: 'ashare-discovery-provider-probe-v1',
      capturedAt: new Date(clock()).toISOString(), neverTradeSignal: true,
      diagnosticOnly: true, notFullMarketScan: true, requestTimeoutMs: timeoutMs,
      cases: results, okCount: results.filter(x => x.ok).length,
      shortPageCount: results.filter(x => x.ok && !x.countMatches).length,
      timeoutCount: results.filter(x => x.error === 'upstream-timeout').length});
  };
}
export default createProbeHandler();
