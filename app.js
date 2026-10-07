"use strict";
/* Tesla fleet web clone — static page, no build step. Talks to Tessie's API
 * directly from the browser (CORS is allowed). Token lives in localStorage.
 * No hardcoded home location ships in these files (privacy): the user sets it
 * in Settings via address lookup, pick-on-map, or manual coordinates. */

const KNOWN_CARS = [
  { vin: "5YJ3E1EA2JF051492", name: "Caroline's whip", img: "cars/car_whip.jpg",   imgMap: "cars/car_whip.png" },
  { vin: "5YJ3E1EA7JF015751", name: "The Starship",   img: "cars/car_starship.jpg", imgMap: "cars/car_starship.png" },
  { vin: "5YJ3E1EA9SF060398", name: "Miracle Whip",    img: "cars/car_miracle.jpg",  imgMap: "cars/car_miracle.png" },
];

/* Paid-FSD per VIN. Tessie's API does not expose FSD purchase status, so this
 * is a static map — flip per car here if a car's status changes. */
const FSD_VINS = new Set([
  "5YJ3E1EA2JF051492",
  "5YJ3E1EA7JF015751",
  "5YJ3E1EA9SF060398",
]);

/* Wheel overlay specs, fractions of photo width/height (from wheel_specs.json).
 * Photos face right (nose at +x). */
const WHEEL_SPECS = {
  "5YJ3E1EA2JF051492": [{ cx: 0.806, cy: 0.722, r: 0.077 }, { cx: 0.199, cy: 0.724, r: 0.075 }],
  "5YJ3E1EA7JF015751": [{ cx: 0.769, cy: 0.780, r: 0.064 }, { cx: 0.240, cy: 0.780, r: 0.064 }],
  "5YJ3E1EA9SF060398": [{ cx: 0.792, cy: 0.750, r: 0.072 }, { cx: 0.219, cy: 0.751, r: 0.069 }],
};

const store = {
  get token()   { return localStorage.getItem("tw_token") || ""; },
  set token(v)  { localStorage.setItem("tw_token", v); },
  get rate()    { const v = parseFloat(localStorage.getItem("tw_rate")); return isNaN(v) ? 0.18 : v; },
  set rate(v)   { localStorage.setItem("tw_rate", String(v)); },
  /* gas price for the fleet "vs gas car" comparison; AAA national avg Oct 2026 */
  get gasPrice() { const v = parseFloat(localStorage.getItem("tw_gas")); return isNaN(v) ? 4.37 : v; },
  set gasPrice(v) { localStorage.setItem("tw_gas", String(v)); },
  /* null until the user sets home (address lookup / pick on map / manual) */
  get homeLat() { const v = localStorage.getItem("tw_home_lat"); return v === null ? null : parseFloat(v); },
  get homeLon() { const v = localStorage.getItem("tw_home_lon"); return v === null ? null : parseFloat(v); },
  setHome(la, lo) {
    localStorage.setItem("tw_home_lat", String(la));
    localStorage.setItem("tw_home_lon", String(lo));
  },
  dist(vin)     { const v = localStorage.getItem("tw_dist_" + vin); return v === null ? null : parseFloat(v); },
  setDist(vin, d) {
    if (d === null || d === undefined || isNaN(d)) localStorage.removeItem("tw_dist_" + vin);
    else localStorage.setItem("tw_dist_" + vin, String(d));
  },
  fix(vin) {
    const la = localStorage.getItem("tw_lat_" + vin), lo = localStorage.getItem("tw_lon_" + vin);
    if (la === null || lo === null) return null;
    return [parseFloat(la), parseFloat(lo)];
  },
  setFix(vin, la, lo) {
    if (la === null || lo === null) return;
    localStorage.setItem("tw_lat_" + vin, String(la));
    localStorage.setItem("tw_lon_" + vin, String(lo));
  },
};

/* ---------- geo ---------- */
function haversineMiles(la1, lo1, la2, lo2) {
  const R = 3958.8, p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
  const a = Math.sin((p2 - p1) / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin((lo2 - lo1) * Math.PI / 360) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function compass8(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
function bearing(la1, lo1, la2, lo2) {
  const p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180, d = (lo2 - lo1) * Math.PI / 180;
  const y = Math.sin(d) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(d);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
function trend(prev, cur) {
  if (prev === null || cur === null) return "unknown";
  const diff = cur - prev;
  if (diff > 0.1) return "further";
  if (diff < -0.1) return "closer";
  return "holding";
}
const TREND_ARROW = { closer: "↓", further: "↑", holding: "→", unknown: "•" };

/* ---------- tessie ---------- */
async function tessie(path) {
  const r = await fetch("https://api.tessie.com" + path, {
    headers: { "Authorization": "Bearer " + store.token, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error("Tessie HTTP " + r.status);
  return r.json();
}

/* drives cache: 15-min TTL so the 60s refresh doesn't hammer the endpoint */
const drivesCache = {};
async function getDrives(vin) {
  const c = drivesCache[vin];
  if (c && Date.now() - c.ts < 15 * 60 * 1000) return c.drives;
  let drives = [];
  try {
    const d = await tessie("/" + vin + "/drives?limit=200");
    drives = (d.results || []).map(x => ({
      startedAt: x.started_at || 0,
      dist: x.odometer_distance || 0,
      kwh: x.energy_used || 0,
      ap: x.autopilot_distance || 0,
    }));
    drivesCache[vin] = { ts: Date.now(), drives };
  } catch (e) { drives = (c && c.drives) || []; }
  return drives;
}

/* charges cache: same 15-min TTL */
const chargesCache = {};
async function getCharges(vin) {
  const c = chargesCache[vin];
  if (c && Date.now() - c.ts < 15 * 60 * 1000) return c.charges;
  let charges = [];
  try {
    const d = await tessie("/" + vin + "/charges?limit=200");
    charges = (d.results || []).map(x => ({
      startedAt: x.started_at || 0,
      added: x.energy_added || 0,
      cost: (x.cost === null || x.cost === undefined) ? null : x.cost,
    }));
    chargesCache[vin] = { ts: Date.now(), charges };
  } catch (e) { charges = (c && c.charges) || []; }
  return charges;
}

/* first of the current month, browser-local, epoch seconds */
function monthStartSecs() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 1).getTime() / 1000;
}

/* Month-to-date: Autopilot/FSD % (Tesla's autopilot_distance includes FSD —
   the API can't split basic AP from FSD), kWh charged + est. cost, kWh used. */
function computeMonth(drives, charges, rate) {
  const start = monthStartSecs();
  const md = drives.filter(d => d.startedAt >= start && d.dist > 0);
  const totalMi = md.reduce((s, d) => s + d.dist, 0);
  const autopilotPct = totalMi > 0
    ? md.reduce((s, d) => s + Math.min(d.ap, d.dist), 0) / totalMi * 100 : null;
  const mc = charges.filter(c => c.startedAt >= start && c.added > 0);
  const kwhAdded = mc.length ? mc.reduce((s, c) => s + c.added, 0) : null;
  const kwhUsed = md.length ? md.reduce((s, d) => s + d.kwh, 0) : null;
  return {
    autopilotPct,
    kwhAdded,
    kwhUsed,
    estCost: kwhAdded !== null ? kwhAdded * rate : null,
    hasData: md.length > 0 || mc.length > 0,
    driveMiles: totalMi,
  };
}

function computeStats(drives, odometer, lifetimeChargedKwh) {
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  const week = drives.filter(d => d.startedAt >= weekAgo && d.dist > 0);
  const sevenDayMiles = week.length ? week.reduce((s, d) => s + d.dist, 0) : null;
  const eff = week.filter(d => d.dist >= 1);
  const effDist = eff.reduce((s, d) => s + d.dist, 0);
  const whPerMile = eff.length && effDist > 0
    ? eff.reduce((s, d) => s + d.kwh, 0) / effDist * 1000 : null;
  return { sevenDayMiles, whPerMile, odometer, lifetimeChargedKwh };
}

async function poll() {
  const cars = [];
  for (const kc of KNOWN_CARS) {
    let raw = null;
    try { raw = await tessie("/" + kc.vin + "/state"); } catch (e) { raw = null; }
    const drives = await getDrives(kc.vin);
    const charges = await getCharges(kc.vin);
    cars.push(buildCar(kc, raw, drives, charges));
  }
  return cars;
}

function buildCar(kc, raw, drives, charges) {
  const cs = (raw && raw.charge_state) || {};
  const ds = (raw && raw.drive_state) || {};
  const vs = (raw && raw.vehicle_state) || {};
  const mi = vs.media_info || {};
  const num = (o, k) => (o && o[k] !== null && o[k] !== undefined) ? o[k] : null;
  const batteryPct = num(cs, "battery_level");
  const chargingState = cs.charging_state || null;
  const speedMph = num(ds, "speed");
  const shiftState = ds.shift_state || null;
  const driving = shiftState === "D" || (speedMph !== null && speedMph > 0);
  let lat = num(ds, "latitude"), lon = num(ds, "longitude");
  const hLat = store.homeLat, hLon = store.homeLon;
  const miles = (lat !== null && lon !== null && hLat !== null && hLon !== null)
    ? haversineMiles(hLat, hLon, lat, lon) : null;
  const tr = trend(store.dist(kc.vin), miles);
  let headingDeg = num(ds, "heading");
  if (headingDeg === null && lat !== null && lon !== null) {
    const prev = store.fix(kc.vin);
    if (prev && (prev[0] !== lat || prev[1] !== lon)) headingDeg = bearing(prev[0], prev[1], lat, lon);
  }
  store.setDist(kc.vin, miles);
  store.setFix(kc.vin, lat, lon);
  // now playing: only when media is active with track info
  let nowPlaying = null;
  const pstat = mi.media_playback_status || null;
  if ((pstat === "Playing" || pstat === "Paused") && mi.now_playing_title) {
    nowPlaying = mi.now_playing_artist
      ? mi.now_playing_artist + " – " + mi.now_playing_title
      : mi.now_playing_title;
  }
  const stats = computeStats(
    drives || [],
    num(vs, "odometer"),
    num(cs, "lifetime_energy_charged")
  );
  const month = computeMonth(drives || [], charges || [], store.rate);
  return {
    vin: kc.vin, name: kc.name, img: kc.img, imgMap: kc.imgMap,
    batteryPct, chargingState, driving, speedMph, headingDeg,
    compass: headingDeg !== null ? compass8(headingDeg) : null,
    lat, lon, miles, trend: tr, nowPlaying, stats, month,
    error: raw ? null : "No state from Tessie",
  };
}

function batteryText(c) {
  if (c.batteryPct === null) return null;
  return c.chargingState === "Charging" ? "⚡Charging " + c.batteryPct + "%" : c.batteryPct + "%";
}
function statusText(c) {
  if (!c.driving) return "Parked";
  return "Driving" + (c.speedMph !== null ? " " + c.speedMph + " mph" : "") +
         (c.compass ? " " + c.compass : "");
}
function distanceText(c) {
  if (c.miles === null) return null;
  const w = { closer: "closer", further: "further", holding: "holding", unknown: "" }[c.trend];
  return w ? c.miles.toFixed(1) + " mi " + TREND_ARROW[c.trend] + " " + w
           : c.miles.toFixed(1) + " mi";
}
function statsText(c) {
  const s = c.stats, parts = [];
  if (s.sevenDayMiles !== null) parts.push(s.sevenDayMiles.toFixed(0) + " mi this week");
  if (s.whPerMile !== null) parts.push(s.whPerMile.toFixed(0) + " Wh/mi");
  if (s.odometer !== null) parts.push(Math.round(s.odometer).toLocaleString() + " mi odo");
  if (s.lifetimeChargedKwh !== null) parts.push(Math.round(s.lifetimeChargedKwh).toLocaleString() + " kWh charged");
  return parts.length ? parts.join(" · ") : null;
}

/* Blue FSD badge, Tesla-style. Tooltip keeps the honesty note: Tesla reports
 * this as Autopilot engagement miles (includes FSD); the API can't split them. */
function fsdBadge(pct) {
  return '<span class="fsd-badge" title="Tesla reports this as Autopilot engagement ' +
    'miles (includes FSD); the API can\'t split basic Autopilot from FSD.">' +
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9" fill="none" stroke="#2E9BFF" stroke-width="2.2"/>' +
    '<circle cx="12" cy="12" r="2.6" fill="#2E9BFF"/>' +
    '<path d="M12 12V3.5M12 12l-6.8 4.9M12 12l6.8 4.9" stroke="#2E9BFF" ' +
    'stroke-width="2.2" stroke-linecap="round"/></svg> FSD ' + pct.toFixed(0) + '%</span>';
}

/* Face (always visible): FSD badge + "Energy consumed: X kWh (~$Y)".
 * Details (charged vs driving, week stats, odo, lifetime) tuck into one
 * click-to-expand <details> so the card stays compact above the fold. */
function monthFace(m) {
  if (!m || !m.hasData) return "No drives yet this month";
  const face = [];
  if (m.autopilotPct !== null) face.push(fsdBadge(m.autopilotPct));
  if (m.kwhAdded !== null) {
    face.push("Energy consumed: <b>" + m.kwhAdded.toFixed(0) + " kWh (~$" +
      (m.estCost !== null ? m.estCost.toFixed(2) : "?") + ")</b>");
  }
  return face.length ? face.join(" · ") : "No drives yet this month";
}
function monthDetailText(m) {
  const det = [];
  if (!m) return "";
  if (m.kwhAdded !== null) det.push("Charged " + m.kwhAdded.toFixed(1) + " kWh");
  if (m.kwhUsed !== null) det.push("Driving used " + m.kwhUsed.toFixed(1) + " kWh");
  return det.join(" · ");
}

/* ---------- car photo canvases with spinning wheels ---------- */
const carImages = {};   // vin -> HTMLImageElement
let carsCache = [];

function preloadImages() {
  for (const kc of KNOWN_CARS) {
    const img = new Image();
    img.src = kc.img;
    carImages[kc.vin] = img;
  }
}

function drawWheel(ctx, cx, cy, r, angleDeg) {
  ctx.fillStyle = "#141414";
  ctx.beginPath(); ctx.arc(cx, cy, r * 1.04, 0, 7); ctx.fill();
  ctx.fillStyle = "#b9bec4";
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, 7); ctx.fill();
  ctx.strokeStyle = "#4a4f55"; ctx.lineWidth = Math.max(1, r * 0.18); ctx.lineCap = "round";
  for (let i = 0; i < 5; i++) {
    const a = (angleDeg + i * 72) * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r * 0.56, cy + Math.sin(a) * r * 0.56); ctx.stroke();
  }
  ctx.fillStyle = "#4a4f55";
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.13, 0, 7); ctx.fill();
}

function drawCarPhoto(canvas, car, angleDeg) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const img = carImages[car.vin];
  ctx.clearRect(0, 0, W, H);
  if (!img || !img.naturalWidth) {
    ctx.fillStyle = "#262b33"; ctx.fillRect(0, 0, W, H);
    return;
  }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const tAsp = W / H, pAsp = iw / ih;
  let sx, sy, sw, sh;
  if (pAsp > tAsp) { sh = ih; sw = ih * tAsp; sx = (iw - sw) / 2; sy = 0; }
  else { sw = iw; sh = iw / tAsp; sx = 0; sy = (ih - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  const spec = WHEEL_SPECS[car.vin];
  if (car.driving && spec) {
    const scale = W / sw;
    for (const wl of spec) {
      drawWheel(ctx, (wl.cx * iw - sx) * scale, (wl.cy * ih - sy) * scale,
                wl.r * iw * scale, angleDeg);
    }
  }
}

function spinLoop() {
  let anyDriving = false;
  for (const car of carsCache) {
    if (!car.driving) continue;
    anyDriving = true;
    const cv = document.querySelector('canvas[data-vin="' + car.vin + '"]');
    if (cv) drawCarPhoto(cv, car, (Date.now() / 12) % 360);
  }
  if (anyDriving) requestAnimationFrame(spinLoop);
}

/* ---------- cards (compact: everything above the map must fit a phone
 * viewport, so battery merges into the status line and all month/week
 * details share one expandable block) ---------- */
function renderCards(cars) {
  carsCache = cars;
  const wrap = document.getElementById("cards");
  wrap.innerHTML = "";
  for (const car of cars) {
    const card = document.createElement("div");
    card.className = "card";
    const batt = batteryText(car);
    const dist = distanceText(car);
    const stats = statsText(car);
    const statusBits = [batt, statusText(car), dist].filter(Boolean);
    const detBody = [monthDetailText(car.month), stats].filter(Boolean).join(" · ");
    card.innerHTML =
      '<div class="card-top">' +
        '<canvas width="330" height="138" data-vin="' + car.vin + '"></canvas>' +
        '<div><div class="name">' + escapeHtml(car.name) +
          (FSD_VINS.has(car.vin) ? ' <span class="fsd-chip">FSD</span>' : '') +
        '</div>' +
        '<div class="statusline">' + escapeHtml(statusBits.join(" · ")) + '</div>' +
        (car.nowPlaying ? '<div class="statusline np">♪ ' + escapeHtml(car.nowPlaying) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="details">' +
        (car.lat !== null && car.lon !== null
          ? '<div id="loc-' + car.vin + '">📍 Locating…</div>' : "") +
        '<details class="monthdet"><summary>This month: ' + monthFace(car.month) + '</summary>' +
        (detBody ? '<div>' + escapeHtml(detBody) + '</div>' : '') + '</details>' +
        (car.error ? '<div style="color:#e08a8a">' + escapeHtml(car.error) + '</div>' : "") +
      '</div>';
    wrap.appendChild(card);
    drawCarPhoto(card.querySelector("canvas"), car, 0);
  }
  const upd = document.getElementById("updated");
  upd.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  enrichLocations(cars);
  spinLoop();
}

/* ---------- human-readable area names (Nominatim reverse geocode) ----------
 * Raw lat/lon means nothing to a human, so each car card shows "Downtown
 * Tampa" style names. Results are cached in localStorage (keyed by rounded
 * coords) and the 3 cars' first-time lookups are staggered ~1.2s apart to
 * respect Nominatim's ~1 req/sec courtesy limit. Coordinates are never shown
 * on the page — only the friendly name, with "On the road" as fallback. */
function areaKey(lat, lon) { return "tw_area_" + lat.toFixed(3) + "," + lon.toFixed(3); }
function getAreaName(lat, lon) { return localStorage.getItem(areaKey(lat, lon)); }
function setAreaName(lat, lon, name) {
  try { localStorage.setItem(areaKey(lat, lon), name); } catch (e) { /* storage full: skip */ }
}
function formatArea(addr) {
  if (!addr) return null;
  const hood = addr.suburb || addr.neighbourhood || addr.city_district ||
               addr.hamlet || addr.borough || addr.quarter || null;
  const city = addr.city || addr.town || addr.village || addr.municipality ||
               addr.county || null;
  if (hood && city && hood !== city) return hood + ", " + city;
  return hood || city || null;
}
async function reverseGeocode(lat, lon) {
  const cached = getAreaName(lat, lon);
  if (cached !== null) return cached || null;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" +
      lat.toFixed(5) + "&lon=" + lon.toFixed(5) + "&zoom=14");
    const j = await r.json();
    const name = formatArea(j.address);
    setAreaName(lat, lon, name || "");
    return name;
  } catch (e) { return null; }
}
/* Raw coordinates are NEVER rendered as text on the page — cards show only
 * the human-readable area name. If a live lookup fails, fall back to the
 * nearest previously-resolved area, then to "On the road". (Coords stay in
 * the data layer where the map needs them.) */
function enrichLocations(cars) {
  cars.forEach((car, i) => {
    if (car.lat === null || car.lon === null) return;
    const el = document.getElementById("loc-" + car.vin);
    if (!el) return;
    const setName = (name) => {
      const box = document.getElementById("loc-" + car.vin);
      if (!box) return;
      box.innerHTML = "📍 <b>" + escapeHtml(name) + "</b>";
    };
    const cached = getAreaName(car.lat, car.lon);
    if (cached !== null) {
      setName(cached || nearestCachedArea(car.lat, car.lon) || "On the road");
      return;
    }
    setTimeout(async () => {
      const name = await reverseGeocode(car.lat, car.lon);
      setName(name || nearestCachedArea(car.lat, car.lon) || "On the road");
    }, i * 1200);
  });
}

/* nearest previously-resolved area within 25 miles — a friendly fallback
 * when a fresh reverse-geocode lookup fails */
function nearestCachedArea(lat, lon) {
  let best = null, bestD = 25;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || k.indexOf("tw_area_") !== 0) continue;
      const parts = k.slice(8).split(",");
      const la = parseFloat(parts[0]), lo = parseFloat(parts[1]);
      if (isNaN(la) || isNaN(lo)) continue;
      const name = localStorage.getItem(k);
      if (!name) continue;
      const d = haversineMiles(lat, lon, la, lo);
      if (d < bestD) { bestD = d; best = name; }
    }
  } catch (e) { /* storage hiccup: fall through to "On the road" */ }
  return best;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- map ---------- */
let map = null, carLayer = null;
let streetsLayer = null, satelliteLayer = null, radarLayer = null, radarOn = true;
let mapCtl = null, pickMode = false, pickMarker = null, pickBar = null;

function initMap() {
  const hLat = store.homeLat, hLon = store.homeLon;
  map = L.map("map").setView(
    (hLat !== null && hLon !== null) ? [hLat, hLon] : [39.5, -98.35],
    (hLat !== null && hLon !== null) ? 11 : 4);
  streetsLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  });
  satelliteLayer.addTo(map);  /* satellite is the default base layer */
  carLayer = L.layerGroup().addTo(map);
  buildMapCtl();
  loadRadar();
  setInterval(loadRadar, 10 * 60 * 1000);
}

function buildMapCtl() {
  mapCtl = L.DomUtil.create("div", "mapctl");
  const bS = L.DomUtil.create("button", "", mapCtl); bS.textContent = "Streets";
  const bT = L.DomUtil.create("button", "", mapCtl); bT.textContent = "Satellite";
  const bR = L.DomUtil.create("button", "", mapCtl); bR.textContent = "Radar";
  const paint = () => {
    bS.className = map.hasLayer(streetsLayer) ? "active" : "";
    bT.className = map.hasLayer(satelliteLayer) ? "active" : "";
    bR.className = (radarOn && radarLayer) ? "active" : "";
  };
  bS.onclick = () => { map.removeLayer(satelliteLayer); streetsLayer.addTo(map); paint(); };
  bT.onclick = () => { map.removeLayer(streetsLayer); satelliteLayer.addTo(map); paint(); };
  bR.onclick = () => {
    radarOn = !radarOn;
    if (radarLayer) { if (radarOn) radarLayer.addTo(map); else map.removeLayer(radarLayer); }
    paint();
  };
  L.DomEvent.disableClickPropagation(mapCtl);
  document.getElementById("map").appendChild(mapCtl);
  mapCtl._paint = paint;
  paint();
}

/* RainViewer radar: latest frame, semi-transparent so roads/cars show through */
function loadRadar() {
  fetch("https://api.rainviewer.com/public/weather-maps.json")
    .then(r => r.json())
    .then(d => {
      const past = (d.radar && d.radar.past) || [];
      if (!past.length) return;
      const frame = past[past.length - 1];
      const url = d.host + frame.path + "/256/{z}/{x}/{y}/2/1_1.png";
      if (radarLayer) radarLayer.setUrl(url);
      else {
        /* RainViewer radar tiles only exist for zoom 0-7 (z8+ returns a
         * "zoom level not supported" tile). maxNativeZoom: 7 makes Leaflet
         * upscale the z7 tiles at closer zooms instead of requesting z8+. */
        radarLayer = L.tileLayer(url, { opacity: 0.55, zIndex: 10, maxNativeZoom: 7,
          attribution: 'Radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>' });
        if (radarOn) radarLayer.addTo(map);
        if (mapCtl && mapCtl._paint) mapCtl._paint();
      }
    }).catch(() => {});
}

function renderMap(cars) {
  carLayer.clearLayers();
  const bounds = [];
  const hLat = store.homeLat, hLon = store.homeLon;
  if (hLat !== null && hLon !== null) {
    const home = L.circleMarker([hLat, hLon],
      { radius: 8, color: "#2e7d32", fillColor: "#66bb6a", fillOpacity: 0.9, weight: 2 });
    home.bindPopup("<b>Home</b><br/>Home base");
    carLayer.addLayer(home);
    bounds.push([hLat, hLon]);
  }

  // last-seen fallback for asleep cars, then de-collide stacked pins
  const items = [];
  for (const car of cars) {
    let lat = car.lat, lon = car.lon, stale = false;
    if (lat === null || lon === null) {
      const fix = store.fix(car.vin);
      if (fix) { lat = fix[0]; lon = fix[1]; stale = true; }
    }
    if (lat === null || lon === null) continue;
    items.push({ car, lat, lon, stale });
  }
  const groups = {};
  for (const it of items) {
    const k = it.lat.toFixed(4) + "," + it.lon.toFixed(4);
    (groups[k] = groups[k] || []).push(it);
  }
  const spread = [];
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    if (g.length === 1) { spread.push(g[0]); continue; }
    g.forEach((it, i) => {
      const a = 2 * Math.PI * i / g.length, r = 0.0012;
      spread.push({ car: it.car, lat: it.lat + r * Math.cos(a), lon: it.lon + r * Math.sin(a), stale: it.stale });
    });
  }

  for (const it of spread) {
    const car = it.car;
    const detail = [batteryText(car), statusText(car),
        car.nowPlaying ? "♪ " + car.nowPlaying : null, distanceText(car)]
      .filter(Boolean).join(" · ") + (it.stale ? " · last seen" : "");
    const img = carMapImages[car.vin];
    let mk;
    if (img && img.naturalWidth) {
      // Transparent car photo, no box; nose points along travel when driving.
      const rot = (car.driving && car.headingDeg !== null && car.headingDeg !== undefined)
        ? car.headingDeg - 90 : 0;
      const h = Math.max(16, Math.round(64 * img.naturalHeight / img.naturalWidth));
      const html = '<div style="transform: rotate(' + rot + 'deg);">' +
        '<img src="' + car.imgMap + '" style="width:64px;height:' + h + 'px;display:block;"/></div>';
      mk = L.marker([it.lat, it.lon], {
        icon: L.divIcon({ html, iconSize: [64, h], iconAnchor: [32, h / 2], className: "car-photo-icon" }),
        opacity: it.stale ? 0.7 : 1.0,
      });
    } else {
      mk = L.circleMarker([it.lat, it.lon],
        { radius: 10, color: "#0d47a1", fillColor: "#42a5f5", fillOpacity: 0.9, weight: 2 });
    }
    mk.bindPopup("<b>" + escapeHtml(car.name) + "</b><br/>" + escapeHtml(detail));
    carLayer.addLayer(mk);
    bounds.push([it.lat, it.lon]);
  }
  if (!pickMode) {
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [48, 48] });
    else if (bounds.length === 1) map.setView(bounds[0], 11);
  }
}

/* transparent PNGs for map markers (preloaded; cards keep the JPEGs) */
const carMapImages = {};
function preloadMapImages() {
  for (const kc of KNOWN_CARS) {
    const img = new Image();
    img.src = kc.imgMap;
    carMapImages[kc.vin] = img;
  }
}

/* ---------- pick-on-map mode (Settings) ---------- */
function setPickMode(on) {
  pickMode = on;
  const bar = document.getElementById("pickbar");
  if (on) {
    const hLat = store.homeLat, hLon = store.homeLon;
    const start = (hLat !== null && hLon !== null) ? [hLat, hLon] : map.getCenter();
    pickMarker = L.marker(start, { draggable: true }).addTo(map);
    map.on("click", pickClick);
    bar.hidden = false;
  } else {
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
    map.off("click", pickClick);
    bar.hidden = true;
  }
}
function pickClick(e) { if (pickMarker) pickMarker.setLatLng(e.latlng); }

/* ---------- refresh / settings ---------- */
/* Home counts as set only when both coords are real numbers (guards against
 * empty-string/NaN values that are !== null but unusable). */
function isHomeSet() {
  const la = store.homeLat, lo = store.homeLon;
  return la !== null && lo !== null && !isNaN(la) && !isNaN(lo);
}

/* Fleet month-to-date totals, shared math (testable without DOM) */
function computeFleetTotals(cars, rate, gas) {
  let added = 0, miles = 0, any = false;
  for (const c of cars) {
    const m = c.month;
    if (!m || !m.hasData) continue;
    any = true;
    if (m.kwhAdded) added += m.kwhAdded;
    if (m.driveMiles) miles += m.driveMiles;
  }
  if (!any) return { any: false };
  const evCost = added * rate;
  const gasCost = miles / 15 * gas;
  return { any: true, evCost, gasCost, saved: gasCost - evCost };
}

/* Thin month-totals strip under the header: ⚡ electricity (amber) ·
 * ⛽ gas-car equivalent (orange) · 💰 saved (green). Savings over $25 get a
 * glowing 🎉 pill as the exclamation point. */
function monthLabel() {
  const d = new Date();
  return d.toLocaleString("en-US", { month: "short" }) + " " + d.getFullYear();
}
function renderFleetStrip(cars) {
  const el = document.getElementById("fleetstrip");
  if (!el) return;
  const t = computeFleetTotals(cars, store.rate, store.gasPrice);
  if (!t.any) { el.hidden = true; el.innerHTML = ""; return; }
  let savedHtml;
  if (t.saved > 25) {
    savedHtml = '<span class="sv-pill">🎉 saved ~$' + t.saved.toFixed(2) + '</span>';
  } else if (t.saved >= 0) {
    savedHtml = '<span class="sv">💰 saved ~$' + t.saved.toFixed(2) + '</span>';
  } else {
    savedHtml = '<span class="svneg">💰 gas ~$' + Math.abs(t.saved).toFixed(2) + ' cheaper</span>';
  }
  el.innerHTML =
    '<span class="win">' + monthLabel() + ' · month to date</span>' +
    '<span class="ev" title="Electricity this month">⚡ $' + t.evCost.toFixed(2) + '</span>' +
    '<span class="sep">·</span>' +
    '<span class="gas" title="Same miles in a 15-mpg gas car">⛽ ~$' + t.gasCost.toFixed(2) + '</span>' +
    '<span class="sep">·</span>' + savedHtml;
  el.hidden = false;
}

async function refresh() {
  const errBox = document.getElementById("err");
  /* Decide about the home nudge BEFORE any async work, so the prompt can
   * never flash on and off mid-refresh: it only ever appears when home is
   * genuinely unset, and stays hidden otherwise. */
  const needHomeNudge = !isHomeSet();
  errBox.hidden = true;
  if (!store.token) {
    document.getElementById("settings").hidden = false;
    errBox.hidden = false;
    errBox.textContent = "Enter your Tessie API token in Settings to load the fleet.";
    return;
  }
  try {
    const cars = await poll();
    renderCards(cars);
    renderMap(cars);
    renderFleetStrip(cars);
    if (needHomeNudge && !isHomeSet()) {
      errBox.hidden = false;
      errBox.textContent = "Set your home location in Settings (address lookup or pick on map).";
    }
  } catch (e) {
    errBox.hidden = false;
    errBox.textContent = "Could not reach Tessie: " + e.message + " — check the token in Settings.";
  }
}

function initSettings() {
  const sec = document.getElementById("settings");
  document.getElementById("settingsBtn").addEventListener("click", () => {
    sec.hidden = !sec.hidden;
  });
  document.getElementById("tokenInput").value = store.token;
  document.getElementById("rateInput").value = String(store.rate);
  document.getElementById("gasInput").value = String(store.gasPrice);
  document.getElementById("latInput").value = localStorage.getItem("tw_home_lat") || "";
  document.getElementById("lonInput").value = localStorage.getItem("tw_home_lon") || "";
  document.getElementById("latInput").placeholder = "e.g. 28.1397";
  document.getElementById("lonInput").placeholder = "e.g. -82.7324";

  document.getElementById("saveBtn").addEventListener("click", () => {
    store.token = document.getElementById("tokenInput").value.trim();
    const r = parseFloat(document.getElementById("rateInput").value);
    if (!isNaN(r) && r >= 0) store.rate = r;
    const gp = parseFloat(document.getElementById("gasInput").value);
    if (!isNaN(gp) && gp > 0) store.gasPrice = gp;
    const la = parseFloat(document.getElementById("latInput").value);
    const lo = parseFloat(document.getElementById("lonInput").value);
    if (!isNaN(la) && !isNaN(lo)) store.setHome(la, lo);
    sec.hidden = true;
    refresh();
  });
  document.getElementById("refreshBtn").addEventListener("click", refresh);

  /* address lookup via Nominatim (no coordinates to type) */
  let lookupHit = null;
  document.getElementById("lookupBtn").addEventListener("click", async () => {
    const q = document.getElementById("addrInput").value.trim();
    const res = document.getElementById("lookupResult");
    const useBtn = document.getElementById("useAddrBtn");
    if (!q) { res.textContent = "Type an address first."; return; }
    res.textContent = "Looking up…";
    useBtn.hidden = true;
    lookupHit = null;
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
        encodeURIComponent(q));
      const arr = await r.json();
      if (!arr.length) { res.textContent = "No match — try more detail (street, city, state)."; return; }
      lookupHit = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
      res.textContent = arr[0].display_name;
      useBtn.hidden = false;
    } catch (e) {
      res.textContent = "Lookup failed — check your connection and try again.";
    }
  });
  document.getElementById("useAddrBtn").addEventListener("click", () => {
    if (!lookupHit) return;
    document.getElementById("latInput").value = lookupHit.lat;
    document.getElementById("lonInput").value = lookupHit.lon;
    document.getElementById("lookupResult").textContent = "Home set — tap Save to keep it.";
    document.getElementById("useAddrBtn").hidden = true;
  });

  /* pick on map */
  document.getElementById("pickMapBtn").addEventListener("click", () => {
    sec.hidden = true;
    setPickMode(true);
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.getElementById("pickOkBtn").addEventListener("click", () => {
    if (pickMarker) {
      const p = pickMarker.getLatLng();
      store.setHome(p.lat, p.lng);
      document.getElementById("latInput").value = p.lat;
      document.getElementById("lonInput").value = p.lng;
    }
    setPickMode(false);
    refresh();
  });
  document.getElementById("pickCancelBtn").addEventListener("click", () => setPickMode(false));
}

preloadImages();
preloadMapImages();
initSettings();
initMap();
refresh();
setInterval(refresh, 60000);
