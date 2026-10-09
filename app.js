'use strict';

/* ================= Storage (IndexedDB) ================= */

let dbPromise;
function openDb() {
  return dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tripbudget', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('trips', { keyPath: 'id' });
      req.result.createObjectStore('images'); // key: image id, value: { type, buf }
    };
    req.onsuccess = () => resolve(req.result);
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
const idb = {
  trips: () => tx('trips', 'readonly', s => s.getAll()),
  putTrip: trip => tx('trips', 'readwrite', s => s.put(trip)),
  delTrip: id => tx('trips', 'readwrite', s => s.delete(id)),
  img: id => tx('images', 'readonly', s => s.get(id)),
  putImg: (id, val) => tx('images', 'readwrite', s => s.put(val, id)),
  delImg: id => tx('images', 'readwrite', s => s.delete(id)),
  imgKeys: () => tx('images', 'readonly', s => s.getAllKeys()),
};

let trips = [];
const saveTimers = {};
function save(trip, delay = 400) {
  clearTimeout(saveTimers[trip.id]);
  saveTimers[trip.id] = setTimeout(() => idb.putTrip(trip), delay);
}
function saveNow(trip) {
  clearTimeout(saveTimers[trip.id]);
  return idb.putTrip(trip);
}
// Flush pending saves when the app is backgrounded/closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    for (const id in saveTimers) { const t = trips.find(x => x.id === id); if (t) saveNow(t); }
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

/* ================= Images ================= */

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
const imgUrls = {};
async function imageUrl(id) {
  if (!id) return null;
  if (imgUrls[id]) return imgUrls[id];
  const rec = await idb.img(id);
  if (!rec) return null;
  return imgUrls[id] = URL.createObjectURL(new Blob([rec.buf], { type: rec.type }));
}
// Remove stored images no longer referenced by any trip (e.g. replaced or cancelled drafts).
async function cleanupImages() {
  const used = new Set(trips.flatMap(t => [...t.flights, ...t.hotels].map(b => b.receipt).filter(Boolean)));
  for (const k of await idb.imgKeys()) if (!used.has(k)) await idb.delImg(k);
}

/* ================= Backup ================= */

const toB64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

async function exportBackup() {
  const images = {};
  for (const k of await idb.imgKeys()) { const r = await idb.img(k); images[k] = { type: r.type, data: toB64(r.buf) }; }
  const json = JSON.stringify({ app: 'tripbudget', v: 1, exported: new Date().toISOString(), trips, images });
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

async function importBackup(file) {
  let buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const data = JSON.parse(new TextDecoder().decode(buf));
  if (data.app !== 'tripbudget' || !Array.isArray(data.trips)) throw new Error('Not a Trip Budget backup');
  if (!confirm(`Import ${data.trips.length} trip(s)? Trips with the same ID will be replaced.`)) return;
  for (const [k, v] of Object.entries(data.images || {})) await idb.putImg(k, { type: v.type, buf: fromB64(v.data) });
  for (const t of data.trips) await idb.putTrip(t);
  trips = await idb.trips();
  render();
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
    <div class="card foot">
      <h2>Backup</h2>
      <p class="small muted" style="margin-top:0">Everything is stored only on this phone. Export a backup to Files or iCloud Drive now and then. Deleting the app from your Home Screen erases its data.</p>
      <div class="row-btns">
        <button class="btn secondary" data-act="export">Export backup</button>
        <label class="btn secondary">Import<input type="file" accept=".gz,.json,application/json,application/gzip" hidden data-act="import"></label>
      </div>
      <div class="small muted" id="usage"></div>
    </div>`;
  navigator.storage?.estimate?.().then(e => {
    const el = $('#usage'); if (el && e.usage != null) el.textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this device`;
  });
  $('[data-act=export]').onclick = () => exportBackup().catch(e => alert('Export failed: ' + e.message));
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
        <label class="field"><span>Currency</span><select name="currency">${CURRENCIES.map(c => `<option ${c === draft.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
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
    Object.assign(trip, { name: f('name').trim(), start: f('start'), end: f('end'), currency: f('currency'), budget: f('budget').trim() ? num(f('budget')) : null });
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

function bookingRow(trip, b, kind) {
  const cur = trip.currency;
  if (kind === 'flight') {
    const route = [b.from, b.to].filter(Boolean).join(' → ');
    return `<a class="booking" href="#trip/${trip.id}/flight/${b.id}">
      <div class="what"><b>✈︎ ${esc([b.airline, b.number].filter(Boolean).join(' ') || 'Flight')}</b>
      <span>${esc(route)}${route ? ' · ' : ''}${b.date ? dayLabel(b.date) : 'No date'}</span></div>
      <span class="num">${money(b.price || 0, cur)}</span>
      <span class="pill ${b.booked ? 'ok' : 'todo'}">${b.booked ? 'Booked' : 'To book'}</span></a>`;
  }
  return `<a class="booking" href="#trip/${trip.id}/hotel/${b.id}">
    <div class="what"><b>🛏 ${esc(b.name || 'Hotel')}</b>
    <span>${b.checkIn ? `${dayLabel(b.checkIn)} → ${dayLabel(b.checkOut)} · ${nights(b)} night${nights(b) === 1 ? '' : 's'}` : 'No dates'}</span></div>
    <span class="num">${money(b.price || 0, cur)}</span>
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

  const listCard = c => `
    <div class="card" data-cat="${c.key}">
      <h2>${c.label} <span class="section-total">${money(sum(day[c.key].map(i => i.amount)), cur)}</span></h2>
      <ul class="items">${day[c.key].map(it => `
        <li data-id="${it.id}">
          <input class="label" value="${esc(it.label)}" placeholder="Description" data-f="label">
          <input class="amt num" value="${it.amount}" inputmode="decimal" data-f="amount">
          <button class="del" aria-label="Remove">×</button>
        </li>`).join('')}</ul>
      <form class="add-row">
        <input name="label" placeholder="${c.key === 'food' ? 'e.g. Ramen lunch' : c.key === 'ent' ? 'e.g. Museum tickets' : 'e.g. Metro card'}" autocomplete="off">
        <input name="amount" class="amt" placeholder="0.00" inputmode="decimal" autocomplete="off">
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
      else { it.amount = num(e.target.value); updateTotal(); }
      save(trip);
    });
    card.addEventListener('click', e => {
      if (!e.target.matches('.del')) return;
      const id = e.target.closest('li').dataset.id;
      list.splice(list.findIndex(i => i.id === id), 1);
      e.target.closest('li').remove();
      updateTotal(); save(trip, 0);
    });
    $('form', card).onsubmit = e => {
      e.preventDefault();
      const f = e.target;
      const amount = num(f.amount.value);
      if (!f.label.value.trim() && !amount) return;
      list.push({ id: uid(), label: f.label.value.trim(), amount });
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
    ? { id: uid(), date: d, airline: '', number: '', from: '', to: '', price: 0, booked: false, receipt: null, notes: '' }
    : { id: uid(), name: '', address: '', checkIn: d, checkOut: addDays(d, 1), price: 0, booked: false, receipt: null, notes: '' };
  const backTo = params.get('date') ? `trip/${trip.id}/day/${params.get('date')}` : `trip/${trip.id}`;
  const field = (name, label, attrs = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(draft[name])}" autocomplete="off" ${attrs}></label>`;

  const fields = kind === 'flight' ? `
      <div class="two">${field('airline', 'Airline', 'placeholder="e.g. United"')}${field('number', 'Flight #', 'placeholder="UA 837" autocapitalize="characters"')}</div>
      <div class="two">${field('from', 'From', 'placeholder="SFO" autocapitalize="characters"')}${field('to', 'To', 'placeholder="NRT" autocapitalize="characters"')}</div>
      <div class="two">${field('date', 'Departure date', 'type="date"')}${field('price', 'Price', 'inputmode="decimal"')}</div>`
    : `
      ${field('name', 'Hotel name', 'placeholder="e.g. Hotel Gracery"')}
      <label class="field"><span>Address</span><textarea name="address" rows="2" style="min-height:0" placeholder="Street, city">${esc(draft.address)}</textarea></label>
      ${draft.address ? `<p style="margin:-6px 0 12px"><a href="https://maps.apple.com/?q=${encodeURIComponent(draft.address)}" target="_blank">Open in Maps ↗</a></p>` : ''}
      <div class="two">${field('checkIn', 'Check-in', 'type="date"')}${field('checkOut', 'Check-out', 'type="date"')}</div>
      ${field('price', 'Total price (all nights)', 'inputmode="decimal"')}
      <div class="small muted num" id="per-night" style="margin:-6px 0 12px"></div>`;

  app.innerHTML = bar(existing ? (kind === 'flight' ? 'Flight' : 'Hotel') : `New ${kind === 'flight' ? 'Flight' : 'Hotel'}`,
    back(backTo, 'Cancel'), `<button class="link" data-act="save"><b>Save</b></button>`) + `
    <div class="card">
      ${fields}
      <label class="toggle"><span>Booked</span><input type="checkbox" name="booked" ${draft.booked ? 'checked' : ''}></label>
      <label class="field" style="margin:0"><span>Notes</span><textarea name="notes" rows="2" style="min-height:0" placeholder="Confirmation #, seat, etc.">${esc(draft.notes)}</textarea></label>
    </div>
    <div class="card receipt"><h2>Receipt</h2><div id="receipt"></div>
      <div class="row-btns" style="margin-bottom:0">
        <label class="btn secondary"><span id="receipt-btn">${draft.receipt ? 'Replace' : 'Add screenshot'}</span><input type="file" accept="image/*" hidden id="receipt-input"></label>
        ${draft.receipt ? '<button class="btn danger" data-act="rm-receipt">Remove</button>' : ''}
      </div>
    </div>
    ${existing ? `<button class="btn danger block" data-act="delete">Delete ${kind}</button>` : ''}`;

  const showReceipt = async () => {
    const url = await imageUrl(draft.receipt);
    $('#receipt').innerHTML = url ? `<img src="${url}" alt="Receipt">` : '<div class="muted small" style="margin-bottom:8px">No receipt saved.</div>';
    const img = $('#receipt img'); if (img) img.onclick = () => openViewer(url);
  };
  showReceipt();

  const perNight = () => {
    const el = $('#per-night'); if (!el) return;
    const ci = $('[name=checkIn]').value, co = $('[name=checkOut]').value;
    el.textContent = ci && co && co > ci ? `${nights({ checkIn: ci, checkOut: co })} nights · ${money(num($('[name=price]').value) / daysBetween(ci, co), trip.currency)} / night` : '';
  };
  perNight();
  app.addEventListener('input', perNight);
  $('[name=checkIn]')?.addEventListener('change', e => {
    const co = $('[name=checkOut]');
    if (!co.value || co.value <= e.target.value) co.value = addDays(e.target.value, 1);
    perNight();
  });

  $('#receipt-input').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    $('#receipt-btn').textContent = 'Saving…';
    try {
      const rec = await compressImage(file);
      const imgId = uid();
      await idb.putImg(imgId, rec);
      draft.receipt = imgId;
      $('#receipt-btn').textContent = 'Replace';
      showReceipt();
    } catch (err) {
      alert('Could not read that image.');
      $('#receipt-btn').textContent = draft.receipt ? 'Replace' : 'Add screenshot';
    }
  };
  $('[data-act=rm-receipt]')?.addEventListener('click', () => { draft.receipt = null; showReceipt(); });

  $('[data-act=save]').onclick = async () => {
    for (const el of $$('[name]', app)) {
      if (el.closest('form.add-row')) continue;
      draft[el.name] = el.type === 'checkbox' ? el.checked : el.name === 'price' ? num(el.value) : el.value.trim();
    }
    if (kind === 'hotel' && draft.checkIn && draft.checkOut && draft.checkOut <= draft.checkIn) return alert('Check-out must be after check-in.');
    if (existing) Object.assign(existing, draft); else list.push(draft);
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

function openViewer(url) {
  const v = $('#viewer');
  $('img', v).src = url;
  v.hidden = false;
  v.onclick = () => { v.hidden = true; };
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.();
  trips = await idb.trips();
  render();
  cleanupImages();
})();
