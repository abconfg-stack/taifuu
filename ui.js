// 台風モデル比較 — 画面まわり
'use strict';

const $ = id => document.getElementById(id);

const state = {
  situation: null,   // 実況・公式予報・台風一覧
  tracks: null,      // { initialTime, models }
  leadHours: 0,
  selection: 'all',  // 'all' か モデルID
  status: 'live',    // live | cached
  playing: null,
  panelOpen: true
};

// ───────────────────────────────── 地図

let map, layers = { past: null, tracks: [], markers: [], observation: null };

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView([32, 137], 4);
  // 淡い地図。道路や店は出さず、海岸線と地名だけが見えるものを選ぶ。
  // 明るい画面のときは明るい地図に切り替える。
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const base = dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
  L.tileLayer(
    `https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`,
    { maxZoom: 10, minZoom: 2, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }
  ).addTo(map);
}

function clearMap() {
  for (const key of ['past', 'observation']) {
    if (layers[key]) { map.removeLayer(layers[key]); layers[key] = null; }
  }
  for (const group of ['tracks', 'markers']) {
    layers[group].forEach(l => map.removeLayer(l));
    layers[group] = [];
  }
}

function drawMap() {
  if (!state.situation) return;
  clearMap();
  const obs = state.situation.observation;

  // これまでに通ってきた経路
  if (obs.pastTrack && obs.pastTrack.length > 1) {
    layers.past = L.polyline(obs.pastTrack, {
      color: cssVar('--observation'), weight: 1.6, opacity: .45, dashArray: '1 5'
    }).addTo(map);
  }

  // 各モデルの予測進路
  if (state.tracks) {
    for (const model of state.tracks.models) {
      const def = modelById[model.id];
      const on = state.selection === 'all' || state.selection === model.id;
      const line = L.polyline(model.points.map(p => [p.lat, p.lon]), {
        color: def.color, weight: on ? 3.2 : 2, opacity: on ? .95 : .16,
        dashArray: def.dash || null, lineCap: 'round', lineJoin: 'round'
      }).addTo(map);
      layers.tracks.push(line);

      // 12時間ごとの予測地点
      for (const p of model.points) {
        if (p.leadHours % 12 !== 0) continue;
        layers.markers.push(L.circleMarker([p.lat, p.lon], {
          radius: on ? 3 : 2, color: def.color, weight: 0,
          fillColor: def.color, fillOpacity: on ? .9 : .18
        }).addTo(map));
      }

      // スライダーで選んでいる時刻の位置（追跡が終わっていれば置かない）
      const cur = interpolate(model, state.leadHours);
      if (cur) {
        layers.markers.push(L.circleMarker([cur.lat, cur.lon], {
          radius: on ? 7 : 4.5, color: def.color, weight: on ? 2.5 : 1.5,
          fillColor: def.color, fillOpacity: on ? .3 : .12
        }).addTo(map));
      }
    }
  }

  // 台風の現在位置（実況）。予測とは形を変える。
  layers.observation = L.circleMarker([obs.latitude, obs.longitude], {
    radius: 10, color: cssVar('--observation'), weight: 3,
    fillColor: cssVar('--observation'), fillOpacity: .22
  }).addTo(map);
}

// 実況と全モデルの進路が収まる範囲。日付変更線をまたいでも切れないようにする。
function fitMap() {
  if (!state.situation) return;
  const obs = state.situation.observation;
  const base = obs.longitude;
  const unwrap = lon => base + GeoMath.norm(lon - base);
  const pts = [[obs.latitude, base]];
  if (state.tracks) {
    for (const m of state.tracks.models) {
      for (const p of m.points) pts.push([p.lat, unwrap(p.lon)]);
    }
  }
  // 日本が近ければ目印として画面に入れる
  if (Math.abs(GeoMath.norm(135 - base)) < 35) {
    pts.push([31, unwrap(130)], [37, unwrap(141)]);
  }
  const controls = document.querySelector('.controls');
  const bottom = controls && !controls.hidden ? controls.offsetHeight : 0;
  map.fitBounds(L.latLngBounds(pts), {
    animate: true,
    paddingTopLeft: [16, 70],          // 左上の時刻チップを避ける
    paddingBottomRight: [16, bottom + 16] // 下の操作部を避ける
  });
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
    ? Math.max(...state.tracks.models.map(m => m.points.at(-1).leadHours))
    : 120;
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
  drawMap();
}

function renderTicks(maxLead) {
  const box = $('ticks');
  const hours = [];
  for (let h = 0; h <= maxLead; h += 24) hours.push(h);
  box.innerHTML = '';
  for (const h of hours) {
    const b = document.createElement('button');
    b.textContent = h === 0 ? '現在' : `+${h}h`;
    b.className = Math.abs(state.leadHours - h) < 0.5 ? 'on' : '';
    b.onclick = () => { stopPlay(); state.leadHours = h; render(); };
    box.appendChild(b);
  }
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  const add = (label, value, color, def) => {
    const b = document.createElement('button');
    b.className = state.selection === value ? 'on' : '';
    if (state.selection === value) b.style.background = color;
    if (def) {
      const svg = `<svg width="16" height="4"><line x1="0" y1="2" x2="16" y2="2"
        stroke="${state.selection === value ? cssVar('--accent-ink') : color}"
        stroke-width="2.5" stroke-linecap="round"
        ${def.dash ? `stroke-dasharray="${def.dash}"` : ''}/></svg>`;
      b.innerHTML = svg + `<span>${label}</span>`;
    } else {
      b.textContent = label;
    }
    b.onclick = () => { state.selection = value; render(); };
    box.appendChild(b);
  };
  add('全モデル', 'all', cssVar('--accent'), null);
  const available = state.tracks ? state.tracks.models.map(m => m.id) : [];
  for (const m of MODELS) {
    if (available.length && !available.includes(m.id)) continue;
    add(m.short, m.id, m.color, m);
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
  // 横線と気圧の目盛り
  for (let i = 0; i <= 2; i++) {
    const v = lo + (hi - lo) * i / 2;
    out += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"
            stroke="${cssVar('--border')}" stroke-width="1"/>`;
    out += `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end"
            font-size="9" fill="${cssVar('--text3')}">${Math.round(v)}</text>`;
  }
  // 予報時間の目盛り
  for (let h = 0; h <= maxLead; h += 24) {
    out += `<text x="${x(h)}" y="${H - 5}" text-anchor="middle"
            font-size="9" fill="${cssVar('--text3')}">${h === 0 ? '現在' : '+' + h}</text>`;
  }
  // 各モデルの線
  for (const model of models) {
    const def = modelById[model.id];
    const on = state.selection === 'all' || state.selection === model.id;
    const d = model.points.map((p, i) =>
      `${i ? 'L' : 'M'}${x(p.leadHours).toFixed(1)},${y(p.pressure).toFixed(1)}`).join('');
    out += `<path d="${d}" fill="none" stroke="${def.color}" stroke-width="${on ? 2 : 1.4}"
            stroke-opacity="${on ? 1 : .18}" stroke-linecap="round" stroke-linejoin="round"
            ${def.dash ? `stroke-dasharray="${def.dash}"` : ''}/>`;
  }
  // いま見ている予報時間
  out += `<line x1="${x(state.leadHours)}" y1="${T}" x2="${x(state.leadHours)}" y2="${H - B}"
          stroke="${cssVar('--accent')}" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 3"/>`;
  return out + '</svg>';
}

// ───────────────────────────────── 読み込み

function setNotice(text) {
  const n = $('notice');
  n.hidden = !text;
  n.textContent = text || '';
}

function setTracking(on, detail) {
  $('tracking').hidden = !on;
  $('control-body').hidden = on;
  if (detail) $('tracking-detail').textContent = detail;
}

function showApp() {
  $('splash').style.display = 'none';
  $('app').hidden = false;
  if (!map) { initMap(); }
  // 画面の大きさが決まってから地図に伝える
  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));
}

// 読み込み直後やパネルの開け閉めのあとは、大きさが決まるのを待ってから合わせる
function fitSoon() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    map.invalidateSize();
    fitMap();
  }));
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
    const target = typhoon || state.situation && state.situation.typhoon || list[0];
    if (!target) throw new Error('現在、発生している台風はありません。');
    const situation = await JMA.situation(target, list);

    const sameTyphoon = state.situation && state.situation.typhoon.code === situation.typhoon.code;
    state.situation = situation;
    state.status = 'live';
    setNotice(null);
    if (!sameTyphoon) { state.tracks = null; state.leadHours = 0; }
    showApp();
    render();
    if (!state.tracks) fitSoon();

    // 2. 進路の初期時刻は6時間ごとにしか変わらない。
    //    新しい初期値が出ているときだけ重い追跡を走らせる。
    const expected = Tracker.expectedInitialTime(situation.observation.analysisTime);
    if (state.tracks && sameTyphoon &&
        state.tracks.initialTime.getTime() === expected.getTime()) {
      $('updated-time').textContent = TimeFormat.hourMinute(new Date());
      save();
      return;
    }

    if (!state.tracks) setTracking(true, '実況は表示済みです。進路はもう少しお待ちください');
    const tracks = await Tracker.run(situation.observation, (i, n) => {
      setTracking(!state.tracks, `取得中 ${i} / ${n}`);
    });
    state.tracks = tracks;
    setTracking(false);
    $('updated-time').textContent = TimeFormat.hourMinute(new Date());
    render();
    fitSoon();
    save();

  } catch (e) {
    setTracking(false);
    const message = e.message || String(e);
    if (state.situation) {
      setNotice(`${message} 表示は前回取得したままです。`);
    } else {
      const cached = Store.load();
      if (cached) {
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

function openMenu() {
  const list = (state.situation.available || []).filter(t => t.code);
  if (list.length < 2) return;
  const wrap = document.createElement('div');
  wrap.className = 'menu';
  const inner = document.createElement('div');
  inner.className = 'menu-inner';
  for (const t of list) {
    const b = document.createElement('button');
    const name = t.japaneseName || t.internationalName || '';
    b.textContent = t.displayName + (t.qualifier ? `（${t.qualifier}）` : '') + (name ? `　${name}` : '');
    b.className = t.code === state.situation.typhoon.code ? 'on' : '';
    b.onclick = () => { wrap.remove(); stopPlay(); load(t); };
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
      `<div><b style="color:${m.color}">${m.short}</b> ${m.name}` +
      `<small>${m.org}</small>` +
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
  $('typhoon-pick').onclick = () => state.situation && openMenu();
  $('retry-btn').onclick = () => { showSplash('データを読み込んでいます', false); load(); };

  $('handle').onclick = () => {
    state.panelOpen = !state.panelOpen;
    $('panel').classList.toggle('closed', !state.panelOpen);
    $('handle-label').textContent = state.panelOpen ? 'パネルを畳む' : '一致度・中心気圧を見る';
    setTimeout(() => { if (map) { map.invalidateSize(); fitMap(); } }, 280);
  };

  $('about-btn').onclick = () => { renderModelList(); $('about').hidden = false; };
  $('about-close').onclick = () => { $('about').hidden = true; };

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
