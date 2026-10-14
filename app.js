'use strict';

/* ================= Storage (IndexedDB) ================= */

let dbPromise;
function openDb() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tripbudget', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images'); // key: file id, value: { type, buf }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings'); // key: setting name
    };
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const browserStore = {
  trips: () => tx('trips', 'readonly', s => s.getAll()),
  putTrip: trip => tx('trips', 'readwrite', s => s.put(trip)),
  delTrip: id => tx('trips', 'readwrite', s => s.delete(id)),
  img: id => tx('images', 'readonly', s => s.get(id)),
  putImg: (id, val) => tx('images', 'readwrite', s => s.put(val, id)),
  delImg: id => tx('images', 'readwrite', s => s.delete(id)),
  imgKeys: () => tx('images', 'readonly', s => s.getAllKeys()),
  setting: key => tx('settings', 'readonly', s => s.get(key)),
  putSetting: (key, val) => tx('settings', 'readwrite', s => s.put(val, key)),
};

// Mac version (`uv run mac_app.py` sets TB_DESKTOP): same interface, but everything is saved
// as files under data/ by the local server instead of in the browser.
const DESKTOP = !!window.TB_DESKTOP;
async function api(method, path, body, type) {
  const res = await fetch('api/' + path, {
    method, body,
    headers: body == null ? {} : { 'Content-Type': type || 'application/json' },
    keepalive: typeof body === 'string' && body.length < 60000, // lets the last save finish if the tab closes
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} failed (${res.status})`);
  return res;
}
const fileStore = {
  trips: async () => (await api('GET', 'trips')).json(),
  putTrip: trip => api('PUT', 'trips/' + trip.id, JSON.stringify(trip)),
  delTrip: id => api('DELETE', 'trips/' + id),
  img: async id => {
    const r = await api('GET', 'files/' + id);
    return r.ok ? { type: r.headers.get('Content-Type'), buf: await r.arrayBuffer() } : undefined;
  },
  putImg: (id, val) => api('PUT', 'files/' + id, val.buf, val.type),
  delImg: id => api('DELETE', 'files/' + id),
  imgKeys: async () => (await api('GET', 'files')).json(),
  setting: async key => { const r = await api('GET', 'settings/' + key); return r.ok ? r.json() : undefined; },
  putSetting: (key, val) => api('PUT', 'settings/' + key, JSON.stringify(val)),
};
const idb = DESKTOP ? fileStore : browserStore;

let trips = [];
const saveTimers = {};
// Every edit stamps `updated`; syncing keeps whichever copy of a trip was edited last.
function save(trip, delay = 400) {
  trip.updated = Date.now();
  clearTimeout(saveTimers[trip.id]);
  saveTimers[trip.id] = setTimeout(() => { delete saveTimers[trip.id]; idb.putTrip(trip); }, delay);
}
function saveNow(trip) {
  trip.updated = Date.now();
  clearTimeout(saveTimers[trip.id]);
  delete saveTimers[trip.id];
  return idb.putTrip(trip);
}
// Flush pending saves when the app is backgrounded/closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  for (const id in saveTimers) {
    clearTimeout(saveTimers[id]);
    delete saveTimers[id];
    const t = trips.find(x => x.id === id);
    if (t) idb.putTrip(t);
  }
});

/* ================= Helpers ================= */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };

const toDate = iso => new Date(iso + 'T00:00:00Z');
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const dateRange = (a, b) => { const out = []; for (let d = a; d <= b && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fmtDate = (iso, opts) => toDate(iso).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
const dayLabel = iso => fmtDate(iso, { weekday: 'short', month: 'numeric', day: 'numeric' });
const longDate = iso => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const rangeLabel = (a, b) => `${fmtDate(a, { month: 'short', day: 'numeric' })} – ${fmtDate(b, { month: 'short', day: 'numeric', year: 'numeric' })}`;

const fmtCache = {};
function money(v, cur = 'USD', cents = true) {
  const key = cur + cents;
  fmtCache[key] ??= new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: cents ? undefined : 0, maximumFractionDigits: cents ? undefined : 0 });
  return fmtCache[key].format(v);
}
// Compact amount for narrow grid cells: $84, $1.2k, $12k
function short(v, cur) {
  if (!v) return '–';
  if (Math.abs(v) < 1000) return money(v, cur, false);
  const k = v / 1000;
  return money(Math.abs(k) >= 10 ? Math.round(k) : Math.round(k * 10) / 10, cur, Math.abs(k) < 10).replace(/\.00$|(\.\d)0$/, '$1') + 'k';
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'MXN', 'JPY', 'AUD', 'NZD', 'CHF', 'CNY', 'KRW', 'THB', 'VND', 'INR', 'BRL', 'COP', 'PEN', 'CRC', 'ISK', 'NOK', 'SEK', 'DKK', 'CZK', 'HUF', 'PLN', 'TRY', 'ZAR', 'SGD', 'HKD', 'TWD', 'PHP', 'IDR', 'MYR', 'AED', 'MAD', 'EGP'];

/* ================= Currencies ================= */

let curNamer = null;
try { curNamer = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { /* older iOS: codes only */ }
const curName = c => { try { return curNamer?.of(c) || c; } catch { return c; } };
// Every current ISO currency the phone knows a name for (skips retired ones like "… (1990–2002)" and metals/test codes).
const ALL_CURRENCIES = (() => {
  let codes = [];
  try { codes = Intl.supportedValuesOf('currency'); } catch { /* not supported */ }
  if (!codes.length) return CURRENCIES;
  return codes.filter(c => (!c.startsWith('X') || ['XAF', 'XOF', 'XPF', 'XCD'].includes(c))
    && (CURRENCIES.includes(c) || (curName(c) !== c && !/\(\d{4}/.test(curName(c)))));
})();

// The user's chosen currencies (Home screen). Dropdowns only offer these, and only their rates are kept.
let myCurrencies = ['USD'];
async function loadMyCurrencies() {
  const saved = await idb.setting('currencies');
  if (saved?.length) { myCurrencies = saved; return; }
  // First run: start with USD plus anything already used in trips.
  const used = trips.flatMap(t => [t.currency, ...[...t.flights, ...t.hotels].map(b => b.fx?.cur),
    ...Object.values(t.days).flatMap(d => LIST_CATS.flatMap(c => (d[c.key] || []).map(i => i.fx?.cur)))]);
  myCurrencies = [...new Set(['USD', ...used.filter(Boolean)])];
}
function saveMyCurrencies() { return idb.putSetting('currencies', myCurrencies); }
// Chosen currencies plus any still referenced by trips, so conversions never lose a rate they need.
function neededCurrencies() {
  return new Set(['USD', ...myCurrencies, ...trips.flatMap(t => [t.currency,
    ...[...t.flights, ...t.hotels].map(b => b.fx?.cur),
    ...Object.values(t.days).flatMap(d => LIST_CATS.flatMap(c => (d[c.key] || []).map(i => i.fx?.cur)))])].filter(Boolean));
}

/* ================= Exchange rates ================= */

// Daily rates (per 1 USD) from open.er-api.com, with a jsDelivr-hosted mirror as backup.
// Cached on the phone so conversions still work offline.
const RATES_KEY = 'fx-rates-v1';
let rates = (() => { try { return JSON.parse(localStorage.getItem(RATES_KEY)); } catch { return null; } })();
const RATE_SOURCES = [
  async signal => {
    const d = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal })).json();
    if (d.result !== 'success') throw new Error('bad response');
    return { rates: d.rates, date: new Date(d.time_last_update_unix * 1000).toISOString().slice(0, 10), source: 'open.er-api.com' };
  },
  async signal => {
    const d = await (await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { signal })).json();
    return { rates: Object.fromEntries(Object.entries(d.usd).map(([k, v]) => [k.toUpperCase(), v])), date: d.date, source: 'currency-api (jsDelivr)' };
  },
];
// The free services only offer one combined download; we keep just the currencies you use.
async function refreshRates(force = false) {
  const need = neededCurrencies();
  const missing = [...need].some(c => !rates?.rates?.[c]);
  if (!force && !missing && rates && Date.now() - rates.fetched < 6 * 36e5) return rates;
  for (const src of RATE_SOURCES) {
    try {
      const got = await src(AbortSignal.timeout?.(6000));
      got.rates = Object.fromEntries(Object.entries(got.rates).filter(([c]) => need.has(c)));
      rates = { ...got, fetched: Date.now() };
      try { localStorage.setItem(RATES_KEY, JSON.stringify(rates)); } catch { /* storage unavailable */ }
      return rates;
    } catch { /* try the next source */ }
  }
  return rates;
}
// How many `to` one `from` buys, from cached rates; null if unknown.
function fxRate(from, to) {
  if (from === to) return 1;
  const a = rates?.rates?.[from], b = rates?.rates?.[to];
  return a && b ? b / a : null;
}
// Like fxRate, but tries the network and finally asks the user.
async function rateFor(from, to) {
  if (from === to) return 1;
  if (!fxRate(from, to)) await refreshRates(true);
  const r = fxRate(from, to);
  if (r) return r;
  const typed = num(prompt(`Couldn't get an exchange rate (offline?).\nHow many ${to} is 1 ${from}?`) ?? '');
  return typed > 0 ? typed : null;
}
const fmtRate = r => r >= 100 ? r.toFixed(2) : String(Number(r.toPrecision(4)));
const round2 = n => Math.round(n * 100) / 100;

// `amount`/`price` is always in the trip currency. Foreign entries also keep the original
// amount, currency and the rate used at entry time in `fx`, so totals never drift.
function setMoney(o, key, amt, cur, tripCur, rate) {
  if (cur === tripCur) { o[key] = amt; delete o.fx; }
  else { o.fx = { amt, cur, rate }; o[key] = round2(amt * rate); }
}
function curOptions(trip, selected) {
  const mine = new Set(myCurrencies);
  const list = [...new Set([trip.currency, ...(trip.recentCurs || []).filter(c => mine.has(c)), ...myCurrencies, selected])];
  return list.map(c => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}
function rememberCur(trip, c) {
  trip.lastCur = c;
  if (c !== trip.currency) trip.recentCurs = [c, ...(trip.recentCurs || []).filter(x => x !== c)].slice(0, 4);
}

// Re-express every amount in a new trip currency, keeping originals in `fx`. Returns false if a rate is missing.
async function changeTripCurrency(trip, to) {
  const from = trip.currency;
  const entries = [
    ...[...trip.flights, ...trip.hotels].map(b => [b, 'price']),
    ...Object.values(trip.days).flatMap(d => LIST_CATS.flatMap(c => (d[c.key] || []).map(i => [i, 'amount']))),
  ];
  const need = new Set([from, ...entries.map(([o]) => o.fx?.cur).filter(Boolean)]);
  const r = {};
  for (const c of need) if (!(r[c] = await rateFor(c, to))) return false;
  for (const [o, k] of entries) {
    const cur = o.fx ? o.fx.cur : from;
    setMoney(o, k, o.fx ? o.fx.amt : o[k] || 0, cur, to, r[cur]);
  }
  if (trip.budget) trip.budget = Math.round(trip.budget * r[from]);
  trip.currency = to;
  if (trip.lastCur === to) trip.lastCur = null;
  return true;
}

const CATS = [
  { key: 'flights', label: 'Flights', head: 'Flight' },
  { key: 'hotel', label: 'Hotel', head: 'Hotel' },
  { key: 'food', label: 'Food', head: 'Food', list: true },
  { key: 'ent', label: 'Entertainment', head: 'Fun', list: true },
  { key: 'misc', label: 'Misc', head: 'Misc', list: true },
];
const LIST_CATS = CATS.filter(c => c.list);

/* ================= Model ================= */

function newTrip() {
  const start = today();
  return { id: uid(), name: '', start, end: addDays(start, 6), currency: 'USD', budget: null, days: {}, flights: [], hotels: [] };
}
// Older versions stored one screenshot per booking as `receipt`; it's now a `files` list.
function migrate(trip) {
  for (const b of [...trip.flights, ...trip.hotels]) {
    b.files ??= b.receipt ? [{ id: b.receipt, name: 'Receipt.jpg', type: 'image/jpeg' }] : [];
    delete b.receipt;
  }
  return trip;
}
function getDay(trip, date) {
  return trip.days[date] ??= { city: '', notes: '', food: [], ent: [], misc: [] };
}
const sum = arr => arr.reduce((a, b) => a + (b || 0), 0);
const nights = h => Math.max(1, daysBetween(h.checkIn, h.checkOut));

function hotelsOn(trip, date) {
  return trip.hotels.filter(h => h.checkIn && h.checkOut && date >= h.checkIn && date < h.checkOut);
}
function flightsOn(trip, date) {
  return trip.flights.filter(f => f.date === date);
}

// Per-day totals for every category. Hotel cost is spread evenly across its nights.
function computeRows(trip) {
  return dateRange(trip.start, trip.end).map((date, i, all) => {
    const day = trip.days[date] || {};
    const fl = flightsOn(trip, date);
    const ho = hotelsOn(trip, date);
    const row = {
      date, city: day.city || '',
      flights: sum(fl.map(f => f.price)),
      hotel: sum(ho.map(h => (h.price || 0) / nights(h))),
      flightTodo: fl.some(f => !f.booked), flightOk: fl.length > 0 && fl.every(f => f.booked),
      hotelTodo: ho.some(h => !h.booked), hotelOk: ho.length > 0 && ho.every(h => h.booked),
      noHotel: ho.length === 0 && i < all.length - 1,
    };
    for (const c of LIST_CATS) row[c.key] = sum((day[c.key] || []).map(it => it.amount));
    row.total = sum(CATS.map(c => row[c.key]));
    return row;
  });
}
function tripTotals(trip) {
  const t = {
    flights: sum(trip.flights.map(f => f.price)),
    hotel: sum(trip.hotels.map(h => h.price)),
  };
  for (const c of LIST_CATS) t[c.key] = sum(Object.values(trip.days).flatMap(d => (d[c.key] || []).map(i => i.amount)));
  t.total = sum(CATS.map(c => t[c.key]));
  return t;
}

// Green (cheap) → red (priciest) relative to the other days in the same column.
function heat(v, max) {
  if (!v || !max) return '';
  const r = Math.min(1, v / max);
  const hue = Math.round(140 - 140 * r);
  return `background:hsl(${hue} 75% var(--heat-l) / calc(var(--heat-a0) + (var(--heat-a1) - var(--heat-a0)) * ${r.toFixed(2)}))`;
}

/* ================= Files ================= */

// Downscale + JPEG-compress photos so receipts stay ~100–250 KB.
async function compressImage(file, maxDim = 1500, quality = 0.62) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    return { type: 'image/jpeg', buf: await blob.arrayBuffer() };
  } finally {
    URL.revokeObjectURL(url);
  }
}
// Photos are compressed; anything else (PDFs, etc.) is stored as-is. Returns the file's metadata.
async function storeFile(file) {
  let rec = null;
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    try { rec = await compressImage(file); } catch { /* undecodable image: keep the original */ }
  }
  rec ??= { type: file.type || 'application/octet-stream', buf: await file.arrayBuffer() };
  const id = uid();
  await idb.putImg(id, rec);
  let name = file.name || 'File';
  if (rec.type === 'image/jpeg' && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg';
  return { id, name, type: rec.type, size: rec.buf.byteLength };
}
const fmtSize = n => n == null ? '' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const imgUrls = {};
async function fileUrl(id) {
  if (!id) return null;
  if (imgUrls[id]) return imgUrls[id];
  const rec = await idb.img(id);
  if (!rec) return null;
  return imgUrls[id] = URL.createObjectURL(new Blob([rec.buf], { type: rec.type }));
}
// Remove stored files no longer referenced by any trip (e.g. removed or cancelled drafts).
async function cleanupImages() {
  const used = new Set(trips.flatMap(t => [...t.flights, ...t.hotels].flatMap(b => (b.files || []).map(f => f.id))));
  for (const k of await idb.imgKeys()) if (!used.has(k)) await idb.delImg(k);
}

/* ================= Backup ================= */

const toB64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

async function exportBackup() {
  const images = {};
  for (const k of await idb.imgKeys()) { const r = await idb.img(k); images[k] = { type: r.type, data: toB64(r.buf) }; }
  const json = JSON.stringify({ app: 'tripbudget', v: 1, exported: new Date().toISOString(), trips, images, currencies: myCurrencies });
  let blob = new Blob([json], { type: 'application/json' });
  let ext = 'json';
  if ('CompressionStream' in window) {
    blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    ext = 'json.gz';
  }
  const name = `trip-budget-${today()}.${ext}`;
  const file = new File([blob], name, { type: ext === 'json' ? 'application/json' : 'application/gzip' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const gunzip = buf => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

async function importBackup(file) {
  let buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) buf = await gunzip(buf);
  const data = JSON.parse(new TextDecoder().decode(buf));
  const n = data.trips?.length ?? 0;
  if (!confirm(`Import ${n} trip${n === 1 ? '' : 's'}? Where a trip is on both, the more recently edited copy is kept.`)) return;
  const { added, replaced, kept } = await importData(data);
  alert(importSummary(added, replaced, kept));
}

// Merge a backup/sync bundle: for trips on both sides, keep whichever was edited last.
async function importData(data) {
  if (data.app !== 'tripbudget' || !Array.isArray(data.trips)) throw new Error('Not a Trip Budget backup');
  let added = 0, replaced = 0, kept = 0;
  const take = [];
  for (const t of data.trips.map(migrate)) {
    const mine = trips.find(x => x.id === t.id);
    if (!mine) added++;
    else if ((t.updated || 0) >= (mine.updated || 0)) replaced++;
    else { kept++; continue; }
    take.push(t);
  }
  const needed = new Set(take.flatMap(t => [...t.flights, ...t.hotels].flatMap(b => (b.files || []).map(f => f.id))));
  for (const [k, v] of Object.entries(data.images || {})) if (needed.has(k)) await idb.putImg(k, { type: v.type, buf: fromB64(v.data) });
  for (const t of take) await idb.putTrip(t);
  if (data.currencies?.length) { myCurrencies = [...new Set([...myCurrencies, ...data.currencies])]; await saveMyCurrencies(); }
  trips = (await idb.trips()).map(migrate);
  await cleanupImages();
  render();
  return { added, replaced, kept };
}
const importSummary = (added, replaced, kept) => [
  added && `${added} new trip${added === 1 ? '' : 's'} added`,
  replaced && `${replaced} trip${replaced === 1 ? '' : 's'} updated`,
  kept && `${kept} trip${kept === 1 ? '' : 's'} kept as-is (edited more recently here)`,
].filter(Boolean).join(' · ') || 'Nothing to import.';

/* ================= Phone ⇄ Mac sync ================= */

// The Mac app pushes sync/trip-budget.sync: "TBS1" | salt(16) | iv(12) | AES-256-GCM(gzip(json)),
// keyed from your passphrase with PBKDF2-SHA256. It's in a public repo, so it is always encrypted.
const SYNC_URL = 'sync/trip-budget.sync';
const SYNC_ITERATIONS = 310000; // must match PBKDF2_ITERATIONS in mac_app.py

async function decryptSync(buf, passphrase) {
  const b = new Uint8Array(buf);
  if (new TextDecoder().decode(b.slice(0, 4)) !== 'TBS1') throw new Error('That isn’t a Trip Budget sync file.');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b.slice(4, 20), iterations: SYNC_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(20, 32) }, key, b.slice(32));
  return JSON.parse(new TextDecoder().decode(await gunzip(gz)));
}

async function pullFromMac() {
  const res = await fetch(SYNC_URL, { cache: 'no-store' }).catch(() => null);
  if (!res) throw new Error('Couldn’t reach GitHub. Check your connection and try again.');
  if (res.status === 404) throw new Error('Nothing to sync yet. Press “Save for phone” in the Mac app first.');
  if (!res.ok) throw new Error(`Couldn’t download the sync file (${res.status}).`);
  const buf = await res.arrayBuffer();
  let pass = await idb.setting('syncPass');
  while (true) {
    pass ||= prompt('Sync passphrase (the one you chose in the Mac app):');
    if (!pass) return null;
    try {
      const data = await decryptSync(buf, pass);
      await idb.putSetting('syncPass', pass);
      return importData(data);
    } catch (e) {
      if (e.name !== 'OperationError') throw e;
      alert('That passphrase didn’t work. Try again.');
      pass = null;
    }
  }
}

async function pushFromMac(passphrase) {
  const res = await fetch('api/sync/push', { method: 'POST', body: JSON.stringify({ passphrase }) });
  const out = await res.json();
  if (res.status === 409 && out.need === 'passphrase') {
    const p = prompt('Choose a sync passphrase.\nYou’ll type it once on your phone. Anyone with it could read your synced trips, so make it hard to guess.');
    return p?.trim() ? pushFromMac(p.trim()) : null;
  }
  return out;
}

/* ================= Views ================= */

let app = $('#app');

function bar(title, left = '', right = '') {
  return `<header class="bar"><div class="side">${left}</div><h1>${esc(title)}</h1><div class="side">${right}</div></header>`;
}
const back = (hash, label = '‹ Back') => `<a class="link" href="#${hash}">${label}</a>`;

function viewHome() {
  const sorted = [...trips].sort((a, b) => b.start.localeCompare(a.start));
  app.innerHTML = bar('Trips', '', `<a class="link" href="#new">+ New</a>`) + (sorted.length ? sorted.map(t => {
    const tot = tripTotals(t);
    return `<a class="card trip-card" href="#trip/${t.id}">
      <div class="title">${esc(t.name || 'Untitled trip')}</div>
      <div class="meta"><span>${rangeLabel(t.start, t.end)}</span><span class="num">${money(tot.total, t.currency)}${t.budget ? ` / ${money(t.budget, t.currency, false)}` : ''}</span></div>
    </a>`;
  }).join('') : `<div class="empty">No trips yet.<br><br><a class="btn" href="#new">Add a trip</a></div>`) + `
    <div class="card foot" id="cur-card">
      <h2>My currencies <button class="link" data-act="rates">Refresh rates</button></h2>
      <div class="chips" id="cur-chips"></div>
      <input id="cur-search" class="search" placeholder="Add a currency: search name or code" autocomplete="off" autocapitalize="off">
      <div id="cur-results" class="cur-results"></div>
      <div class="small muted" id="rates-info" style="margin-top:8px"></div>
    </div>
    ${DESKTOP ? `
    <div class="card">
      <h2>Sync to phone <button class="link" data-act="new-pass">Change passphrase</button></h2>
      <p class="small muted" style="margin-top:0">Encrypts everything and pushes it to GitHub. Then tap “Sync from Mac” on your phone.</p>
      <button class="btn block" data-act="push">Save for phone</button>
      <div class="small muted" id="sync-info" style="margin-top:8px"></div>
    </div>` : `
    <div class="card">
      <h2>Sync from Mac</h2>
      <p class="small muted" style="margin-top:0">Loads what you last saved with “Save for phone” in the Mac app. Trips edited more recently on this phone are kept.</p>
      <button class="btn block" data-act="pull">Sync from Mac</button>
      <div class="small muted" id="sync-info" style="margin-top:8px"></div>
    </div>`}
    <div class="card">
      <h2>Backup</h2>
      <p class="small muted" style="margin-top:0">${DESKTOP
        ? 'Your trips and files are saved in the data folder next to mac_app.py. Import a phone backup here to bring phone edits to the Mac.'
        : 'Everything is stored only on this phone. Export a backup to Files or iCloud Drive now and then. Deleting the app from your Home Screen erases its data.'}</p>
      <div class="row-btns">
        <button class="btn secondary" data-act="export">Export backup</button>
        <label class="btn secondary">Import<input type="file" accept=".gz,.json,application/json,application/gzip" hidden data-act="import"></label>
      </div>
      <div class="small muted" id="usage"></div>
    </div>`;
  const showRates = () => {
    $('#rates-info').innerHTML = rates
      ? `Rates updated ${esc(rates.date)} · <a href="https://www.exchangerate-api.com" target="_blank">Rates by Exchange Rate API</a>`
      : 'Rates not downloaded yet. They download automatically when you\'re online.';
  };
  const usdRate = c => { const r = fxRate(c, 'USD'); return c === 'USD' || !r ? '' : `1 ${c} = $${fmtRate(r)}`; };
  const showChips = () => {
    $('#cur-chips').innerHTML = myCurrencies.map(c => `
      <span class="chip"><b>${c}</b><span>${esc(curName(c))}<small class="num">${usdRate(c)}</small></span>
      ${myCurrencies.length > 1 ? `<button data-rm-cur="${c}" aria-label="Remove ${c}">×</button>` : ''}</span>`).join('');
  };
  const showResults = () => {
    const q = $('#cur-search').value.trim().toLowerCase();
    if (!q) { $('#cur-results').innerHTML = ''; return; }
    const hits = ALL_CURRENCIES.filter(c => !myCurrencies.includes(c)
      && (c.toLowerCase().startsWith(q) || curName(c).toLowerCase().includes(q))).slice(0, 8);
    $('#cur-results').innerHTML = hits.length
      ? hits.map(c => `<button data-add-cur="${c}"><b>${c}</b> ${esc(curName(c))}</button>`).join('')
      : '<div class="small muted">No matching currency.</div>';
  };
  showRates(); showChips();
  $('#cur-search').oninput = showResults;
  $('#cur-card').addEventListener('click', async e => {
    const add = e.target.closest('[data-add-cur]')?.dataset.addCur;
    const rm = e.target.closest('[data-rm-cur]')?.dataset.rmCur;
    if (!add && !rm) return;
    myCurrencies = add ? [...myCurrencies, add] : myCurrencies.filter(c => c !== rm);
    await saveMyCurrencies();
    if (add) { $('#cur-search').value = ''; showResults(); }
    showChips();
    if (add) { await refreshRates(); showChips(); showRates(); }
  });
  $('[data-act=rates]').onclick = async e => {
    e.target.textContent = 'Updating…';
    const before = rates?.fetched;
    await refreshRates(true);
    e.target.textContent = 'Refresh';
    if (rates?.fetched === before) alert('Couldn\'t reach the exchange rate service. Using saved rates.');
    showRates();
  };
  if (!DESKTOP) navigator.storage?.estimate?.().then(e => {
    const el = $('#usage'); if (el && e.usage != null) el.textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this device`;
  });
  $('[data-act=export]').onclick = () => exportBackup().catch(e => alert('Export failed: ' + e.message));
  const syncInfo = $('#sync-info');
  const busy = async (btn, label, fn) => {
    const text = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    try { await fn(); } catch (e) { syncInfo.textContent = e.message; } finally { btn.disabled = false; btn.textContent = text; }
  };
  if (DESKTOP) {
    const showStatus = () => api('GET', 'sync/status').then(r => r.json()).then(st => {
      syncInfo.textContent = st.lastSaved ? `Last saved for phone ${new Date(st.lastSaved).toLocaleString()}` : 'Not saved for phone yet.';
    }).catch(() => {});
    showStatus();
    $('[data-act=push]').onclick = e => busy(e.target, 'Encrypting and pushing…', async () => {
      const out = await pushFromMac();
      if (!out) return;
      syncInfo.textContent = out.message;
      if (!out.ok && out.log) console.warn(out.log);
      if (!out.ok) alert(out.message + '\n\n' + (out.log || ''));
    });
    $('[data-act=new-pass]').onclick = e => busy(e.target, 'Saving…', async () => {
      const p = prompt('New sync passphrase. Your phone will ask for it on its next sync.');
      if (!p?.trim()) return;
      const out = await pushFromMac(p.trim());
      if (out) syncInfo.textContent = out.ok ? 'Passphrase changed. ' + out.message : out.message;
    });
  } else {
    $('[data-act=pull]').onclick = e => busy(e.target, 'Syncing…', async () => {
      const r = await pullFromMac();
      if (r) alert(importSummary(r.added, r.replaced, r.kept));
    });
  }
  $('[data-act=import]').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f).catch(err => alert('Import failed: ' + err.message)); };
}

function viewTripForm(trip, isNew) {
  const draft = structuredClone(trip);
  const cancel = isNew ? '' : `trip/${trip.id}`;
  app.innerHTML = bar(isNew ? 'New Trip' : 'Edit Trip', back(cancel, 'Cancel'), `<button class="link" data-act="save"><b>Save</b></button>`) + `
    <div class="card">
      <label class="field"><span>Trip name</span><input name="name" value="${esc(draft.name)}" placeholder="e.g. Japan 2027" autocomplete="off"></label>
      <div class="two">
        <label class="field"><span>First day</span><input type="date" name="start" value="${draft.start}"></label>
        <label class="field"><span>Last day</span><input type="date" name="end" value="${draft.end}"></label>
      </div>
      <div class="two">
        <label class="field"><span>Show totals in</span><select name="currency">${[...new Set([draft.currency, ...myCurrencies])].map(c => `<option value="${c}" ${c === draft.currency ? 'selected' : ''}>${c} – ${esc(curName(c))}</option>`).join('')}</select></label>
        <label class="field"><span>Total budget (optional)</span><input name="budget" inputmode="decimal" value="${draft.budget ?? ''}" placeholder="None"></label>
      </div>
    </div>
    ${isNew ? '' : `<button class="btn danger block" data-act="delete">Delete trip</button>`}`;
  if (isNew) $('[name=name]').focus();
  $('[name=start]').onchange = e => {
    const end = $('[name=end]');
    if (!end.value || end.value < e.target.value) end.value = e.target.value;
  };
  $('[data-act=save]').onclick = async () => {
    const f = n => $(`[name=${n}]`).value;
    if (!f('start') || !f('end')) return alert('Pick the first and last day.');
    if (f('end') < f('start')) return alert('The last day must be on or after the first day.');
    if (daysBetween(f('start'), f('end')) > 365) return alert('Trips can be at most a year long.');
    const budget = f('budget').trim() ? num(f('budget')) : null;
    const budgetEdited = budget !== trip.budget;
    if (!isNew && f('currency') !== trip.currency) {
      if (!confirm(`Convert all of this trip's amounts from ${trip.currency} to ${f('currency')}? Original amounts are kept.`)) return;
      if (!(await changeTripCurrency(trip, f('currency')))) return alert('Couldn\'t get exchange rates, so the currency wasn\'t changed.');
    }
    Object.assign(trip, { name: f('name').trim(), start: f('start'), end: f('end'), currency: f('currency') });
    if (budgetEdited || isNew) trip.budget = budget;
    if (isNew) trips.push(trip);
    await saveNow(trip);
    location.replace(`#trip/${trip.id}`);
  };
  $('[data-act=delete]')?.addEventListener('click', async () => {
    if (!confirm(`Delete "${trip.name || 'this trip'}" and all its expenses and receipts?`)) return;
    trips = trips.filter(t => t !== trip);
    await idb.delTrip(trip.id);
    await cleanupImages();
    location.replace('#');
  });
}

function viewTrip(trip) {
  const rows = computeRows(trip);
  const cols = [...CATS.map(c => c.key), 'total'];
  const max = Object.fromEntries(cols.map(k => [k, Math.max(0, ...rows.map(r => r[k]))]));
  const tot = tripTotals(trip);
  const cur = trip.currency;
  const pct = trip.budget ? Math.min(100, tot.total / trip.budget * 100) : 0;

  const cell = (r, k) => {
    const v = r[k];
    let mark = '';
    if (k === 'flights') mark = r.flightTodo ? '<i class="mark todo">●</i>' : r.flightOk ? '<i class="mark ok">✓</i>' : '';
    if (k === 'hotel') mark = r.hotelTodo ? '<i class="mark todo">●</i>' : r.hotelOk ? '<i class="mark ok">✓</i>' : '';
    const cls = [v ? '' : 'zero', k === 'hotel' && r.noHotel ? 'gap' : '', k === 'total' ? 'total' : ''].filter(Boolean).join(' ');
    return `<td class="${cls}" style="${heat(v, max[k])}" data-day="${r.date}">${short(v, cur)}${mark}</td>`;
  };

  app.innerHTML = bar(trip.name || 'Untitled trip', back('', '‹ Trips'), back(`trip/${trip.id}/edit`, 'Edit')) + `
    <div class="card summary">
      <div class="muted small">${rangeLabel(trip.start, trip.end)} · ${rows.length} day${rows.length === 1 ? '' : 's'}</div>
      <div class="big num">${money(tot.total, cur)}</div>
      ${trip.budget ? `
        <div class="budget-bar ${tot.total > trip.budget ? 'over' : ''}"><div style="width:${pct}%"></div></div>
        <div class="small muted num">${tot.total > trip.budget
          ? `${money(tot.total - trip.budget, cur)} over the ${money(trip.budget, cur, false)} budget`
          : `${money(trip.budget - tot.total, cur)} left of ${money(trip.budget, cur, false)}`}</div>` : ''}
      <div class="cat-totals">${CATS.map(c => `<div><b class="num">${short(tot[c.key], cur)}</b>${c.head}</div>`).join('')}</div>
    </div>
    <div class="row-btns">
      <a class="btn secondary" href="#trip/${trip.id}/flight/new">+ Flight</a>
      <a class="btn secondary" href="#trip/${trip.id}/hotel/new">+ Hotel</a>
      <a class="btn secondary" href="#trip/${trip.id}/bookings">Bookings</a>
    </div>
    <table class="grid">
      <thead><tr><th class="day">Day</th>${CATS.map(c => `<th>${c.head}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="day" data-day="${r.date}"><b>${dayLabel(r.date)}</b><span>${esc(r.city) || '&nbsp;'}</span></td>
        ${cols.map(k => cell(r, k)).join('')}
      </tr>`).join('')}</tbody>
      <tfoot><tr><td class="day">Total</td>${cols.map(k => `<td class="num">${short(sum(rows.map(r => r[k])), cur)}</td>`).join('')}</tr></tfoot>
    </table>
    <div class="legend"><span>Cheaper</span><span class="ramp"></span><span>Pricier (vs. other days)</span>
      <span>· <span style="color:var(--accent)">✓</span> booked · <span style="color:var(--warn)">●</span> not booked</span></div>
    ${tot.flights + tot.hotel > sum(rows.map(r => r.flights + r.hotel)) + 0.5
      ? `<p class="small muted">Some flights or hotel nights fall outside the trip dates. They count in the summary total but don't appear in the grid.</p>` : ''}`;

  app.querySelectorAll('tbody td').forEach(td => td.onclick = () => { location.hash = `#trip/${trip.id}/day/${td.dataset.day}`; });
}

const origLine = o => o.fx ? `<small>${money(o.fx.amt, o.fx.cur)}</small>` : '';
const clip = b => b.files?.length ? ` <span class="muted small">📎${b.files.length}</span>` : '';
function bookingRow(trip, b, kind) {
  const cur = trip.currency;
  if (kind === 'flight') {
    const route = [b.from, b.to].filter(Boolean).join(' → ');
    return `<a class="booking" href="#trip/${trip.id}/flight/${b.id}">
      <div class="what"><b>✈︎ ${esc([b.airline, b.number].filter(Boolean).join(' ') || 'Flight')}${clip(b)}</b>
      <span>${esc(route)}${route ? ' · ' : ''}${b.date ? dayLabel(b.date) : 'No date'}</span></div>
      <span class="num amt-col">${money(b.price || 0, cur)}${origLine(b)}</span>
      <span class="pill ${b.booked ? 'ok' : 'todo'}">${b.booked ? 'Booked' : 'To book'}</span></a>`;
  }
  return `<a class="booking" href="#trip/${trip.id}/hotel/${b.id}">
    <div class="what"><b>🛏 ${esc(b.name || 'Hotel')}${clip(b)}</b>
    <span>${b.checkIn ? `${dayLabel(b.checkIn)} → ${dayLabel(b.checkOut)} · ${nights(b)} night${nights(b) === 1 ? '' : 's'}` : 'No dates'}</span></div>
    <span class="num amt-col">${money(b.price || 0, cur)}${origLine(b)}</span>
    <span class="pill ${b.booked ? 'ok' : 'todo'}">${b.booked ? 'Booked' : 'To book'}</span></a>`;
}

function viewBookings(trip) {
  const fl = [...trip.flights].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const ho = [...trip.hotels].sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));
  app.innerHTML = bar('Bookings', back(`trip/${trip.id}`)) + `
    <div class="card"><h2>Flights <a class="link" href="#trip/${trip.id}/flight/new">+ Add</a></h2>
      ${fl.map(f => bookingRow(trip, f, 'flight')).join('') || '<div class="muted small">No flights yet.</div>'}</div>
    <div class="card"><h2>Hotels <a class="link" href="#trip/${trip.id}/hotel/new">+ Add</a></h2>
      ${ho.map(h => bookingRow(trip, h, 'hotel')).join('') || '<div class="muted small">No hotels yet.</div>'}</div>`;
}

function viewDay(trip, date) {
  const day = getDay(trip, date);
  const cur = trip.currency;
  const fl = flightsOn(trip, date);
  const ho = hotelsOn(trip, date);
  const prev = date > trip.start ? addDays(date, -1) : null;
  const next = date < trip.end ? addDays(date, 1) : null;
  const dayNo = daysBetween(trip.start, date) + 1;

  const fxLine = it => `= ${money(it.amount, cur)} · 1 ${it.fx.cur} = ${fmtRate(it.fx.rate)} ${cur}`;
  const listCard = c => `
    <div class="card" data-cat="${c.key}">
      <h2>${c.label} <span class="section-total">${money(sum(day[c.key].map(i => i.amount)), cur)}</span></h2>
      <ul class="items">${day[c.key].map(it => `
        <li data-id="${it.id}">
          <input class="label" value="${esc(it.label)}" placeholder="Description" data-f="label">
          <input class="amt num" value="${it.fx ? it.fx.amt : it.amount}" inputmode="decimal" data-f="amount">
          <span class="cur-tag">${it.fx ? it.fx.cur : cur}</span>
          <button class="del" aria-label="Remove">×</button>
          ${it.fx ? `<button class="fx-line num" type="button">${fxLine(it)}</button>` : ''}
        </li>`).join('')}</ul>
      <form class="add-row">
        <input name="label" placeholder="${c.key === 'food' ? 'e.g. Ramen lunch' : c.key === 'ent' ? 'e.g. Museum tickets' : 'e.g. Metro card'}" autocomplete="off">
        <input name="amount" class="amt" placeholder="0.00" inputmode="decimal" autocomplete="off">
        <select name="cur" class="cur" aria-label="Currency">${curOptions(trip, trip.lastCur || cur)}</select>
        <button class="btn">Add</button>
      </form>
    </div>`;

  app.innerHTML = bar(`Day ${dayNo}`, back(`trip/${trip.id}`), '') + `
    <div class="row-btns" style="margin-top:0">
      ${prev ? `<a class="btn secondary" href="#trip/${trip.id}/day/${prev}">‹ ${dayLabel(prev)}</a>` : '<span style="flex:1"></span>'}
      ${next ? `<a class="btn secondary" href="#trip/${trip.id}/day/${next}">${dayLabel(next)} ›</a>` : '<span style="flex:1"></span>'}
    </div>
    <div class="card">
      <h2>${longDate(date)}</h2>
      <label class="field"><span>City</span><input data-day-f="city" value="${esc(day.city)}" placeholder="Where are you?" autocomplete="off"></label>
      <label class="field" style="margin:0"><span>Plans / notes</span><textarea data-day-f="notes" placeholder="What you're doing today">${esc(day.notes)}</textarea></label>
    </div>
    <div class="card"><h2>Flights <a class="link" href="#trip/${trip.id}/flight/new?date=${date}">+ Add</a></h2>
      ${fl.map(f => bookingRow(trip, f, 'flight')).join('') || '<div class="muted small">No flights departing this day.</div>'}</div>
    <div class="card"><h2>Hotel tonight <a class="link" href="#trip/${trip.id}/hotel/new?date=${date}">+ Add</a></h2>
      ${ho.map(h => bookingRow(trip, h, 'hotel') + `<div class="small muted num" style="text-align:right">${money((h.price || 0) / nights(h), cur)} / night</div>`).join('')
        || '<div class="muted small">No hotel covers tonight.</div>'}</div>
    ${LIST_CATS.map(listCard).join('')}`;

  $$('[data-day-f]').forEach(el => el.oninput = () => { day[el.dataset.dayF] = el.value; save(trip); });

  for (const card of $$('[data-cat]')) {
    const list = day[card.dataset.cat];
    const updateTotal = () => { $('.section-total', card).textContent = money(sum(list.map(i => i.amount)), cur); };
    card.addEventListener('input', e => {
      const li = e.target.closest('li'); if (!li) return;
      const it = list.find(i => i.id === li.dataset.id);
      if (e.target.dataset.f === 'label') it.label = e.target.value;
      else if (e.target.dataset.f === 'amount') {
        if (it.fx) { it.fx.amt = num(e.target.value); it.amount = round2(it.fx.amt * it.fx.rate); $('.fx-line', li).textContent = fxLine(it); }
        else it.amount = num(e.target.value);
        updateTotal();
      }
      save(trip);
    });
    card.addEventListener('click', e => {
      if (e.target.matches('.fx-line')) {
        const it = list.find(i => i.id === e.target.closest('li').dataset.id);
        const r = num(prompt(`Exchange rate used for this expense:\n1 ${it.fx.cur} = how many ${cur}?`, fmtRate(it.fx.rate)) ?? '');
        if (r > 0) { it.fx.rate = r; it.amount = round2(it.fx.amt * r); e.target.textContent = fxLine(it); updateTotal(); save(trip, 0); }
        return;
      }
      if (!e.target.matches('.del')) return;
      const id = e.target.closest('li').dataset.id;
      list.splice(list.findIndex(i => i.id === id), 1);
      e.target.closest('li').remove();
      updateTotal(); save(trip, 0);
    });
    $('form', card).onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const amount = num(f.amount.value), c = f.cur.value;
      if (!f.label.value.trim() && !amount) return;
      const rate = await rateFor(c, cur);
      if (!rate) return;
      const it = { id: uid(), label: f.label.value.trim() };
      setMoney(it, 'amount', amount, c, cur, rate);
      list.push(it);
      rememberCur(trip, c);
      save(trip, 0);
      const y = scrollY;
      viewDay(trip, date);
      scrollTo(0, y);
      $(`[data-cat=${card.dataset.cat}] form [name=label]`).focus();
    };
  }
}

async function viewBooking(trip, kind, id, params) {
  const list = kind === 'flight' ? trip.flights : trip.hotels;
  const existing = list.find(b => b.id === id);
  if (id !== 'new' && !existing) return location.replace(`#trip/${trip.id}`);
  const d = params.get('date') || trip.start;
  const draft = existing ? structuredClone(existing) : kind === 'flight'
    ? { id: uid(), date: d, airline: '', number: '', from: '', to: '', price: 0, booked: false, files: [], notes: '' }
    : { id: uid(), name: '', address: '', checkIn: d, checkOut: addDays(d, 1), price: 0, booked: false, files: [], notes: '' };
  const backTo = params.get('date') ? `trip/${trip.id}/day/${params.get('date')}` : `trip/${trip.id}`;
  const priceField = label => `
      <label class="field"><span>${label}</span><div class="price-row">
        <input name="price" value="${draft.fx ? draft.fx.amt : draft.price}" inputmode="decimal" autocomplete="off">
        <select id="price-cur" aria-label="Currency">${curOptions(trip, draft.fx?.cur || trip.currency)}</select>
      </div></label>
      <div class="small muted num" id="fx-note" style="margin:-6px 0 12px"></div>`;
  const field = (name, label, attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(draft[name])}" autocomplete="off" ${attrs}></label>`;

  const fields = kind === 'flight' ? `
      <div class="two">${field('airline', 'Airline', 'placeholder="e.g. United"')}${field('number', 'Flight #', 'placeholder="UA 837" autocapitalize="characters"')}</div>
      <div class="two">${field('from', 'From', 'placeholder="SFO" autocapitalize="characters"')}${field('to', 'To', 'placeholder="NRT" autocapitalize="characters"')}</div>
      ${field('date', 'Departure date', 'type="date"')}
      ${priceField('Price')}`
    : `
      ${field('name', 'Hotel name', 'placeholder="e.g. Hotel Gracery"')}
      <label class="field"><span>Address</span><textarea name="address" rows="2" style="min-height:0" placeholder="Street, city">${esc(draft.address)}</textarea></label>
      ${draft.address ? `<p style="margin:-6px 0 12px"><a href="https://maps.apple.com/?q=${encodeURIComponent(draft.address)}" target="_blank">Open in Maps ↗</a></p>` : ''}
      <div class="two">${field('checkIn', 'Check-in', 'type="date"')}${field('checkOut', 'Check-out', 'type="date"')}</div>
      ${priceField('Total price (all nights)')}
      <div class="small muted num" id="per-night" style="margin:-6px 0 12px"></div>`;

  app.innerHTML = bar(existing ? (kind === 'flight' ? 'Flight' : 'Hotel') : `New ${kind === 'flight' ? 'Flight' : 'Hotel'}`,
    back(backTo, 'Cancel'), `<button class="link" data-act="save"><b>Save</b></button>`) + `
    <div class="card">
      ${fields}
      <label class="toggle"><span>Booked</span><input type="checkbox" name="booked" ${draft.booked ? 'checked' : ''}></label>
      <label class="field" style="margin:0"><span>Notes</span><textarea name="notes" rows="2" style="min-height:0" placeholder="Confirmation #, seat, etc.">${esc(draft.notes)}</textarea></label>
    </div>
    <div class="card"><h2>Files</h2><div id="files" class="files"></div>
      <label class="btn secondary block" style="margin-top:10px"><span id="file-btn">+ Add files</span><input type="file" multiple hidden id="file-input"></label>
    </div>
    ${existing ? `<button class="btn danger block" data-act="delete">Delete ${kind}</button>` : ''}`;

  const showFiles = async () => {
    const box = $('#files');
    if (!draft.files.length) { box.innerHTML = '<div class="muted small">No files yet. Add receipts, confirmations, PDFs, screenshots…</div>'; return; }
    const urls = await Promise.all(draft.files.map(f => f.type.startsWith('image/') ? fileUrl(f.id) : null));
    box.innerHTML = draft.files.map((f, i) => `
      <div class="file" data-i="${i}">
        ${urls[i] ? `<img src="${urls[i]}" alt="">` : `<span class="file-icon">${f.type === 'application/pdf' ? 'PDF' : 'FILE'}</span>`}
        <span class="file-name">${esc(f.name)}<small>${fmtSize(f.size)}</small></span>
        <button class="del" data-rm="${i}" aria-label="Remove file">×</button>
      </div>`).join('');
  };
  showFiles();
  $('#files').onclick = e => {
    const row = e.target.closest('.file'); if (!row) return;
    if (e.target.dataset.rm != null) { draft.files.splice(+e.target.dataset.rm, 1); showFiles(); }
    else openViewer(draft.files[+row.dataset.i]);
  };

  const curSel = $('#price-cur');
  let rate = draft.fx?.rate ?? 1; // trip-currency per 1 unit of the selected currency
  const tripPrice = () => num($('[name=price]').value) * (curSel.value === trip.currency ? 1 : rate);
  const perNight = () => {
    const el = $('#per-night'); if (!el) return;
    const ci = $('[name=checkIn]').value, co = $('[name=checkOut]').value;
    el.textContent = ci && co && co > ci ? `${daysBetween(ci, co)} night${daysBetween(ci, co) === 1 ? '' : 's'} · ${money(tripPrice() / daysBetween(ci, co), trip.currency)} / night` : '';
  };
  const updateFx = () => {
    $('#fx-note').innerHTML = curSel.value === trip.currency ? ''
      : `= ${money(tripPrice(), trip.currency)} · 1 ${curSel.value} = ${fmtRate(rate)} ${trip.currency} · <button type="button" class="link small" id="edit-rate">Edit rate</button>`;
    perNight();
  };
  updateFx();
  app.addEventListener('input', updateFx);
  let lastCur = curSel.value;
  curSel.onchange = async () => {
    const r = await rateFor(curSel.value, trip.currency);
    if (!r) { curSel.value = lastCur; return; }
    rate = r; lastCur = curSel.value;
    updateFx();
  };
  $('#fx-note').onclick = e => {
    if (e.target.id !== 'edit-rate') return;
    const r = num(prompt(`1 ${curSel.value} = how many ${trip.currency}?`, fmtRate(rate)) ?? '');
    if (r > 0) { rate = r; updateFx(); }
  };
  $('[name=checkIn]')?.addEventListener('change', e => {
    const co = $('[name=checkOut]');
    if (!co.value || co.value <= e.target.value) co.value = addDays(e.target.value, 1);
    perNight();
  });

  $('#file-input').onchange = async e => {
    const picked = [...e.target.files];
    e.target.value = '';
    const big = picked.filter(f => f.size > 25 * 1048576 && !f.type.startsWith('image/'));
    if (big.length && !confirm(`${big.map(f => f.name).join(', ')} ${big.length === 1 ? 'is' : 'are'} over 25 MB and will use a lot of phone storage. Add anyway?`)) return;
    $('#file-btn').textContent = 'Saving…';
    for (const f of picked) {
      try { draft.files.push(await storeFile(f)); } catch { alert(`Could not save ${f.name}.`); }
    }
    $('#file-btn').textContent = '+ Add files';
    showFiles();
  };

  $('[data-act=save]').onclick = async () => {
    for (const el of $$('[name]', app)) {
      if (el.closest('form.add-row')) continue;
      draft[el.name] = el.type === 'checkbox' ? el.checked : el.name === 'price' ? num(el.value) : el.value.trim();
    }
    if (kind === 'hotel' && draft.checkIn && draft.checkOut && draft.checkOut <= draft.checkIn) return alert('Check-out must be after check-in.');
    setMoney(draft, 'price', draft.price, curSel.value, trip.currency, rate);
    if (curSel.value !== trip.currency) rememberCur(trip, curSel.value);
    if (existing) {
      for (const k of Object.keys(existing)) if (!(k in draft)) delete existing[k];
      Object.assign(existing, draft);
    } else list.push(draft);
    await saveNow(trip);
    cleanupImages();
    location.replace('#' + backTo);
  };
  $('[data-act=delete]')?.addEventListener('click', async () => {
    if (!confirm(`Delete this ${kind}?`)) return;
    list.splice(list.indexOf(existing), 1);
    await saveNow(trip);
    cleanupImages();
    location.replace('#' + backTo);
  });
}

// PDF.js (vendored in /vendor/pdfjs) renders every page; iOS's built-in PDF preview only shows page one.
let pdfjsPromise;
const loadPdfJs = () => pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.js').then(m => {
  m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href;
  return m;
});
let viewerToken = 0;
let viewerUrls = [];
// Render each page to a compressed image (not a live canvas) so long PDFs don't exhaust iPhone memory.
async function renderPdf(buf, box, token) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) });
  const doc = await task.promise;
  try {
    if (token !== viewerToken) return; // viewer closed or another file opened while loading
    box.innerHTML = '';
    const scale = Math.min(window.devicePixelRatio || 1, 3) * 1.25; // a bit extra so pinch-zoomed text stays sharp
    for (let i = 1; i <= doc.numPages && token === viewerToken; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // iOS Safari refuses canvases over ~16.7 MP, so cap each page at 10 MP.
      const want = (box.clientWidth / base.width) * scale;
      const vp = page.getViewport({ scale: Math.min(want, Math.sqrt(10e6 / (base.width * base.height))) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      // 'print' renders straight through instead of waiting on animation frames (pages are drawn off-screen anyway).
      await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
      canvas.width = canvas.height = 0;
      page.cleanup();
      if (token !== viewerToken) break;
      const url = URL.createObjectURL(blob);
      viewerUrls.push(url);
      box.insertAdjacentHTML('beforeend', `<img class="pdf-page" src="${url}" alt="Page ${i} of ${doc.numPages}">`);
    }
  } finally {
    task.destroy().catch(() => {}); // frees the worker's copy of the PDF
  }
}

async function openViewer(f) {
  const url = await fileUrl(f.id);
  if (!url) return alert('That file is missing.');
  const token = ++viewerToken;
  const v = $('#viewer'), body = $('.viewer-body', v);
  $('.viewer-name', v).textContent = f.name;
  body.classList.toggle('pdf', f.type === 'application/pdf');
  body.innerHTML = f.type.startsWith('image/') ? `<img src="${url}" alt="">`
    : f.type === 'application/pdf' ? '<div class="empty">Loading PDF…</div>'
    : '<div class="empty">No preview for this file type.<br>Tap “Open in…” to save it to Files or open it in another app.</div>';
  v.hidden = false;
  if (f.type === 'application/pdf') {
    const rec = await idb.img(f.id);
    renderPdf(rec.buf, body, token).catch(() => {
      if (token === viewerToken) body.innerHTML = '<div class="empty">Couldn’t display this PDF.<br>Tap “Open in…” to view it in Files or Books.</div>';
    });
  }
  $('[data-v=close]', v).onclick = () => {
    viewerToken++;
    v.hidden = true; body.innerHTML = '';
    viewerUrls.forEach(URL.revokeObjectURL); viewerUrls = [];
  };
  $('[data-v=share]', v).onclick = async () => {
    const rec = await idb.img(f.id);
    const file = new File([rec.buf], f.name, { type: rec.type });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
    const a = document.createElement('a');
    a.href = url; a.download = f.name; a.click();
  };
}

/* ================= Router ================= */

let lastHash = null;
function render() {
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const [view, id, sub, subId] = path.split('/');
  const trip = trips.find(t => t.id === id);
  const sameView = lastHash === location.hash;
  lastHash = location.hash;
  if (!sameView) scrollTo(0, 0);

  // Replace the main element so per-view listeners don't pile up.
  const fresh = app.cloneNode(false);
  app.replaceWith(fresh);
  app = fresh;

  if (view === 'new') return viewTripForm(newTrip(), true);
  if (view !== 'trip' || !trip) return viewHome();
  if (sub === 'edit') return viewTripForm(trip, false);
  if (sub === 'bookings') return viewBookings(trip);
  if (sub === 'day' && subId) return viewDay(trip, subId);
  if (sub === 'flight' || sub === 'hotel') return viewBooking(trip, sub, subId, params);
  viewTrip(trip);
}

window.addEventListener('hashchange', render);

(async function init() {
  if (!DESKTOP && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.();
  trips = (await idb.trips()).map(migrate);
  await loadMyCurrencies();
  render();
  cleanupImages();
  // Rates arrive after first paint; redraw the home screen so its "updated" line is current.
  refreshRates().then(() => { if (!location.hash.slice(1)) render(); });
})();
