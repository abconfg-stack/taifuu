// 台風モデル比較 — 画面まわり
'use strict';

const $ = id => document.getElementById(id);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isWide = () => window.matchMedia('(min-width: 900px)').matches;

const state = {
  situation: null,
  tracks: null,
  leadHours: 0,
  selection: 'all',
  status: 'live',
  playing: null,
  panelOpen: true,
  showOfficial: false,
  ensemble: null,
  ensembleSystem: 'gefs',
  ensembleBusy: false,
  ensembleError: null,
  site: null,
  siteData: null,
  siteBusy: false,
  siteError: null,
  element: 'wind'
};

// 使う人が足した地点は、この端末のブラウザ内にだけ残す
const Sites = {
  key: 'typhoon-compare.sites',
  custom() {
    try { return JSON.parse(localStorage.getItem(Sites.key) || '[]'); } catch { return []; }
  },
  add(site) {
    const list = Sites.custom();
    if (list.some(s => s.name === site.name)) return;
    list.push(site);
    try { localStorage.setItem(Sites.key, JSON.stringify(list)); } catch {}
  },
  remove(name) {
    try {
      localStorage.setItem(Sites.key, JSON.stringify(Sites.custom().filter(s => s.name !== name)));
    } catch {}
  },
  all() { return [...Sites.custom(), ...DEFAULT_SITES]; }
};

// ───────────────────────────────── 地図

let map;
const layers = { past: [], tracks: [], markers: [], official: [], ensemble: [], observation: null };

function initMap() {
  map = L.map('map', { zoomControl: false }).setView([32, 137], 4);
  // 淡い地図。道路や店は出さず、海岸線と地名だけが見えるものを選ぶ。
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const base = dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
  L.tileLayer(
    `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: 10, minZoom: 2, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }
  ).addTo(map);
}

function clearMap() {
  for (const key of Object.keys(layers)) {
    const v = layers[key];
    if (Array.isArray(v)) { v.forEach(l => map.removeLayer(l)); layers[key] = []; }
    else if (v) { map.removeLayer(v); layers[key] = null; }
  }
}

function drawMap() {
  if (!state.situation || !map) return;
  clearMap();
  const obs = state.situation.observation;

  // これまでに通ってきた経路
  if (obs.pastTrack && obs.pastTrack.length > 1) {
    layers.past.push(L.polyline(obs.pastTrack, {
      color: cssVar('--observation'), weight: 1.6, opacity: .45, dashArray: '1 5'
    }).addTo(map));
  }

  // アンサンブルの各メンバー。決定論モデルより先に、薄く敷いておく。
  if (state.ensemble) {
    const sys = ENSEMBLES.find(e => e.id === state.ensemble.system);
    const color = modelById[sys.base].color;
    for (const m of state.ensemble.members) {
      layers.ensemble.push(L.polyline(m.points.map(p => [p.lat, p.lon]), {
        color, weight: m.index === 0 ? 1.8 : 1.1,
        opacity: m.index === 0 ? .55 : .20, interactive: false
      }).addTo(map));
      const cur = interpolate(m, state.leadHours);
      if (cur) {
        layers.ensemble.push(L.circleMarker([cur.lat, cur.lon], {
          radius: m.index === 0 ? 3 : 2, color, weight: 0,
          fillColor: color, fillOpacity: m.index === 0 ? .9 : .5, interactive: false
        }).addTo(map));
      }
    }
  }

  // 各モデルの予測進路
  if (state.tracks) {
    for (const model of state.tracks.models) {
      const def = modelById[model.id];
      const on = state.selection === 'all' || state.selection === model.id;
      layers.tracks.push(L.polyline(model.points.map(p => [p.lat, p.lon]), {
        color: def.color, weight: on ? 3.2 : 2, opacity: on ? .95 : .16,
        dashArray: def.dash || null, lineCap: 'round', lineJoin: 'round'
      }).addTo(map));

      for (const p of model.points) {
        if (p.leadHours % 12 !== 0) continue;
        layers.markers.push(L.circleMarker([p.lat, p.lon], {
          radius: on ? 3 : 2, color: def.color, weight: 0,
          fillColor: def.color, fillOpacity: on ? .9 : .18
        }).addTo(map));
      }

      // 追跡が終わっているモデルには、その時刻の印を置かない
      const cur = interpolate(model, state.leadHours);
      if (cur) {
        layers.markers.push(L.circleMarker([cur.lat, cur.lon], {
          radius: on ? 7 : 4.5, color: def.color, weight: on ? 2.5 : 1.5,
          fillColor: def.color, fillOpacity: on ? .3 : .12
        }).addTo(map));
      }
    }
  }

  // 気象庁の公式予報。モデルの進路とは別物なので、色も形も分けて描く。
  const official = state.situation.official;
  if (state.showOfficial && official) {
    const color = cssVar('--observation');
    layers.official.push(L.polyline(
      [[obs.latitude, obs.longitude], ...official.points.map(p => p.center)],
      { color, weight: 2.4, opacity: .9, lineCap: 'round' }).addTo(map));
    for (const p of official.points) {
      if (p.radius) {
        layers.official.push(L.circle(p.center, {
          radius: p.radius, color, weight: 1.2, opacity: .55,
          fillColor: color, fillOpacity: .07
        }).addTo(map));
      }
      if (p.stormRadius) {
        layers.official.push(L.circle(p.center, {
          radius: p.stormRadius, color: cssVar('--caution'), weight: 1.2,
          opacity: .5, dashArray: '6 5', fill: false
        }).addTo(map));
      }
      layers.official.push(L.circleMarker(p.center, {
        radius: 4, color, weight: 2, fillColor: cssVar('--bg'), fillOpacity: 1
      }).addTo(map));
    }
  }

  // 台風の現在位置（実況）。予測とは形を変える。
  layers.observation = L.circleMarker([obs.latitude, obs.longitude], {
    radius: 10, color: cssVar('--observation'), weight: 3,
    fillColor: cssVar('--observation'), fillOpacity: .22
  }).addTo(map);

  renderLegend();
}

function renderLegend() {
  const box = $('map-legend');
  const rows = [];
  if (state.ensemble) {
    const sys = ENSEMBLES.find(e => e.id === state.ensemble.system);
    const color = modelById[sys.base].color;
    rows.push(`<div><svg width="14" height="3"><line x1="0" y1="1.5" x2="14" y2="1.5"
      stroke="${color}" stroke-opacity=".55" stroke-width="2"/></svg>
      <span style="color:${color}">${sys.label} ${state.ensemble.members.length}メンバー</span></div>`);
  }
  if (state.showOfficial && state.situation && state.situation.official) {
    const c = cssVar('--observation');
    rows.push(`<div><svg width="14" height="14"><circle cx="7" cy="7" r="5"
      fill="none" stroke="${c}" stroke-width="1.5"/></svg>
      <span style="color:${c}">気象庁 公式予報（予報円）</span></div>`);
  }
  box.hidden = !rows.length;
  box.innerHTML = rows.join('');
}

// 実況と全モデルの進路が収まる範囲。日付変更線をまたいでも切れないようにする。
function fitMap() {
  if (!state.situation || !map) return;
  const obs = state.situation.observation;
  const base = obs.longitude;
  const unwrap = lon => base + GeoMath.norm(lon - base);
  const pts = [[obs.latitude, base]];
  if (state.tracks) {
    for (const m of state.tracks.models) for (const p of m.points) pts.push([p.lat, unwrap(p.lon)]);
  }
  if (Math.abs(GeoMath.norm(135 - base)) < 35) pts.push([31, unwrap(130)], [37, unwrap(141)]);

  const controls = document.querySelector('.controls');
  const bottom = controls ? controls.offsetHeight : 0;
  map.fitBounds(L.latLngBounds(pts), {
    animate: true,
    paddingTopLeft: [16, 70],
    paddingBottomRight: [16, bottom + 16]
  });
}

function fitSoon() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!map) return;
    map.invalidateSize();
    fitMap();
  }));
}

// ───────────────────────────────── 画面の更新

function render() {
  const s = state.situation;
  if (!s) return;
  const t = s.typhoon;

  $('typhoon-name').textContent = t.displayName;
  $('typhoon-kana').textContent = t.japaneseName || t.internationalName || '';
  $('pick-chevron').hidden = (s.available || []).length < 2;

  const badge = $('data-badge');
  badge.textContent = state.status === 'cached' ? '保存データ' : '実データ';
  badge.classList.toggle('warn', state.status === 'cached');

  const obs = s.observation;
  const parts = [];
  if (t.qualifier) parts.push(t.qualifier);
  parts.push(`実況 ${Math.round(obs.pressure)} hPa`);
  if (obs.maxWind > 0) parts.push(`最大風速 ${Math.round(obs.maxWind)} m/s`);
  if (obs.movement) parts.push(obs.movement);
  $('observation').textContent = parts.join(' ・ ');

  const initial = state.tracks ? state.tracks.initialTime : obs.analysisTime;
  $('initial-time').textContent = TimeFormat.short(initial);

  const maxLead = state.tracks
    ? Math.max(...state.tracks.models.map(m => m.points.at(-1).leadHours)) : 120;
  const slider = $('slider');
  slider.max = maxLead;
  if (state.leadHours > maxLead) state.leadHours = 0;
  slider.value = state.leadHours;

  $('lead-label').textContent = TimeFormat.lead(state.leadHours);
  $('chip-lead').textContent = TimeFormat.lead(state.leadHours);
  $('chip-time').textContent = TimeFormat.long(
    new Date(initial.getTime() + state.leadHours * 3600000));

  renderTicks(maxLead);
  renderChips();
  renderAgreement();
  renderPressure();
  renderEnsembleCard();
  renderEntries();
  renderPressureStrip();
  drawMap();
}

function renderTicks(maxLead) {
  const box = $('ticks');
  box.innerHTML = '';
  for (let h = 0; h <= maxLead; h += 24) {
    const b = document.createElement('button');
    b.textContent = h === 0 ? '現在' : `+${h}h`;
    b.className = Math.abs(state.leadHours - h) < 0.5 ? 'on' : '';
    b.onclick = () => { stopPlay(); state.leadHours = h; render(); };
    box.appendChild(b);
  }
}

function swatch(def, inkColor) {
  return `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2"
    stroke="${inkColor || def.color}" stroke-width="2.5" stroke-linecap="round"
    ${def.dash ? `stroke-dasharray="${def.dash}"` : ''}/></svg>`;
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  const add = (label, value, color, def) => {
    const b = document.createElement('button');
    const on = state.selection === value;
    b.className = on ? 'on' : '';
    if (on) b.style.background = color;
    b.innerHTML = (def ? swatch(def, on ? cssVar('--accent-ink') : def.color) : '')
      + `<span>${label}</span>`;
    b.onclick = () => { state.selection = value; render(); };
    box.appendChild(b);
  };
  add('全モデル', 'all', cssVar('--accent'), null);
  const available = state.tracks ? state.tracks.models.map(m => m.id) : [];
  for (const m of MODELS) {
    if (available.length && !available.includes(m.id)) continue;
    add(m.short, m.id, m.color, m);
  }

  // 気象庁の公式予報。モデルの選択とは意味が違うので仕切りを入れて色も分ける。
  if (state.situation && state.situation.official) {
    const sep = document.createElement('i');
    sep.className = 'sep';
    box.appendChild(sep);
    const b = document.createElement('button');
    const c = cssVar('--observation');
    b.className = state.showOfficial ? 'on' : '';
    b.style.background = state.showOfficial ? c : '';
    b.style.color = state.showOfficial ? cssVar('--accent-ink') : c;
    b.style.borderColor = state.showOfficial ? 'transparent' : c;
    b.textContent = '気象庁 予報円';
    b.onclick = () => { state.showOfficial = !state.showOfficial; render(); };
    box.appendChild(b);
  }
}

function renderAgreement() {
  const a = state.tracks ? Agreement.at(state.tracks.models, state.leadHours) : null;
  $('agree-lead').textContent = TimeFormat.lead(state.leadHours);
  if (!a) {
    $('agree-percent').textContent = '—';
    $('agree-label').textContent = '';
    $('agree-spread').textContent = '';
    $('agree-bar').style.width = '0';
    return;
  }
  const color = a.level === 'high' ? cssVar('--good')
    : a.level === 'medium' ? cssVar('--caution') : cssVar('--bad');
  $('agree-percent').textContent = a.percent;
  $('agree-percent').style.color = color;
  $('agree-label').textContent = a.label;
  $('agree-label').style.color = color;
  $('agree-spread').textContent = `ばらつき 平均 ${Math.round(a.meanKm)} km`;
  const bar = $('agree-bar');
  bar.style.width = `${Math.max(2, a.score * 100)}%`;
  bar.style.background = color;
  $('agree-note').textContent =
    `※ 到達確率ではありません。${a.count}モデルの予測位置のばらつきを表す指標です。`;
}

function renderPressure() {
  $('pressure-lead').textContent = TimeFormat.lead(state.leadHours);
  const box = $('pressure-cells');
  box.innerHTML = '';
  if (!state.tracks) { $('pressure-chart').innerHTML = ''; return; }
  for (const model of state.tracks.models) {
    const def = modelById[model.id];
    const on = state.selection === 'all' || state.selection === model.id;
    const p = interpolate(model, state.leadHours);
    const cell = document.createElement('div');
    cell.className = 'cell' + (on ? '' : ' off');
    cell.innerHTML =
      `<i style="background:${def.color};opacity:${on ? 1 : .25}"></i>` +
      `<u style="color:${on ? def.color : cssVar('--text3')}">${def.short}</u>` +
      (p ? `<b>${Math.round(p.pressure)}</b><s>hPa</s>`
         : `<b style="color:${cssVar('--text3')}">—</b><s>追跡終了</s>`);
    box.appendChild(cell);
  }
  $('pressure-chart').innerHTML = pressureChartSVG();
}

// 畳んだ状態でも中心気圧が読めるようにする帯
function renderPressureStrip() {
  const strip = $('strip-pressure');
  if (isWide() || state.panelOpen || !state.tracks) { strip.hidden = true; return; }
  strip.hidden = false;
  let html = '';
  for (const model of state.tracks.models) {
    const def = modelById[model.id];
    const p = interpolate(model, state.leadHours);
    html += `<span class="ps-item">
      <u style="color:${def.color}">${def.short}</u>
      <b${p ? '' : ` style="color:${cssVar('--text3')}"`}>${p ? Math.round(p.pressure) : '—'}</b>
    </span>`;
  }
  const a = Agreement.at(state.tracks.models, state.leadHours);
  if (a) {
    const color = a.level === 'high' ? cssVar('--good')
      : a.level === 'medium' ? cssVar('--caution') : cssVar('--bad');
    html += `<span class="ps-agree"><u>一致度</u><b style="color:${color}">${a.percent}%</b></span>`;
  }
  strip.innerHTML = html;
}

// 中心気圧の折れ線。依存を増やさないよう SVG を自前で組む。
function pressureChartSVG() {
  const models = state.tracks.models;
  const all = models.flatMap(m => m.points.map(p => p.pressure));
  if (!all.length) return '';
  const maxLead = Math.max(...models.map(m => m.points.at(-1).leadHours));
  const lo = Math.min(...all) - 6, hi = Math.max(...all) + 6;
  const W = 320, H = 92, L = 30, R = 16, T = 6, B = 18;
  const x = h => L + (W - L - R) * (h / Math.max(maxLead, 1));
  const y = v => T + (H - T - B) * (1 - (v - lo) / Math.max(hi - lo, 1));

  let out = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
  for (let i = 0; i <= 2; i++) {
    const v = lo + (hi - lo) * i / 2;
    out += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${cssVar('--border')}" stroke-width="1"/>`;
    out += `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="${cssVar('--text3')}">${Math.round(v)}</text>`;
  }
  for (let h = 0; h <= maxLead; h += 24) {
    out += `<text x="${x(h)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="${cssVar('--text3')}">${h === 0 ? '現在' : '+' + h}</text>`;
  }
  for (const model of models) {
    const def = modelById[model.id];
    const on = state.selection === 'all' || state.selection === model.id;
    const d = model.points.map((p, i) =>
      `${i ? 'L' : 'M'}${x(p.leadHours).toFixed(1)},${y(p.pressure).toFixed(1)}`).join('');
    out += `<path d="${d}" fill="none" stroke="${def.color}" stroke-width="${on ? 2 : 1.4}"
      stroke-opacity="${on ? 1 : .18}" stroke-linecap="round" stroke-linejoin="round"
      ${def.dash ? `stroke-dasharray="${def.dash}"` : ''}/>`;
  }
  out += `<line x1="${x(state.leadHours)}" y1="${T}" x2="${x(state.leadHours)}" y2="${H - B}"
    stroke="${cssVar('--accent')}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 3"/>`;
  return out + '</svg>';
}

// ───────────────────────────────── アンサンブル

function renderEnsembleCard() {
  const sys = ENSEMBLES.find(e => e.id === state.ensembleSystem);
  $('ens-pick').textContent = sys.label + ' ▾';
  const box = $('ensemble-body');
  const color = modelById[sys.base].color;

  if (state.ensembleBusy) {
    box.innerHTML = `<div class="tracking" style="padding:10px 0">
      <span class="spinner"></span><div><b>${state.ensembleError || '取得しています'}</b></div></div>`;
    return;
  }
  if (state.ensemble) {
    const sp = Ensemble.spread(state.ensemble, state.leadHours);
    box.innerHTML =
      `<div class="ens-value">
        <b style="color:${color}">${sp ? Math.round(sp.km) : '—'}</b><span style="color:${color}">km</span>
        <small>${sp ? (sp.live === sp.total ? `${sp.total} メンバー` : `${sp.total} 中 ${sp.live} 本`) : ''}<br>${TimeFormat.lead(state.leadHours)} の散らばり</small>
      </div>
      <p class="note">※ ${sys.label} 1モデルの中での振れ幅です。モデル一致度（機関どうしの食い違い）とは別物です。追跡が途中で終わったメンバーは数に入りません。</p>
      <button class="ens-clear" id="ens-clear">地図から消す</button>`;
    $('ens-clear').onclick = () => { state.ensemble = null; render(); };
    return;
  }
  box.innerHTML =
    `<p class="note" style="font-size:11px">同じモデルを条件を変えて何十回も走らせた結果を、まとめて地図に重ねます。</p>
     ${state.ensembleError ? `<p class="warn" style="font-size:11px">${state.ensembleError}</p>` : ''}
     <button class="ens-load" id="ens-load" style="background:${color}">${sys.label} を読み込む（通信量 大）</button>`;
  $('ens-load').onclick = loadEnsemble;
}

async function loadEnsemble() {
  if (!state.tracks) return;
  const sys = ENSEMBLES.find(e => e.id === state.ensembleSystem);
  state.ensembleBusy = true; state.ensembleError = null; state.ensemble = null;
  renderEnsembleCard();
  try {
    state.ensemble = await Ensemble.run(sys, state.situation.observation, state.tracks,
      msg => { state.ensembleError = msg; renderEnsembleCard(); });
    state.ensembleError = null;
  } catch (e) {
    state.ensemble = null;
    state.ensembleError = e.message || String(e);
  } finally {
    state.ensembleBusy = false;
    render();
  }
}

// ───────────────────────────────── 入口カード

function renderEntries() {
  $('site-sub').textContent = state.siteData
    ? `${state.siteData.site.name} の予測を5モデルで比べています`
    : '街を選んで、各モデルの風と雨を比べます';

  const code = state.situation ? state.situation.typhoon.code : null;
  const results = code ? Verification.against(state.situation.observation, code) : [];
  const summary = Verification.summary();
  const stored = Archive.all().length;
  $('verify-sub').textContent =
    results.length ? `${results.length}回ぶんの予報を実況と比べられます`
    : summary.comparisons ? `これまでの平均を${summary.comparisons}回ぶん集計しています`
    : stored ? `保存した予報が${stored}件。答え合わせできるのは数時間後です`
    : '使うたびに予報を貯めていきます';
}

// ───────────────────────────────── 地点ごとの風と雨

function openSiteSheet() {
  $('site-sheet').hidden = false;
  if (!state.site) state.site = DEFAULT_SITES.find(s => s.name === '東京');
  renderSiteSheet();
  if (!state.siteData || state.siteData.site.name !== state.site.name) loadSite();
}

async function loadSite() {
  state.siteBusy = true; state.siteError = null;
  renderSiteSheet();
  try {
    state.siteData = await SiteData.fetch(state.site);
  } catch (e) {
    state.siteData = null;
    state.siteError = e.message || String(e);
  } finally {
    state.siteBusy = false;
    renderSiteSheet();
    renderEntries();
  }
}

function renderSiteSheet() {
  $('site-name').textContent = state.site ? state.site.name : '—';

  const seg = $('element-seg');
  seg.innerHTML = '';
  for (const e of ELEMENTS) {
    const b = document.createElement('button');
    b.textContent = e.label;
    b.className = state.element === e.id ? 'on' : '';
    b.onclick = () => { state.element = e.id; renderSiteSheet(); };
    seg.appendChild(b);
  }

  const box = $('site-content');
  if (state.siteError) {
    box.innerHTML = `<section class="card"><p class="warn">${state.siteError}</p></section>`;
    return;
  }
  if (state.siteBusy || !state.siteData) {
    box.innerHTML = `<section class="card"><div class="tracking" style="padding:4px 0">
      <span class="spinner"></span><div><b>${state.site ? state.site.name : ''} の予測を取得しています</b></div>
    </div></section>`;
    return;
  }

  const el = ELEMENTS.find(e => e.id === state.element);
  let html = `<section class="card">
    <div class="card-head"><span>${el.label}</span><small>${el.unit}</small></div>
    <div class="chart">${siteChartSVG(el)}</div>
  </section>
  <section class="card"><div class="card-head"><span>${el.peak}とその時刻</span></div>`;
  for (const m of MODELS) {
    const peak = SiteData.peak(state.siteData, el.id, m.id);
    html += `<div class="peak-row">${swatch(m)}<u style="color:${m.color}">${m.short}</u>` +
      (peak
        ? `<b>${peak.value >= 10 ? Math.round(peak.value) : peak.value.toFixed(1)}</b><s>${el.unit}</s>
           <small>${TimeFormat.short(peak.time)}</small>`
        : `<small style="margin-left:0">データなし</small>`) +
      `</div>`;
  }
  box.innerHTML = html + '</section>';
}

function siteChartSVG(el) {
  const d = state.siteData;
  const max = Math.max(1, SiteData.max(d, el.id) * 1.15);
  const W = 320, H = 150, L = 28, R = 10, T = 8, B = 20;
  const n = d.times.length;
  const x = i => L + (W - L - R) * (i / Math.max(n - 1, 1));
  const y = v => T + (H - T - B) * (1 - v / max);

  let out = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:150px">`;
  for (let i = 0; i <= 2; i++) {
    const v = max * i / 2;
    out += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${cssVar('--border')}" stroke-width="1"/>`;
    out += `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="${cssVar('--text3')}">${Math.round(v)}</text>`;
  }
  d.times.forEach((t, i) => {
    if (t.getHours() !== 0) return;
    out += `<line x1="${x(i)}" y1="${T}" x2="${x(i)}" y2="${H - B}" stroke="${cssVar('--border')}" stroke-width="1"/>`;
    out += `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="${cssVar('--text3')}">${TimeFormat.day(t)}</text>`;
  });
  for (const m of MODELS) {
    const series = d.values[el.id][m.id] || [];
    let path = '', pen = false;
    series.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (path) {
      out += `<path d="${path}" fill="none" stroke="${m.color}" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round"
        ${m.dash ? `stroke-dasharray="${m.dash}"` : ''}/>`;
    }
  }
  const now = Date.now();
  const idx = d.times.findIndex(t => t.getTime() >= now);
  if (idx > 0) {
    out += `<line x1="${x(idx)}" y1="${T}" x2="${x(idx)}" y2="${H - B}"
      stroke="${cssVar('--accent')}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 3"/>`;
  }
  return out + '</svg>';
}

// ───────────────────────────────── 予報の振り返り

function openVerifySheet() {
  $('verify-sheet').hidden = false;
  const box = $('verify-content');
  const code = state.situation ? state.situation.typhoon.code : null;
  const results = code ? Verification.against(state.situation.observation, code) : [];
  const summary = Verification.summary();
  let html = '';

  const rowsHTML = (rows, official, worst) => {
    let h = '';
    for (const r of rows) {
      const def = modelById[r.id];
      const best = r.id === rows[0].id;
      h += `<div class="verify-row"><u style="color:${def.color}">${def.short}</u>
        <span class="vbar"><i style="width:${Math.max(4, 100 * Math.min(1, r.km / worst))}%;background:${def.color};opacity:${best ? 1 : .6}"></i></span>
        <b${best ? '' : ` style="color:${cssVar('--text2')}"`}>${Math.round(r.km)} km</b></div>`;
    }
    if (official != null) {
      const c = cssVar('--observation');
      h += `<div class="verify-row" style="border-top:1px solid ${cssVar('--border')};margin-top:6px;padding-top:8px">
        <u style="color:${c}">気象庁公式</u>
        <span class="vbar"><i style="width:${Math.max(4, 100 * Math.min(1, official / worst))}%;background:${c};opacity:.8"></i></span>
        <b style="color:${cssVar('--text2')}">${Math.round(official)} km</b></div>`;
    }
    return h;
  };

  if (summary.buckets.length) {
    html += `<h3 style="margin:4px 0 8px">これまでの平均（台風${summary.typhoons}個 / ${summary.comparisons}回ぶん）</h3>`;
    for (const b of summary.buckets) {
      const worst = Math.max(...b.rows.map(r => r.km), b.official || 0, 1);
      html += `<section class="card">
        <div class="card-head"><span>${b.lo}〜${b.hi}時間</span></div>
        ${rowsHTML(b.rows, b.official, worst)}
      </section>`;
    }
  }

  if (results.length) {
    html += `<h3 style="margin:14px 0 8px">いまの台風での答え合わせ</h3>`;
    for (const r of results) {
      const worst = Math.max(...r.rows.map(x => x.km), r.official || 0, 1);
      html += `<section class="card">
        <div class="card-head"><span>${Math.round(r.leadHours)}時間前の予報</span></div>
        <p class="note" style="margin:2px 0 8px">初期時刻 ${TimeFormat.short(r.initialTime)}　→　実況 ${TimeFormat.short(r.verifiedAt)}</p>
        ${rowsHTML(r.rows, r.official, worst)}
      </section>`;
    }
  }

  if (!html) {
    const stored = Archive.all().length;
    html = `<section class="card">
      <p><b>まだ比べられる予報がありません</b></p>
      <p class="sub">${stored
        ? `予報を${stored}件ためています。初期時刻から数時間経つと、実況と比べられるようになります。`
        : '開いて予報を取るたびに、その予報をこの端末に残していきます。時間が経ってからまたここを見てください。'}</p>
    </section>`;
  }
  box.innerHTML = html;
}

// ───────────────────────────────── 読み込み

function setNotice(text) {
  const n = $('notice');
  n.hidden = !text;
  n.textContent = text || '';
}

function setTracking(on, title, detail) {
  $('tracking').hidden = !on;
  $('control-body').hidden = on;
  if (title) $('tracking-title').textContent = title;
  if (detail) $('tracking-detail').textContent = detail;
}

function showApp() {
  $('splash').style.display = 'none';
  $('app').hidden = false;
  if (!map) initMap();
  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));
}

function showSplash(text, retry) {
  $('splash').style.display = 'flex';
  $('splash-text').textContent = text;
  $('retry-btn').hidden = !retry;
  $('splash').querySelector('.spinner').style.display = retry ? 'none' : 'block';
}

async function load(typhoon) {
  $('refresh-btn').classList.add('busy');
  try {
    // 1. 実況を取る（小さなJSONが2本なので、ここは一瞬で終わる）
    const list = await JMA.activeTyphoons();
    const target = typhoon || (state.situation && state.situation.typhoon) || list[0];
    if (!target) throw new Error('現在、発生している台風はありません。');
    const situation = await JMA.situation(target, list);

    const same = state.situation && state.situation.typhoon.code === situation.typhoon.code;
    state.situation = situation;
    state.status = 'live';
    setNotice(null);
    if (!same) { state.tracks = null; state.ensemble = null; state.leadHours = 0; }
    showApp();
    render();
    if (!state.tracks) fitSoon();

    // 2. 進路の初期時刻は6時間ごとにしか変わらない。
    //    新しい初期値が出ているときだけ重い追跡を走らせる。
    const expected = Tracker.expectedInitialTime(situation.observation.analysisTime);
    if (state.tracks && same && state.tracks.initialTime.getTime() === expected.getTime()) {
      $('updated-time').textContent = TimeFormat.hourMinute(new Date());
      save();
      return;
    }

    if (!state.tracks) setTracking(true, '5モデルの中心を追跡しています', '実況は表示済みです');
    const tracks = await Tracker.run(situation.observation, (i, n) => {
      setTracking(!state.tracks, '5モデルの中心を追跡しています', `取得中 ${i} / ${n}`);
    });
    state.tracks = tracks;
    state.ensemble = null;
    setTracking(false);
    $('updated-time').textContent = TimeFormat.hourMinute(new Date());
    render();
    fitSoon();
    save();
    Archive.save(situation, tracks);

  } catch (e) {
    setTracking(false);
    const message = e.message || String(e);
    if (state.situation) {
      setNotice(`${message} 表示は前回取得したままです。`);
    } else {
      const cached = Store.load();
      if (cached && cached.tracks) {
        state.situation = cached.situation;
        state.tracks = cached.tracks;
        state.status = 'cached';
        showApp();
        setNotice(`${message} 前回取得したデータを表示しています。`);
        render();
        fitSoon();
      } else {
        showSplash(message, true);
      }
    }
  } finally {
    $('refresh-btn').classList.remove('busy');
  }
}

function save() {
  if (!state.situation || !state.tracks) return;
  Store.save({ situation: state.situation, tracks: state.tracks, savedAt: new Date() });
}

// ───────────────────────────────── 操作

function stopPlay() {
  if (state.playing) { clearInterval(state.playing); state.playing = null; }
  $('play-btn').textContent = '▶ 再生';
}

function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  const max = Number($('slider').max);
  if (state.leadHours >= max) state.leadHours = 0;
  $('play-btn').textContent = '❚❚ 停止';
  state.playing = setInterval(() => {
    state.leadHours += 1;
    if (state.leadHours >= max) { state.leadHours = max; stopPlay(); }
    render();
  }, 40);
}

function openMenu(items) {
  const wrap = document.createElement('div');
  wrap.className = 'menu';
  const inner = document.createElement('div');
  inner.className = 'menu-inner';
  for (const item of items) {
    if (item.divider) { inner.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = item.label;
    if (item.on) b.className = 'on';
    b.onclick = () => { wrap.remove(); item.action(); };
    inner.appendChild(b);
  }
  wrap.appendChild(inner);
  wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}

function renderModelList() {
  const box = $('model-list');
  box.innerHTML = '';
  for (const m of MODELS) {
    const track = state.tracks && state.tracks.models.find(x => x.id === m.id);
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML =
      `<svg width="22" height="6" style="margin-top:6px"><line x1="0" y1="3" x2="22" y2="3"
        stroke="${m.color}" stroke-width="3" stroke-linecap="round"
        ${m.dash ? `stroke-dasharray="${m.dash}"` : ''}/></svg>` +
      `<div><b style="color:${m.color}">${m.short}</b> ${m.name}<small>${m.org}</small>` +
      (track ? `<em>初期時刻 ${TimeFormat.short(track.initialTime)}</em>` : '') +
      (track && track.trackEnd
        ? `<em class="end">+${track.trackEnd.leadHours}時間で追跡終了：${track.trackEnd.reason}</em>` : '') +
      `</div>`;
    box.appendChild(row);
  }
}

// ───────────────────────────────── 起動

function boot() {
  $('slider').addEventListener('input', e => {
    stopPlay();
    state.leadHours = Number(e.target.value);
    render();
  });
  $('play-btn').onclick = togglePlay;
  $('refresh-btn').onclick = () => { stopPlay(); load(); };
  $('fit-btn').onclick = fitMap;
  $('retry-btn').onclick = () => { showSplash('データを読み込んでいます', false); load(); };

  $('typhoon-pick').onclick = () => {
    if (!state.situation) return;
    const list = state.situation.available || [];
    if (list.length < 2) return;
    openMenu(list.map(t => ({
      label: t.displayName + (t.qualifier ? `（${t.qualifier}）` : '')
        + (t.japaneseName ? `　${t.japaneseName}` : ''),
      on: t.code === state.situation.typhoon.code,
      action: () => { stopPlay(); load(t); }
    })));
  };

  const setPanel = open => {
    state.panelOpen = open;
    $('panel').classList.toggle('closed', !open);
    $('handle-label').textContent = open ? 'パネルを畳む' : '一致度・中心気圧を見る';
    renderPressureStrip();
    setTimeout(() => { if (map) { map.invalidateSize(); fitMap(); } }, 280);
  };
  $('handle').onclick = () => setPanel(!state.panelOpen);
  $('strip-pressure').onclick = () => setPanel(true);

  $('ens-pick').onclick = () => openMenu(ENSEMBLES.map(e => ({
    label: `${e.label}（約${e.members}メンバー）`,
    on: e.id === state.ensembleSystem,
    action: () => { state.ensembleSystem = e.id; state.ensemble = null; render(); loadEnsemble(); }
  })));

  $('site-entry').onclick = openSiteSheet;
  $('verify-entry').onclick = openVerifySheet;
  $('about-btn').onclick = () => { renderModelList(); $('about').hidden = false; };
  for (const b of document.querySelectorAll('[data-close]')) {
    b.onclick = () => { $(b.dataset.close).hidden = true; };
  }
  $('clear-archive').onclick = () => {
    Archive.clear(); renderEntries(); $('clear-archive').textContent = '消しました';
  };

  $('site-pick').onclick = () => {
    const items = Sites.all().map(s => ({
      label: s.name, on: state.site && s.name === state.site.name,
      action: () => { state.site = s; loadSite(); }
    }));
    if (state.site && Sites.custom().some(s => s.name === state.site.name)) {
      items.push({ divider: true });
      items.push({
        label: `「${state.site.name}」を消す`,
        action: () => { Sites.remove(state.site.name); state.site = DEFAULT_SITES[7]; loadSite(); }
      });
    }
    openMenu(items);
  };

  $('site-locate').onclick = async () => {
    $('site-locate').textContent = '取得中…';
    const here = await SiteData.current();
    $('site-locate').textContent = '現在地';
    if (!here) {
      state.siteError = '現在地を取得できませんでした。位置情報の許可をご確認ください。';
      renderSiteSheet();
      return;
    }
    state.site = here;
    loadSite();
  };

  $('site-search-btn').onclick = () => {
    const box = $('site-search');
    box.hidden = !box.hidden;
    if (!box.hidden) $('site-query').focus();
  };

  let searchTimer = null;
  $('site-query').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('site-results').innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      const box = $('site-results');
      try {
        const rs = await SiteData.search(q);
        box.innerHTML = '';
        if (!rs.length) { box.innerHTML = `<p class="note">見つかりませんでした。</p>`; return; }
        for (const r of rs) {
          const b = document.createElement('button');
          b.innerHTML = `<span>📍</span><span style="flex:1"><b>${r.name}</b>
            <small>${r.detail} ${r.lat.toFixed(2)}N ${r.lon.toFixed(2)}E</small></span><span>＋</span>`;
          b.onclick = () => {
            const site = { name: r.name, lat: r.lat, lon: r.lon };
            Sites.add(site);
            state.site = site;
            $('site-search').hidden = true;
            $('site-query').value = '';
            box.innerHTML = '';
            loadSite();
          };
          box.appendChild(b);
        }
      } catch {
        box.innerHTML = `<p class="note">探せませんでした。</p>`;
      }
    }, 350);
  });

  window.addEventListener('resize', () => {
    renderPressureStrip();
    if (map) map.invalidateSize();
  });

  setInterval(() => { $('now-time').textContent = TimeFormat.clock(new Date()); }, 1000);
  $('now-time').textContent = TimeFormat.clock(new Date());

  // 残っているデータをすぐ出したうえで、軽い更新をかける
  const cached = Store.load();
  if (cached && cached.tracks) {
    state.situation = cached.situation;
    state.tracks = cached.tracks;
    state.status = 'live';
    showApp();
    render();
    fitSoon();
    $('updated-time').textContent = TimeFormat.hourMinute(cached.savedAt || new Date());
  }
  load();
}

boot();
