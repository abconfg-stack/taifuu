// 台風モデル比較 — Web版
//
// iOS版と同じ考え方で動く。各気象機関のモデルが出した海面気圧から
// 台風の中心を追って、進路を地図に重ねる。
// 独自の予報ではなく、気象庁の公式予報とも別物として扱う。

'use strict';

// ───────────────────────────────── 緯度経度の計算

const GeoMath = {
  R: 6371,

  // 経度を -180〜180 に直す。台風が日付変更線をまたぐことがある。
  norm(lon) {
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return lon;
  },

  // 2地点の大円距離（km）
  distanceKm(a, b) {
    const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    const dLat = (b[0] - a[0]) * Math.PI / 180;
    const dLon = GeoMath.norm(b[1] - a[1]) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * GeoMath.R * Math.asin(Math.min(1, Math.sqrt(h)));
  },

  // 地点群のまんなか。日付変更線をまたいでも正しく出せるよう、
  // 先頭を基準に経度をつなげてから平均する。
  centroid(points) {
    if (!points.length) return null;
    const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
    const ref = points[0][1];
    const lons = points.map(p => ref + GeoMath.norm(p[1] - ref));
    return [lat, GeoMath.norm(lons.reduce((s, v) => s + v, 0) / lons.length)];
  }
};

// ───────────────────────────────── モデルの定義

const MODELS = [
  { id: 'ecmwf', om: 'ecmwf_ifs025', short: 'ECMWF', name: 'IFS (HRES)',   org: 'ECMWF（欧州中期予報センター）', color: '#ff7350', dash: '' },
  { id: 'gfs',   om: 'gfs_global',   short: 'GFS',   name: 'GFS',          org: 'NOAA / NCEP（米国）',           color: '#40c7f2', dash: '10 5' },
  { id: 'gsm',   om: 'jma_gsm',      short: 'GSM',   name: '全球モデル GSM', org: '気象庁',                       color: '#ffcc40', dash: '2 5' },
  { id: 'icon',  om: 'icon_global',  short: 'ICON',  name: 'ICON Global',  org: 'DWD（ドイツ気象局）',           color: '#5cdb8c', dash: '12 4 3 4' },
  { id: 'gem',   om: 'gem_global',   short: 'GEM',   name: 'GEM / GDPS',   org: 'CCMEP（カナダ気象センター）',    color: '#ba8cff', dash: '18 6' }
];
const modelById = Object.fromEntries(MODELS.map(m => [m.id, m]));

// ───────────────────────────────── 通信

const HTTP = {
  // 一時的な失敗は少し待って繰り返す。
  // 格子を何回かに分けて取ると、配信元の毎分の上限に当たることがある。
  retryDelays: [3000, 10000, 20000],

  async json(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) {
          throw { temporary: true, message: `配信元が混んでいます（${res.status}）` };
        }
        if (!res.ok) throw { temporary: false, message: `取得できませんでした（${res.status}）` };
        const data = await res.json();
        // Open-Meteo は上限などを本文の error に入れて返してくる
        if (data && data.error === true) {
          throw { temporary: true, message: data.reason || '配信元からの返答' };
        }
        return data;
      } catch (e) {
        const temporary = e && e.temporary;
        if (temporary && attempt < HTTP.retryDelays.length) {
          await new Promise(r => setTimeout(r, HTTP.retryDelays[attempt]));
          continue;
        }
        if (e instanceof TypeError) throw new Error('ネットワークにつながりません。');
        throw new Error(e.message || String(e));
      }
    }
  }
};

// ───────────────────────────────── 気象庁：実況と公式予報

const JMA = {
  base: 'https://www.jma.go.jp/bosai/typhoon/data',

  compass: {
    '北': 0, '北北東': 22.5, '北東': 45, '東北東': 67.5,
    '東': 90, '東南東': 112.5, '南東': 135, '南南東': 157.5,
    '南': 180, '南南西': 202.5, '南西': 225, '西南西': 247.5,
    '西': 270, '西北西': 292.5, '北西': 315, '北北西': 337.5
  },

  // "2625" から号数の 25 を取り出す。
  // まだ番号が付いていない熱帯低気圧は "b" のような記号が来るので 0 を返す。
  typhoonNumber(text) {
    const digits = String(text || '').replace(/\D/g, '');
    if (!digits) return 0;
    return digits.length >= 2 ? parseInt(digits.slice(-2), 10) : parseInt(digits, 10);
  },

  categoryName(code, fallback) {
    if (fallback) return fallback;
    if (['TY', 'STS', 'TS'].includes(code)) return '台風';
    if (code === 'TD') return '熱帯低気圧';
    if (code === 'LOW' || code === 'L') return '温帯低気圧';
    return '低気圧';
  },

  identity(code, numberText, categoryCode, names, categoryJp) {
    const number = JMA.typhoonNumber(numberText);
    const isTyphoon = ['TY', 'STS', 'TS'].includes(categoryCode);
    const categoryName = JMA.categoryName(categoryCode, categoryJp);
    return {
      code,
      number,
      categoryCode,
      categoryName,
      japaneseName: names && names.jp || null,
      internationalName: (names && names.en || '').toUpperCase(),
      displayName: isTyphoon && number > 0 ? `台風第${number}号` : (categoryName || '熱帯低気圧'),
      // 台風から温帯低気圧に変わったときなどの補足
      qualifier: !isTyphoon && number > 0 ? `もと台風第${number}号` : null
    };
  },

  async activeTyphoons() {
    const rows = await HTTP.json(`${JMA.base}/targetTc.json`);
    return (rows || []).map(r =>
      JMA.identity(r.tropicalCyclone, r.typhoonNumber, r.category || '', null, null));
  },

  async situation(typhoon, known) {
    const parts = await HTTP.json(`${JMA.base}/${typhoon.code}/specifications.json`);
    const title = parts.find(p => p.part === 'title');
    let identity = typhoon;
    if (title) {
      identity = JMA.identity(
        typhoon.code, title.typhoonNumber,
        (title.category && title.category.en) || typhoon.categoryCode,
        title.name, title.category && title.category.jp);
    }

    const analysis = parts.find(p => p.part && p.part.en === 'Analysis');
    if (!analysis) throw new Error('実況が見つかりません。');

    const [lat, lon] = analysis.position.deg;
    const speedText = analysis.speed && analysis.speed['km/h'];
    const speed = parseFloat(speedText);
    const course = analysis.course || '';
    const wind = analysis.maximumWind && analysis.maximumWind.sustained;

    let movement = course;
    if (speedText) movement = isNaN(speed) ? `${course} ${speedText}` : `${course} ${speedText}km/h`;

    const extra = await JMA.forecastFile(typhoon.code);

    return {
      typhoon: identity,
      available: (known || []).map(t => t.code === identity.code ? identity : t),
      observation: {
        analysisTime: new Date(analysis.validtime.UTC),
        latitude: lat,
        longitude: lon,
        pressure: parseFloat(analysis.pressure) || 1000,
        maxWind: wind ? parseFloat(wind['m/s']) || 0 : 0,
        movement,
        courseDegrees: course in JMA.compass ? JMA.compass[course] : null,
        speed: isNaN(speed) ? null : speed,
        pastTrack: extra.pastTrack
      },
      official: extra.official
    };
  },

  // forecast.json には、これまでの経路と気象庁の公式予報の両方が入っている。
  async forecastFile(code) {
    try {
      const parts = await HTTP.json(`${JMA.base}/${code}/forecast.json`);
      let pastTrack = [];
      const analysis = parts.find(p => p.part && p.part.en === 'Analysis');
      if (analysis && analysis.track) {
        pastTrack = [...(analysis.track.preTyphoon || []), ...(analysis.track.typhoon || [])];
      }
      const points = parts
        .filter(p => p.probabilityCircle && p.center && typeof p.advancedHours === 'number')
        .map(p => ({
          leadHours: p.advancedHours,
          time: new Date(p.validtime.UTC),
          center: p.center,
          radius: p.probabilityCircle.radius || null,
          stormRadius: p.stormWarningArea && p.stormWarningArea.arc
            && p.stormWarningArea.arc[0] && p.stormWarningArea.arc[0][1] || null
        }))
        .sort((a, b) => a.leadHours - b.leadHours);
      return { pastTrack, official: points.length ? { points } : null };
    } catch {
      return { pastTrack: [], official: null };
    }
  }
};

// ───────────────────────────────── 中心の追跡
//
// 各機関は台風の「進路」そのものを一般には配信していない。
// 配信されているのは格子点ごとの気象要素なので、
// そこから中心（気圧の谷の底）を探すのはこのアプリの側の仕事になる。
// ここで出る進路は各機関が公表した公式のモデル進路ではなく、推定である。

const Tracker = {
  stepHours: 6,
  maxLeadHours: 120,
  searchRadiusKm: 550,
  maxStepKm: 750,
  ringInnerKm: 250,
  ringOuterKm: 650,
  requiredDepth: 1.5,
  maxAnalysisAgeHours: 24,

  stages: [
    { from: 0,  to: 24,  days: 3 },
    { from: 24, to: 48,  days: 4 },
    { from: 48, to: 72,  days: 5 },
    { from: 72, to: 96,  days: 6 },
    { from: 96, to: 120, days: 7 }
  ],

  // モデルの時刻の並びは 00/06/12/18Z の刻みで、当日の 00Z より前には遡れない。
  // 実況の時刻にいちばん近い刻みを初期時刻とする。
  expectedInitialTime(analysisTime) {
    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const step = Tracker.stepHours * 3600 * 1000;
    const snapped = dayStart + Math.round((analysisTime.getTime() - dayStart) / step) * step;
    return new Date(Math.max(snapped, dayStart));
  },

  // 進行方向に沿った帯状の探索範囲。
  // 速く動く低気圧ほど持続外挿から外れる幅も大きいので、
  // 進んだ距離に比例して広げないと転向や加速に付いていけない。
  corridor(anchor, movePerStep, fromHours, toHours, spreadDeg, speed, maxCells = 220) {
    let spacing = 1.0;
    for (;;) {
      const cells = new Set();
      let step = 0;
      for (let hour = fromHours; hour <= toHours; hour += Tracker.stepHours) {
        const clat = anchor[0] + movePerStep[0] * step;
        const clon = anchor[1] + movePerStep[1] * step;
        const travelled = speed * (hour - fromHours) / 111;
        const radius = Math.max(3.5, spreadDeg + 2.0 + 0.6 * travelled);
        const n = Math.max(1, Math.round(radius / spacing));
        const bi = Math.round(clat / spacing), bj = Math.round(clon / spacing);
        for (let i = -n; i <= n; i++) {
          for (let j = -n; j <= n; j++) {
            if (i * i + j * j > n * n) continue;
            if (Math.abs((bi + i) * spacing) > 89) continue;
            cells.add((bi + i) + ',' + (bj + j));
          }
        }
        step++;
      }
      if (cells.size <= maxCells || spacing > 2.0) {
        const list = [...cells].map(k => k.split(',').map(Number))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return { spacing, cells: list };
      }
      spacing += 0.25;
    }
  },

  async fetchGrid(grid, models, days) {
    const lats = [], lons = [];
    for (const [i, j] of grid.cells) {
      lats.push(Math.round(i * grid.spacing * 100) / 100);
      lons.push(GeoMath.norm(Math.round(j * grid.spacing * 100) / 100));
    }
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lats.join(',')
      + '&longitude=' + lons.join(',')
      + '&hourly=pressure_msl'
      + '&models=' + models.map(m => m.om).join(',')
      + '&forecast_days=' + days
      + '&temporal_resolution=hourly_6&timezone=UTC';
    const raw = await HTTP.json(url);
    const locations = Array.isArray(raw) ? raw : [raw];
    if (locations.length !== grid.cells.length) {
      throw new Error('地点数が合いません。');
    }
    const times = locations[0].hourly.time.map(t => new Date(t + 'Z'));
    const values = {};
    for (const m of models) {
      const key = 'pressure_msl_' + m.om;
      // モデルを1つだけ頼んだときは、キーにモデル名が付かずに返ってくる
      values[m.id] = locations.map(l => l.hourly[key] || l.hourly.pressure_msl || []);
    }
    return { times, values };
  },

  nearestTimeIndex(times, date) {
    let best = 0, gap = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(t.getTime() - date.getTime());
      if (d < gap) { gap = d; best = i; }
    });
    return best;
  },

  // 1ステップぶん進める。
  advance(state, leadHours, modelId, grid, press, timeIndex) {
    if (state.ended) return;

    // 1. 直前の動きから次の位置のあたりをつける
    const guess = [state.lat + (state.moveLat || 0),
                   GeoMath.norm(state.lon + (state.moveLon || 0))];

    // 2. その周りで気圧がいちばん低い升目を探す
    const rows = press.values[modelId];
    let count = 0, bestIndex = -1, bestP = Infinity;
    const coord = n => [grid.cells[n][0] * grid.spacing,
                        GeoMath.norm(grid.cells[n][1] * grid.spacing)];
    for (let n = 0; n < grid.cells.length; n++) {
      const p = rows[n] && rows[n][timeIndex];
      if (p == null) continue;
      if (GeoMath.distanceKm(guess, coord(n)) > Tracker.searchRadiusKm) continue;
      count++;
      if (p < bestP) { bestP = p; bestIndex = n; }
    }
    if (count < 6 || bestIndex < 0) {
      state.ended = { leadHours: state.points.length ? state.points.at(-1).leadHours : 0,
                      reason: 'この先のデータがありません' };
      return;
    }
    const bestCoord = coord(bestIndex);

    // 3. 周りより十分低いか確かめる（低くなければ、もう渦はない）
    let ringSum = 0, ringCount = 0;
    for (let n = 0; n < grid.cells.length; n++) {
      const p = rows[n] && rows[n][timeIndex];
      if (p == null) continue;
      const d = GeoMath.distanceKm(bestCoord, coord(n));
      if (d >= Tracker.ringInnerKm && d <= Tracker.ringOuterKm) { ringSum += p; ringCount++; }
    }
    if (ringCount >= 4 && (ringSum / ringCount) - bestP < Tracker.requiredDepth) {
      state.ended = { leadHours: state.points.length ? state.points.at(-1).leadHours : 0,
                      reason: '低気圧の谷がはっきりしなくなりました' };
      return;
    }

    // 4. 升目より細かい位置を求める（放物線あてはめ）
    //    これをしないと、どのモデルも同じ升目に吸い付いてモデル差が消える
    const [bi, bj] = grid.cells[bestIndex];
    const indexOf = new Map(grid.cells.map((c, n) => [c[0] + ',' + c[1], n]));
    const at = (di, dj) => {
      const n = indexOf.get((bi + di) + ',' + (bj + dj));
      return n === undefined ? null : (rows[n] && rows[n][timeIndex]);
    };
    let lat = bi * grid.spacing, lon = bj * grid.spacing;
    const south = at(-1, 0), north = at(1, 0);
    if (south != null && north != null) {
      const den = south - 2 * bestP + north;
      if (den > 1e-6) lat += grid.spacing * 0.5 * (south - north) / den;
    }
    const west = at(0, -1), east = at(0, 1);
    if (west != null && east != null) {
      const den = west - 2 * bestP + east;
      if (den > 1e-6) lon += grid.spacing * 0.5 * (west - east) / den;
    }
    lon = GeoMath.norm(lon);

    const moved = GeoMath.distanceKm([state.lat, state.lon], [lat, lon]);
    if (moved > Tracker.maxStepKm) {
      state.ended = { leadHours: state.points.length ? state.points.at(-1).leadHours : 0,
                      reason: '中心を見失いました' };
      return;
    }

    state.moveLat = lat - state.lat;
    state.moveLon = GeoMath.norm(lon - state.lon);
    state.lat = lat;
    state.lon = lon;
    state.points.push({ leadHours, lat, lon, pressure: Math.round(bestP * 10) / 10 });
  },

  // 5モデルぶんの進路をまとめて作る。
  async run(observation, onProgress) {
    const step = Tracker.stepHours;
    const speed = observation.speed || 20;
    const bearing = (observation.courseDegrees == null ? 45 : observation.courseDegrees) * Math.PI / 180;
    const latPerHour = speed * Math.cos(bearing) / 111;
    const lonPerHour = speed * Math.sin(bearing) /
      (111 * Math.max(0.2, Math.cos(observation.latitude * Math.PI / 180)));

    // 気象庁の実況は、温帯低気圧に変わったあとなどは更新が止まる。
    // 実況とモデル初期時刻のずれぶん進行方向へ延ばしてから探し始める。
    const initialTime = Tracker.expectedInitialTime(observation.analysisTime);
    const gapHours = Math.max(0, (initialTime - observation.analysisTime) / 3600000);
    if (gapHours > Tracker.maxAnalysisAgeHours) {
      throw new Error(`実況が${Math.round(gapHours)}時間前のものため、モデルの追跡ができません。`);
    }

    const startLat = observation.latitude + latPerHour * gapHours;
    const startLon = GeoMath.norm(observation.longitude + lonPerHour * gapHours);

    const states = {};
    for (const m of MODELS) states[m.id] = { lat: startLat, lon: startLon, points: [], ended: null };

    let moveLat = latPerHour * step, moveLon = lonPerHour * step;
    let anchor = [startLat, startLon], spread = 0, currentSpeed = Math.max(15, speed);
    let baseIndex = null;

    for (let s = 0; s < Tracker.stages.length; s++) {
      const stage = Tracker.stages[s];
      const alive = MODELS.filter(m => !states[m.id].ended);
      if (!alive.length) break;
      if (onProgress) onProgress(s + 1, Tracker.stages.length);

      const grid = Tracker.corridor(anchor, [moveLat, moveLon],
                                    stage.from, stage.to, spread, currentSpeed);
      const press = await Tracker.fetchGrid(grid, alive, stage.days);
      if (baseIndex === null) baseIndex = Tracker.nearestTimeIndex(press.times, initialTime);

      // 最初の区切りだけ0時間から。以降は前の区切りの続きから。
      let hour = stage.from === 0 ? 0 : stage.from + step;
      for (; hour <= stage.to; hour += step) {
        const timeIndex = baseIndex + hour / step;
        for (const m of alive) {
          const st = states[m.id];
          if (st.ended) continue;
          Tracker.advance(st, hour, m.id, grid, press, timeIndex);
          if (hour === 0) {
            // 0時間目に動いたぶんは実況とモデル初期値の差であって6時間ぶんの移動ではない
            st.moveLat = latPerHour * step;
            st.moveLon = lonPerHour * step;
          }
        }
      }

      const tracking = MODELS.filter(m => !states[m.id].ended).map(m => states[m.id]);
      if (!tracking.length) break;
      const alat = tracking.reduce((s2, st) => s2 + st.lat, 0) / tracking.length;
      const ref = tracking[0].lon;
      const alon = GeoMath.norm(
        tracking.reduce((s2, st) => s2 + ref + GeoMath.norm(st.lon - ref), 0) / tracking.length);
      anchor = [alat, alon];
      const moves = tracking.filter(st => st.moveLat != null);
      if (moves.length) {
        moveLat = moves.reduce((s2, st) => s2 + st.moveLat, 0) / moves.length;
        moveLon = moves.reduce((s2, st) => s2 + st.moveLon, 0) / moves.length;
        const km = Math.hypot(moveLat * 111,
          moveLon * 111 * Math.max(0.2, Math.cos(alat * Math.PI / 180)));
        currentSpeed = Math.max(15, km / step);
      }
      spread = Math.max(...tracking.map(st =>
        GeoMath.distanceKm(anchor, [st.lat, st.lon]))) / 111;
    }

    const models = [];
    for (const m of MODELS) {
      const st = states[m.id];
      if (st.points.length < 2) continue;
      const end = st.ended && st.ended.leadHours >= Tracker.maxLeadHours ? null : st.ended;
      models.push({
        id: m.id,
        initialTime,
        points: st.points.map(p => ({
          ...p, time: new Date(initialTime.getTime() + p.leadHours * 3600000)
        })),
        trackEnd: end
      });
    }
    if (!models.length) throw new Error('モデルの予測データを取得できませんでした。');
    return { initialTime, models };
  }
};

// ───────────────────────────────── モデル一致度
//
// ※ここで出す数値は「台風がその場所に到達する確率」ではない。
//   各モデルの予測位置がどれだけ近くに集まっているかを表す指標である。

const Agreement = {
  tightKm: 25,
  looseKm: 320,

  at(models, leadHours) {
    const points = models.map(m => interpolate(m, leadHours)).filter(Boolean);
    if (points.length < 2) return null;
    const centre = GeoMath.centroid(points.map(p => [p.lat, p.lon]));
    const distances = points.map(p => GeoMath.distanceKm(centre, [p.lat, p.lon]));
    const mean = distances.reduce((s, v) => s + v, 0) / distances.length;
    const normalized = (mean - Agreement.tightKm) / (Agreement.looseKm - Agreement.tightKm);
    const score = Math.min(1, Math.max(0, 1 - normalized));
    return {
      count: points.length,
      meanKm: mean,
      score,
      percent: Math.round(score * 100),
      level: score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low',
      label: score >= 0.7 ? 'よく揃っている' : score >= 0.4 ? 'ややばらつく' : '大きくばらつく'
    };
  }
};

// 予測地点のあいだはまっすぐ結んで補間する。
// 追えた範囲より先を聞かれたら null（線を勝手に伸ばさない）。
function interpolate(model, hours) {
  const pts = model.points;
  if (!pts.length) return null;
  if (hours <= pts[0].leadHours) return pts[0];
  if (hours > pts.at(-1).leadHours) return null;
  const upper = pts.findIndex(p => p.leadHours >= hours);
  if (upper <= 0) return pts[0];
  const a = pts[upper - 1], b = pts[upper];
  const span = b.leadHours - a.leadHours;
  if (span <= 0) return a;
  const r = (hours - a.leadHours) / span;
  const lerp = (x, y) => x + (y - x) * r;
  return {
    leadHours: hours,
    lat: lerp(a.lat, b.lat),
    lon: a.lon + GeoMath.norm(b.lon - a.lon) * r,
    pressure: lerp(a.pressure, b.pressure)
  };
}

// ───────────────────────────────── 時刻の書き方（すべて日本時間）

const TimeFormat = {
  fmt(opts) {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...opts });
  },
  clock(d) { return TimeFormat.fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d); },
  hourMinute(d) { return TimeFormat.fmt({ hour: '2-digit', minute: '2-digit' }).format(d); },
  short(d) { return TimeFormat.fmt({ month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d); },
  long(d) { return TimeFormat.fmt({ month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d); },
  day(d) { return TimeFormat.fmt({ month: 'numeric', day: 'numeric', weekday: 'short' }).format(d); },
  lead(h) { return Math.round(h) === 0 ? '現在' : `+${Math.round(h)}時間`; }
};

// ───────────────────────────────── 保存（端末のブラウザ内だけ）

const Store = {
  key: 'typhoon-compare.latest',
  save(data) {
    try { localStorage.setItem(Store.key, JSON.stringify(data)); } catch {}
  },
  load() {
    try {
      const raw = localStorage.getItem(Store.key);
      if (!raw) return null;
      return reviveDates(JSON.parse(raw));
    } catch { return null; }
  }
};

function reviveDates(o) {
  if (o == null) return o;
  if (typeof o === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(o)) return new Date(o);
  if (Array.isArray(o)) return o.map(reviveDates);
  if (typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) out[k] = reviveDates(o[k]);
    return out;
  }
  return o;
}

// ───────────────────────────────── アンサンブル予報
//
// 同じモデルを条件を少しずつ変えて何十回も走らせたもの。
// 決定論モデル同士の食い違い（モデル一致度）とは意味が違い、
// こちらは「同じモデルの中での振れ幅」を表す。

const ENSEMBLES = [
  { id: 'gefs',  om: 'gfs025',       label: 'GEFS',      base: 'gfs',   members: 31 },
  { id: 'eps',   om: 'ecmwf_ifs025', label: 'ECMWF ENS', base: 'ecmwf', members: 51 },
  { id: 'icon',  om: 'icon_global',  label: 'ICON-EPS',  base: 'icon',  members: 40 },
  { id: 'cmc',   om: 'gem_global',   label: 'CMC ENS',   base: 'gem',   members: 21 }
];

const Ensemble = {
  // すでに分かっている進路に沿って、筒状の探索範囲を作る。
  // 決定論モデルの総意を背骨にすれば、持続外挿よりずっと狭い範囲で足りる。
  tube(spine, radiusAt, maxCells = 220) {
    let spacing = 1.5;
    for (;;) {
      const cells = new Set();
      for (const node of spine) {
        const n = Math.max(1, Math.round(radiusAt(node.hours) / spacing));
        const bi = Math.round(node.lat / spacing), bj = Math.round(node.lon / spacing);
        for (let i = -n; i <= n; i++) {
          for (let j = -n; j <= n; j++) {
            if (i * i + j * j > n * n) continue;
            if (Math.abs((bi + i) * spacing) > 89) continue;
            cells.add((bi + i) + ',' + (bj + j));
          }
        }
      }
      if (cells.size <= maxCells || spacing > 3.0) {
        const list = [...cells].map(k => k.split(',').map(Number))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return { spacing, cells: list };
      }
      spacing += 0.25;
    }
  },

  async fetchGrid(grid, system, days) {
    const lats = [], lons = [];
    for (const [i, j] of grid.cells) {
      lats.push(Math.round(i * grid.spacing * 100) / 100);
      lons.push(GeoMath.norm(Math.round(j * grid.spacing * 100) / 100));
    }
    const url = 'https://ensemble-api.open-meteo.com/v1/ensemble'
      + '?latitude=' + lats.join(',') + '&longitude=' + lons.join(',')
      + '&hourly=pressure_msl&models=' + system.om
      + '&forecast_days=' + days + '&temporal_resolution=hourly_6&timezone=UTC';
    const raw = await HTTP.json(url);
    const locations = Array.isArray(raw) ? raw : [raw];
    if (locations.length !== grid.cells.length) throw new Error('地点数が合いません。');
    const times = locations[0].hourly.time.map(t => new Date(t + 'Z'));
    // メンバーのキーは応答から拾う（モデルによって数が違う）
    const keys = Object.keys(locations[0].hourly)
      .filter(k => k.startsWith('pressure_msl')).sort();
    const values = {};
    for (const k of keys) values[k] = locations.map(l => l.hourly[k] || []);
    return { times, values, keys };
  },

  // メンバーごとに中心を追う。通信は1回で済ませる。
  async run(system, observation, tracks, onProgress) {
    const step = Tracker.stepHours;
    const initialTime = tracks.initialTime;

    // 背骨：各時刻における決定論モデルの平均位置
    const spine = [];
    for (let hour = 0; hour <= Tracker.maxLeadHours; hour += step) {
      const pts = tracks.models.map(m => interpolate(m, hour)).filter(Boolean);
      if (!pts.length) break;
      const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const ref = pts[0].lon;
      const lon = GeoMath.norm(
        pts.reduce((s, p) => s + ref + GeoMath.norm(p.lon - ref), 0) / pts.length);
      spine.push({ hours: hour, lat, lon });
    }
    if (spine.length < 2) throw new Error('背骨にする進路が足りません。');

    if (onProgress) onProgress('探索範囲を作っています');
    const grid = Ensemble.tube(spine, h => 2.5 + 0.055 * h);
    const days = Math.max(3, Math.ceil(spine.at(-1).hours / 24) + 2);

    if (onProgress) onProgress(`${system.label} を取得しています`);
    const press = await Ensemble.fetchGrid(grid, system, days);
    const baseIndex = Tracker.nearestTimeIndex(press.times, initialTime);

    const speed = observation.speed || 20;
    const bearing = (observation.courseDegrees == null ? 45 : observation.courseDegrees) * Math.PI / 180;
    const latPerHour = speed * Math.cos(bearing) / 111;
    const lonPerHour = speed * Math.sin(bearing) /
      (111 * Math.max(0.2, Math.cos(observation.latitude * Math.PI / 180)));
    const gapHours = Math.max(0, (initialTime - observation.analysisTime) / 3600000);
    const startLat = observation.latitude + latPerHour * gapHours;
    const startLon = GeoMath.norm(observation.longitude + lonPerHour * gapHours);

    if (onProgress) onProgress('メンバーの中心を追っています');
    const members = [];
    for (const key of press.keys) {
      const st = { lat: startLat, lon: startLon, points: [], ended: null };
      for (let hour = 0; hour <= spine.at(-1).hours; hour += step) {
        if (st.ended) break;
        Tracker.advance(st, hour, key, grid, { values: press.values }, baseIndex + hour / step);
        if (hour === 0) { st.moveLat = latPerHour * step; st.moveLon = lonPerHour * step; }
      }
      if (st.points.length < 2) continue;
      const m = key.match(/member(\d+)/);
      members.push({ index: m ? parseInt(m[1], 10) : 0, points: st.points });
    }
    if (!members.length) throw new Error('メンバーの中心を追えませんでした。');
    members.sort((a, b) => a.index - b.index);
    return { system: system.id, initialTime, members };
  },

  // メンバーの散らばり。これも到達確率ではない。
  spread(ens, hours) {
    const pts = ens.members.map(m => interpolate(m, hours)).filter(Boolean);
    if (pts.length < 2) return null;
    const c = GeoMath.centroid(pts.map(p => [p.lat, p.lon]));
    const d = pts.map(p => GeoMath.distanceKm(c, [p.lat, p.lon]));
    return { km: d.reduce((s, v) => s + v, 0) / d.length, live: pts.length, total: ens.members.length };
  }
};

// ───────────────────────────────── 地点ごとの風と雨

const ELEMENTS = [
  { id: 'wind',  om: 'wind_speed_10m',  label: '風速',         unit: 'm/s',  peak: '最大風速' },
  { id: 'gust',  om: 'wind_gusts_10m',  label: '最大瞬間風速', unit: 'm/s',  peak: '最大瞬間' },
  { id: 'rain',  om: 'precipitation',   label: '降水量',       unit: 'mm/h', peak: '最大雨量' }
];

const DEFAULT_SITES = [
  { name: '那覇',   lat: 26.21, lon: 127.68 },
  { name: '鹿児島', lat: 31.60, lon: 130.56 },
  { name: '福岡',   lat: 33.59, lon: 130.40 },
  { name: '高知',   lat: 33.56, lon: 133.53 },
  { name: '広島',   lat: 34.39, lon: 132.46 },
  { name: '大阪',   lat: 34.69, lon: 135.50 },
  { name: '名古屋', lat: 35.18, lon: 136.91 },
  { name: '東京',   lat: 35.69, lon: 139.69 },
  { name: '仙台',   lat: 38.27, lon: 140.87 },
  { name: '札幌',   lat: 43.06, lon: 141.35 }
];

const SiteData = {
  // 1地点ぶんなので通信は軽い（数十KB）
  async fetch(site) {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${site.lat}&longitude=${site.lon}`
      + '&hourly=' + ELEMENTS.map(e => e.om).join(',')
      + '&models=' + MODELS.map(m => m.om).join(',')
      + '&forecast_days=5&wind_speed_unit=ms&timezone=Asia%2FTokyo';
    const d = await HTTP.json(url);
    const times = d.hourly.time.map(t => new Date(t + '+09:00'));
    const values = {};
    for (const e of ELEMENTS) {
      values[e.id] = {};
      for (const m of MODELS) {
        values[e.id][m.id] = d.hourly[`${e.om}_${m.om}`] || d.hourly[e.om] || [];
      }
    }
    return { site, times, values, at: new Date() };
  },

  peak(data, elementId, modelId) {
    const series = data.values[elementId][modelId] || [];
    let best = null;
    series.forEach((v, i) => {
      if (v == null || i >= data.times.length) return;
      if (!best || v > best.value) best = { value: v, time: data.times[i] };
    });
    return best;
  },

  max(data, elementId) {
    let m = 0;
    for (const model of MODELS) {
      for (const v of data.values[elementId][model.id] || []) if (v != null && v > m) m = v;
    }
    return m;
  },

  // 地名で探す。MapKit は使えないので Open-Meteo のジオコーディングを使う。
  async search(query) {
    const url = 'https://geocoding-api.open-meteo.com/v1/search'
      + '?name=' + encodeURIComponent(query) + '&count=10&language=ja&format=json';
    const d = await HTTP.json(url);
    return (d.results || []).map(r => ({
      name: r.name,
      detail: [r.admin1, r.country].filter(Boolean).join(' '),
      lat: Math.round(r.latitude * 100) / 100,
      lon: Math.round(r.longitude * 100) / 100
    }));
  },

  // 現在地。HTTPS でのみ使える。
  current() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({
          name: '現在地',
          lat: Math.round(p.coords.latitude * 100) / 100,
          lon: Math.round(p.coords.longitude * 100) / 100
        }),
        () => resolve(null),
        { timeout: 10000, maximumAge: 300000 }
      );
    });
  }
};

// ───────────────────────────────── 予報の振り返り
//
// 取った予報を端末の中に残しておき、あとから実況と突き合わせる。
// 台風1つの数回ぶんの比較なので、モデルの優劣を決めるものではない。

const Archive = {
  key: 'typhoon-compare.archive',
  limit: 24,

  all() {
    try {
      const raw = localStorage.getItem(Archive.key);
      return raw ? reviveDates(JSON.parse(raw)) : [];
    } catch { return []; }
  },

  save(situation, tracks) {
    if (!situation || !tracks || !tracks.models.length) return;
    const list = Archive.all();
    const stamp = tracks.initialTime.getTime();
    const code = situation.typhoon.code;
    // 同じ台風・同じ初期時刻は1件だけ残す
    const rest = list.filter(e => !(e.code === code && new Date(e.initialTime).getTime() === stamp));
    rest.push({
      code,
      displayName: situation.typhoon.displayName,
      initialTime: tracks.initialTime,
      observation: {
        analysisTime: situation.observation.analysisTime,
        latitude: situation.observation.latitude,
        longitude: situation.observation.longitude
      },
      official: situation.official,
      models: tracks.models.map(m => ({ id: m.id, points: m.points }))
    });
    rest.sort((a, b) => new Date(a.initialTime) - new Date(b.initialTime));
    const kept = rest.slice(-Archive.limit);
    try { localStorage.setItem(Archive.key, JSON.stringify(kept)); } catch {}
  },

  clear() { try { localStorage.removeItem(Archive.key); } catch {} }
};

const Verification = {
  minLead: 5,
  buckets: [[0, 24], [24, 48], [48, 72], [72, 96], [96, 120]],

  // 気象庁の公式予報のずれ。
  // 起点にはその予報を出した時点の実況位置を使う。
  // これを入れないと、最初の予報点より手前の時刻で誤差が大きく出てしまう。
  officialError(entry, leadHours, actual) {
    if (!entry.official || !entry.official.points || !entry.official.points.length) return null;
    const nodes = [{ h: 0, c: [entry.observation.latitude, entry.observation.longitude] }]
      .concat(entry.official.points.map(p => ({ h: p.leadHours, c: p.center })));
    const last = nodes.at(-1);
    if (leadHours > last.h) return null;
    if (leadHours <= 0) return GeoMath.distanceKm(actual, nodes[0].c);
    const upper = nodes.findIndex(n => n.h >= leadHours);
    if (upper <= 0) return null;
    const a = nodes[upper - 1], b = nodes[upper];
    const span = b.h - a.h;
    if (span <= 0) return GeoMath.distanceKm(actual, a.c);
    const r = (leadHours - a.h) / span;
    const lat = a.c[0] + (b.c[0] - a.c[0]) * r;
    const lon = GeoMath.norm(a.c[1] + GeoMath.norm(b.c[1] - a.c[1]) * r);
    return GeoMath.distanceKm(actual, [lat, lon]);
  },

  // いまの実況と、残してある予報を突き合わせる
  against(observation, code) {
    const actual = [observation.latitude, observation.longitude];
    const out = [];
    for (const entry of Archive.all()) {
      if (entry.code !== code) continue;
      const lead = (observation.analysisTime - new Date(entry.initialTime)) / 3600000;
      if (lead < Verification.minLead || lead > Tracker.maxLeadHours) continue;
      const rows = [];
      for (const m of entry.models) {
        const p = interpolate(m, lead);
        if (!p) continue;
        rows.push({ id: m.id, km: GeoMath.distanceKm(actual, [p.lat, p.lon]) });
      }
      if (!rows.length) continue;
      rows.sort((a, b) => a.km - b.km);
      out.push({
        initialTime: new Date(entry.initialTime),
        verifiedAt: observation.analysisTime,
        leadHours: lead,
        rows,
        official: Verification.officialError(entry, lead, actual)
      });
    }
    return out.sort((a, b) => b.initialTime - a.initialTime);
  },

  // 台風をまたいだ集計。
  // それぞれの保存データが自分の実況を持っているので、
  // もう消えてしまった台風についても答え合わせができる。
  summary() {
    const list = Archive.all();
    const byCode = {};
    for (const e of list) (byCode[e.code] = byCode[e.code] || []).push(e);

    const errors = {}, official = {};
    let comparisons = 0;
    for (const code of Object.keys(byCode)) {
      const ordered = byCode[code].sort((a, b) => new Date(a.initialTime) - new Date(b.initialTime));
      for (let i = 0; i < ordered.length; i++) {
        const forecast = ordered[i];
        for (let j = i + 1; j < ordered.length; j++) {
          const truth = ordered[j];
          const lead = (new Date(truth.observation.analysisTime) - new Date(forecast.initialTime)) / 3600000;
          if (lead < Verification.minLead || lead > Tracker.maxLeadHours) continue;
          const bucket = Verification.buckets.find(b => lead > b[0] && lead <= b[1]);
          if (!bucket) continue;
          const actual = [truth.observation.latitude, truth.observation.longitude];
          let counted = false;
          for (const m of forecast.models) {
            const p = interpolate(m, lead);
            if (!p) continue;
            const key = bucket[0];
            errors[key] = errors[key] || {};
            (errors[key][m.id] = errors[key][m.id] || []).push(GeoMath.distanceKm(actual, [p.lat, p.lon]));
            counted = true;
          }
          const oe = Verification.officialError(forecast, lead, actual);
          if (oe != null) { (official[bucket[0]] = official[bucket[0]] || []).push(oe); counted = true; }
          if (counted) comparisons++;
        }
      }
    }

    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const out = [];
    for (const [lo, hi] of Verification.buckets) {
      const byModel = errors[lo] || {}, off = official[lo] || [];
      if (!Object.keys(byModel).length && !off.length) continue;
      const rows = MODELS
        .filter(m => byModel[m.id] && byModel[m.id].length)
        .map(m => ({ id: m.id, km: mean(byModel[m.id]), n: byModel[m.id].length }))
        .sort((a, b) => a.km - b.km);
      out.push({ lo, hi, rows, official: off.length ? mean(off) : null, officialN: off.length });
    }
    return { buckets: out, typhoons: Object.keys(byCode).length, comparisons };
  }
};
