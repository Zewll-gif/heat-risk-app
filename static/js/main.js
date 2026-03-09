/* HeatGuard CM — main.js v2.3 */

let mapMain = null, mapSim = null
let layerRisk = null, layerMarker = null, layerSimRisk = null
let currentBasemap = null, simBasemap = null
let forecastChart = null, currentGeojson = null, userMarker = null
let simDebounce = null, camStream = null
let activeSource = 'openmeteo'

// ✅ ข้อ 3: พิกัดกรุงเทพ + zoom ออก
const CENTER_LAT = 13.7564
const CENTER_LON = 100.5988
const DEFAULT_ZOOM = 10

const BASEMAPS = {
  satellite: { url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', label:'Satellite' },
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',  label:'Dark' },
  light:     { url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', label:'Light' },
  street:    { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',              label:'Street' },
  terrain:   { url:'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',               label:'Terrain' }
}

// ── THEME ─────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('theme', t)
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t))
}

// ── CLOCK ─────────────────────────────
function startClock() {
  const M = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']
  const tick = () => {
    const n = new Date()
    const el = document.getElementById('liveClock')
    if (el) el.innerHTML =
      `<span class="clock-time">${pad(n.getHours())}:${pad(n.getMinutes())}:<em>${pad(n.getSeconds())}</em></span>` +
      `<span class="clock-date">${n.getDate()} ${M[n.getMonth()]} ${n.getFullYear()+543}</span>`
  }
  tick(); setInterval(tick, 1000)
}
const pad = n => String(n).padStart(2,'0')

// ── PANEL SWITCH ──────────────────────
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('panel-' + name)?.classList.add('active')
  document.querySelector(`[data-panel="${name}"]`)?.classList.add('active')

  if (name === 'map') {
    if (!mapMain) setTimeout(initMap, 100)
    else setTimeout(() => mapMain.invalidateSize(), 50)
  }
  if (name === 'simulate') {
    if (!mapSim) {
      setTimeout(initSimMap, 150)
    } else {
      setTimeout(() => { mapSim.invalidateSize(); autoSimulate() }, 50)
    }
  }
  if (name === 'forecast') loadForecast()
  if (name === 'personal') loadTambonSelect()
}

// ── SOURCE SWITCH ─────────────────────
function switchSource(src) {
  activeSource = src
  document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('srcBtn-' + src)?.classList.add('active')
  loadWeather()
  const active = document.querySelector('.panel.active')?.id?.replace('panel-','')
  if (active === 'forecast') loadForecast()
  if (active === 'map')      loadRealtimeMap()
}

// ── BASEMAP PICKER ────────────────────
function renderBasemapPicker(elId, which) {
  const el = document.getElementById(elId); if (!el) return
  el.innerHTML = Object.entries(BASEMAPS).map(([k, bm], i) =>
    `<button class="basemap-btn${i===0?' active':''}" onclick="switchBasemap('${k}','${which}',this)">${bm.label}</button>`
  ).join('')
}

function switchBasemap(key, which, btn) {
  const map = which === 'main' ? mapMain : mapSim
  if (!map) return
  if (which === 'main') {
    if (currentBasemap) map.removeLayer(currentBasemap)
    currentBasemap = L.tileLayer(BASEMAPS[key].url, { maxZoom:19 }).addTo(map)
    currentBasemap.bringToBack()
  } else {
    if (simBasemap) map.removeLayer(simBasemap)
    simBasemap = L.tileLayer(BASEMAPS[key].url, { maxZoom:19 }).addTo(map)
    simBasemap.bringToBack()
  }
  const pickerId = which === 'main' ? 'basemapPicker' : 'simBasemapPicker'
  document.querySelectorAll(`#${pickerId} .basemap-btn`).forEach(b => b.classList.remove('active'))
  btn?.classList.add('active')
}

// ── MAP ───────────────────────────────
function initMap() {
  // ✅ ข้อ 4: ใช้ CENTER_LAT / CENTER_LON กรุงเทพ
  mapMain = L.map('map', { zoomControl:true, attributionControl:false }).setView([CENTER_LAT, CENTER_LON], DEFAULT_ZOOM)
  currentBasemap = L.tileLayer(BASEMAPS.satellite.url, { maxZoom:19 }).addTo(mapMain)
  renderBasemapPicker('basemapPicker', 'main')
  setTimeout(() => { mapMain.invalidateSize(); loadRealtimeMap() }, 200)
}

async function loadRealtimeMap() {
  try {
    const geo = await fetch(`/api/geojson?source=${activeSource}`).then(r => r.json())
    currentGeojson = geo
    renderMapLayers(geo)
    renderTop5(geo)
  } catch(e) { console.error('GeoJSON error:', e) }
}

const riskColor = v => v>=0.6?'#7f0000': v>=0.4?'#e34a33': v>=0.2?'#fc8d59':'#fee08b'

function renderMapLayers(geo) {
  if (layerRisk)   mapMain.removeLayer(layerRisk)
  if (layerMarker) mapMain.removeLayer(layerMarker)

  const top5 = [...geo.features]
    .sort((a,b) => b.properties.combined_risk - a.properties.combined_risk)
    .slice(0,5).map(f => f.properties.tambon_clean)

  const _polyStyle = f => ({
    fillColor: riskColor(f.properties.combined_risk),
    color: '#555',
    weight: 0.6,
    opacity: 1,
    fillOpacity: 0.75,
    stroke: true
  })

  layerRisk = L.geoJSON(geo, {
    style: _polyStyle,
    onEachFeature: (f, layer) => {
      const p = f.properties
      layer.bindPopup(`<div style="min-width:190px;font-family:'Kanit',sans-serif">
        <b style="font-size:1rem">${p.tambon_clean}</b>
        <table style="width:100%;margin-top:.5rem;font-size:.85rem;line-height:2">
          <tr><td style="color:#9a9287">Risk Score</td><td align="right" style="font-weight:700;color:${riskColor(p.combined_risk)}">${p.combined_risk?.toFixed(3)}</td></tr>
          <tr><td style="color:#9a9287">ระดับ</td><td align="right">${p.risk_level}</td></tr>
          <tr><td style="color:#9a9287">ผู้สูงอายุ 60+</td><td align="right">${(p.elderly_pop||0).toLocaleString()} คน</td></tr>
          <tr><td style="color:#9a9287">Heat Index พยากรณ์</td><td align="right">${p.heat_index_pred?.toFixed(1)}°C</td></tr>
        </table></div>`)
      layer.on('mouseover', function() { this.setStyle({ weight:2.5, color:'#ff5c2b', opacity:1 }) })
      layer.on('mouseout',  function() { this.setStyle(_polyStyle(f)) })
    }
  })
  if (document.getElementById('toggleRisk')?.checked) layerRisk.addTo(mapMain)

  // ✅ ข้อ 2: ลบ circle marker ออก — polygon tooltip ใช้แทนได้แล้ว
  layerMarker = L.layerGroup()
  if (document.getElementById('toggleMarker')?.checked) layerMarker.addTo(mapMain)
}

function centroid(g) {
  if (!g) return [CENTER_LON, CENTER_LAT]
  let c = g.coordinates
  if (g.type === 'MultiPolygon') c = c[0][0]
  else if (g.type === 'Polygon') c = c[0]
  return [c.reduce((s,p)=>s+p[0],0)/c.length, c.reduce((s,p)=>s+p[1],0)/c.length]
}

function toggleLayer(name) {
  if (!mapMain) return
  const l = { risk:layerRisk, marker:layerMarker }[name]
  if (!l) return
  if (mapMain.hasLayer(l)) mapMain.removeLayer(l)
  else l.addTo(mapMain)
}

function renderTop5(geo) {
  const top5 = [...geo.features].sort((a,b)=>b.properties.combined_risk-a.properties.combined_risk).slice(0,5)
  const el = document.getElementById('top5Panel'); if (!el) return
  el.innerHTML = '<div style="font-weight:600;font-size:.72rem;color:#9a9287;margin-bottom:.4rem;text-transform:uppercase;letter-spacing:.06em">Top 5 เสี่ยงสูง</div>'
    + top5.map((f,i) => `
      <div style="display:flex;align-items:center;gap:.5rem;padding:.2rem 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="font-size:.7rem;color:#9a9287;width:12px">${i+1}</span>
        <span style="font-size:.82rem;flex:1">${f.properties.tambon_clean}</span>
        <span style="font-size:.78rem;font-weight:700;font-family:'Space Mono',monospace;color:${riskColor(f.properties.combined_risk)}">${f.properties.combined_risk.toFixed(3)}</span>
      </div>`).join('')
}

function locateMe() {
  if (!navigator.geolocation) return alert('ไม่รองรับ GPS')
  navigator.geolocation.getCurrentPosition(pos => {
    if (!mapMain) initMap()
    mapMain.setView([pos.coords.latitude, pos.coords.longitude], 15)
    if (userMarker) mapMain.removeLayer(userMarker)
    userMarker = L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
      radius:10, color:'#ff5c2b', fillColor:'#ff5c2b', fillOpacity:1, weight:3
    }).bindPopup('<b>ตำแหน่งของคุณ</b>').addTo(mapMain).openPopup()
  }, () => alert('ไม่สามารถดึงตำแหน่งได้'))
}

// ── WEATHER ───────────────────────────
async function loadWeather() {
  try {
    const w  = await fetch(`/api/weather?source=${activeSource}`).then(r => r.json())
    const hi = w.heat_index
    const cls = hi>=41?'level-crit': hi>=32?'level-high': hi>=27?'level-mid':'level-low'
    const lbl = hi>=41?'อันตรายมาก': hi>=32?'อันตราย': hi>=27?'ระวัง':'ปลอดภัย'
    document.getElementById('weatherCard').innerHTML = `
      <div class="weather-temp">${w.temperature}°C</div>
      <div class="weather-hi">Heat Index: ${w.heat_index}°C</div>
      <div class="weather-meta">ความชื้น ${w.humidity}%&nbsp;&nbsp;ลม ${w.wind_speed} km/h</div>
      <span class="weather-level ${cls}">${lbl}</span>
      <div style="font-size:.65rem;color:var(--text2);margin-top:.4rem;font-family:'Space Mono',monospace">${w.updated_at} น. · ${w.source||'Open-Meteo'}</div>`
  } catch(e) {
    document.getElementById('weatherCard').innerHTML = '<div class="weather-loading">โหลดไม่ได้</div>'
  }
}

// ── FORECAST ──────────────────────────

function fmtLabel(iso, nowIso) {
  const t = (iso||'').slice(11,16) || '--:--'
  return iso === nowIso ? `★${t}` : t
}

function fmtFull(iso) {
  if (!iso || iso.length < 16) return iso || '--'
  const d = new Date(iso + ':00+07:00')
  const days = ['อา','จ','อ','พ','พฤ','ศ','ส']
  const dd = String(d.getDate()).padStart(2,'0')
  const mm = String(d.getMonth()+1).padStart(2,'0')
  const hh = String(d.getHours()).padStart(2,'0')
  const mn = String(d.getMinutes()).padStart(2,'0')
  return `${days[d.getDay()]} ${dd}/${mm} ${hh}:${mn}`
}

const hiLevelColor = v => v >= 41 ? '#7f0000' : v >= 32 ? '#e34a33' : v >= 27 ? '#ffb347' : '#4caf84'
const hiLevelTag   = v => v >= 41 ? '⚠️ อันตราย' : v >= 32 ? '⚠️ ระวัง' : v >= 27 ? 'ℹ️ ระวังเล็กน้อย' : '✅ ปลอดภัย'

async function loadForecast() {
  try {
    const data = await fetch(`/api/forecast?source=${activeSource}`).then(r => r.json())

    document.getElementById('fc-temp-val').textContent   = (data.daily_max ?? '--') + '°C'
    document.getElementById('fc-hazard-val').textContent = data.score?.toFixed(3) ?? '--'
    document.getElementById('fc-level-val').textContent  = data.label ?? '--'

    const chartTimes  = Array.isArray(data.chart_times)     ? data.chart_times    : []
    const hiOM        = Array.isArray(data.chart_hi_om)      ? data.chart_hi_om    : []
    const hiOWM       = Array.isArray(data.chart_hi_owm)     ? data.chart_hi_owm   : []
    const hiModel     = Array.isArray(data.chart_hi_model)   ? data.chart_hi_model : []
    const tempOM      = Array.isArray(data.chart_temp_om)    ? data.chart_temp_om  : []
    const nowIdx      = typeof data.now_idx === 'number'     ? data.now_idx        : 24
    const nowIso      = data.now_time || ''
    const owmOk       = !!data.owm_available

    const labels = chartTimes.map(t => fmtLabel(t, nowIso))

    if (forecastChart) { forecastChart.destroy(); forecastChart = null }
    const ctx = document.getElementById('forecastChart').getContext('2d')

    forecastChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          // ── 0: อุณหภูมิ Open-Meteo (เส้นบาง พื้นหลัง) ──
          {
            label: '🌡️ อุณหภูมิ (Open-Meteo)',
            data: tempOM,
            borderColor: 'rgba(74,158,255,0.5)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [2,3],
            pointRadius: ctx2 => ctx2.dataIndex === nowIdx ? 6 : 0,
            pointBackgroundColor: '#4a9eff',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            tension: .35, fill: false, spanGaps: true, order: 4
          },
          // ── 1: HI Open-Meteo ย้อนหลัง+อนาคต (เส้นหลัก ฟ้าเข้ม) ──
          {
            label: '🔵 HI Open-Meteo (อดีต+อนาคต)',
            data: hiOM,
            borderColor: '#4a9eff',
            backgroundColor: ctx2 => {
              const { ctx: c, chartArea: a } = ctx2.chart
              if (!a) return 'rgba(74,158,255,.08)'
              const g = c.createLinearGradient(0, a.top, 0, a.bottom)
              g.addColorStop(0,'rgba(74,158,255,.18)')
              g.addColorStop(1,'rgba(74,158,255,.01)')
              return g
            },
            borderWidth: 2.5,
            pointRadius: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return 10
              return hiOM[ctx2.dataIndex] != null ? 2.5 : 0
            },
            pointBackgroundColor: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return '#ffffff'
              return hiLevelColor(ctx2.parsed?.y)
            },
            pointBorderColor: ctx2 => ctx2.dataIndex === nowIdx ? '#4a9eff' : '#fff',
            pointBorderWidth: ctx2 => ctx2.dataIndex === nowIdx ? 3 : 1,
            tension: .35, fill: true, spanGaps: true, order: 3
          },
          // ── 2: HI OpenWeather (ส้ม, เปรียบเทียบ) ──
          {
            label: owmOk ? '🟠 HI OpenWeather (เปรียบเทียบ)' : '🟠 HI OpenWeather (ไม่มี key)',
            data: hiOWM,
            borderColor: '#ffb347',
            backgroundColor: 'rgba(255,179,71,.06)',
            borderWidth: 2,
            borderDash: [6, 3],
            pointRadius: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return 8
              return hiOWM[ctx2.dataIndex] != null ? 3 : 0
            },
            pointBackgroundColor: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return '#ffffff'
              return hiLevelColor(ctx2.parsed?.y)
            },
            pointBorderColor: '#fff', pointBorderWidth: 1,
            tension: .35, fill: false, spanGaps: false, order: 2
          },
          // ── 3: HI โมเดล LSTM (แดง, พยากรณ์อนาคต) ──
          {
            label: '🔴 HI โมเดล LSTM (พยากรณ์)',
            data: hiModel,
            borderColor: '#ff2b6b',
            backgroundColor: 'rgba(255,43,107,.07)',
            borderWidth: 2.5,
            pointRadius: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return 10
              return hiModel[ctx2.dataIndex] != null ? 3.5 : 0
            },
            pointBackgroundColor: ctx2 => {
              if (ctx2.dataIndex === nowIdx) return '#ffffff'
              return hiLevelColor(ctx2.parsed?.y)
            },
            pointBorderColor: ctx2 => ctx2.dataIndex === nowIdx ? '#ff2b6b' : '#fff',
            pointBorderWidth: ctx2 => ctx2.dataIndex === nowIdx ? 3 : 1,
            tension: .35, fill: false, spanGaps: false, order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 700 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(12,12,12,.96)',
            borderColor: 'rgba(255,255,255,.10)',
            borderWidth: 1,
            titleColor: '#f0ece4',
            bodyColor: '#b0a8a0',
            titleFont: { family: 'Space Mono', size: 11, weight: 'bold' },
            bodyFont: { family: 'Space Mono', size: 10.5 },
            padding: 14,
            callbacks: {
              title: items => {
                const iso = chartTimes[items[0].dataIndex] || ''
                const tag = items[0].dataIndex === nowIdx ? ' ◀ ตอนนี้'
                          : items[0].dataIndex  > nowIdx  ? ' (พยากรณ์)'
                          : ' (ย้อนหลัง)'
                return fmtFull(iso) + ' น.' + tag
              },
              label: ctx2 => {
                if (ctx2.parsed.y == null) return null
                return `  ${ctx2.dataset.label}: ${ctx2.parsed.y.toFixed(1)}°C`
              },
              afterBody: items => {
                // แสดง WHO level จาก HI โมเดล หรือ HI OM
                const v = items.find(i => i.datasetIndex===3)?.parsed?.y
                       ?? items.find(i => i.datasetIndex===1)?.parsed?.y
                if (v == null) return []
                return ['', `  ${hiLevelTag(v)}  (HI ${v.toFixed(1)}°C)`]
              }
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#9a9287',
              font: { family: 'Space Mono', size: 9.5 },
              maxTicksLimit: 16,
              maxRotation: 0,
              callback: function(value, index) {
                const lbl = this.getLabelForValue(value)
                return lbl || value
              }
            },
            grid: { color: 'rgba(255,255,255,.04)' },
            border: { color: '#2e2e2e' }
          },
          y: {
            ticks: {
              color: '#9a9287',
              font: { family: 'Space Mono', size: 10 },
              callback: v => v + '°C'
            },
            grid: { color: 'rgba(255,255,255,.04)' },
            border: { color: '#2e2e2e' },
            suggestedMin: 22, suggestedMax: 52
          }
        }
      },
      // ── เส้นแนวตั้ง "ตอนนี้" + shading อดีต ──
      plugins: [{
        id: 'nowLine',
        afterDraw(chart) {
          const meta = chart.getDatasetMeta(1)
          if (!meta.data[nowIdx]) return
          const x = meta.data[nowIdx].x
          const { ctx: c, chartArea: a } = chart
          c.save()
          // shading ช่วงอดีต
          c.fillStyle = 'rgba(0,0,0,.18)'
          c.fillRect(a.left, a.top, x - a.left, a.bottom - a.top)
          // เส้นแนวตั้ง
          c.beginPath()
          c.setLineDash([5,3])
          c.strokeStyle = 'rgba(255,255,255,.6)'
          c.lineWidth = 1.5
          c.moveTo(x, a.top)
          c.lineTo(x, a.bottom)
          c.stroke()
          // badge "ตอนนี้"
          c.setLineDash([])
          const lbl = 'ตอนนี้'
          c.font = 'bold 10px Space Mono'
          const tw = c.measureText(lbl).width
          c.fillStyle = 'rgba(255,255,255,.9)'
          c.fillRect(x - tw/2 - 5, a.top - 18, tw + 10, 16)
          c.fillStyle = '#0d0d0d'
          c.textAlign = 'center'
          c.fillText(lbl, x, a.top - 5)
          c.restore()
        }
      }]
    })

    const src = document.getElementById('forecastSource')
    if (src) {
      const nowHHMM = (nowIso||'').slice(11,16)
      src.textContent = `Open-Meteo (ย้อนหลัง 24h) + OpenWeather (เปรียบเทียบ) + โมเดล LSTM · อัปเดต ${data.updated_at||''} น. (${data.updated_date||''}) · ตอนนี้ ${nowHHMM} น.`
    }

    const geo = await fetch(`/api/geojson?source=${activeSource}`).then(r => r.json())
    document.getElementById('tambonTable').innerHTML = [...geo.features]
      .map(f => f.properties).sort((a,b) => b.combined_risk - a.combined_risk)
      .map(p => `<div class="tambon-card">
        <div class="tambon-dot" style="background:${riskColor(p.combined_risk)}"></div>
        <div><div class="tambon-name">${p.tambon_clean}</div><div class="tambon-info">ผู้สูงอายุ: ${(p.elderly_pop||0).toLocaleString()} คน</div></div>
        <div class="tambon-score" style="color:${riskColor(p.combined_risk)}">${p.combined_risk.toFixed(3)}</div>
      </div>`).join('')
  } catch(e) { console.error('Forecast error:', e) }
}

// ── CHART LAYER TOGGLE ────────────────
// ✅ ข้อ 3: รองรับ dataset ที่ 3 (HI)
const EYE_IDS  = ['actual', 'pred', 'hi', 'model']
const EYE_OPEN = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
const EYE_SHUT = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'

function toggleChartLayer(datasetIdx) {
  if (!forecastChart) return
  const ds  = forecastChart.data.datasets[datasetIdx]
  const key = EYE_IDS[datasetIdx]
  const btn = document.getElementById(`eyeBtn-${key}`)
  const ico = document.getElementById(`eyeIcon-${key}`)
  if (!ds || !btn || !ico) return
  ds.hidden = !ds.hidden
  forecastChart.update()
  if (!ds.hidden) {
    btn.classList.add('active'); btn.classList.remove('hidden')
    ico.innerHTML = EYE_OPEN
  } else {
    btn.classList.remove('active'); btn.classList.add('hidden')
    ico.innerHTML = EYE_SHUT
  }
}

// ── SIM MAP ───────────────────────────
function initSimMap() {
  const wrapper = document.getElementById('simMapWrapper')
  const el      = document.getElementById('simMap')
  if (!el || !wrapper) { console.warn('simMap element not found'); return }

  wrapper.style.height = '440px'
  el.style.width       = '100%'
  el.style.height      = '440px'

  if (mapSim) {
    mapSim.invalidateSize()
    autoSimulate()
    return
  }

  // ✅ ข้อ 4: ใช้ CENTER_LAT / CENTER_LON กรุงเทพ
  mapSim = L.map('simMap', { zoomControl:true, attributionControl:false }).setView([CENTER_LAT, CENTER_LON], DEFAULT_ZOOM)
  simBasemap = L.tileLayer(BASEMAPS.satellite.url, { maxZoom:19 }).addTo(mapSim)
  renderBasemapPicker('simBasemapPicker', 'sim')

  setTimeout(() => {
    mapSim.invalidateSize()
    setTimeout(() => {
      mapSim.invalidateSize()
      autoSimulate()
    }, 300)
  }, 200)
}

function autoSimulate() {
  clearTimeout(simDebounce)
  simDebounce = setTimeout(runSimulate, 300)
}

async function runSimulate() {
  const temp = parseFloat(document.getElementById('sim-temp').value)
  const rh   = parseFloat(document.getElementById('sim-rh').value)
  const ws   = parseFloat(document.getElementById('sim-ws').value)
  try {
    const data = await fetch('/api/simulate', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ temperature:temp, humidity:rh, wind_speed:ws })
    }).then(r => r.json())

    document.getElementById('sim-hi-val').textContent   = data.heat_index.toFixed(1) + ' °C'
    document.getElementById('sim-hz-val').textContent   = data.hazard.score.toFixed(3)
    document.getElementById('simRiskFill').style.width  = (data.hazard.score*100) + '%'
    document.getElementById('simRiskLabel').textContent = data.hazard.label

    if (!currentGeojson) {
      currentGeojson = await fetch(`/api/geojson?source=${activeSource}`).then(r => r.json())
    }
    if (layerSimRisk) mapSim.removeLayer(layerSimRisk)
    layerSimRisk = L.geoJSON(currentGeojson, {
      style: f => {
        const risk = Math.min(data.hazard.score * (f.properties.vuln_score||0.5), 1)
        return { fillColor:riskColor(risk), color:'#333', weight:0.8, fillOpacity:.78 }
      },
      onEachFeature: (f,layer) => {
        const risk = Math.min(data.hazard.score * (f.properties.vuln_score||0.5),1)
        layer.bindTooltip(`<b>${f.properties.tambon_clean}</b><br>Risk: ${risk.toFixed(3)}`,{ sticky:true })
      }
    }).addTo(mapSim)

    if (mapSim) mapSim.invalidateSize()
  } catch(e) { console.error('Simulate error:', e) }
}

// ── PERSONAL ──────────────────────────
async function loadTambonSelect() {
  const sel = document.getElementById('inp-tambon')
  if (sel.options.length > 1) return
  try {
    const geo = await fetch(`/api/geojson?source=${activeSource}`).then(r => r.json())
    geo.features.map(f=>f.properties.tambon_clean).filter(Boolean).sort()
      .forEach(t => { const o=document.createElement('option'); o.value=t; o.textContent=t; sel.appendChild(o) })
  } catch(e) {}
}

async function openCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user', width:640, height:480 } })
    document.getElementById('camVideo').srcObject = camStream
    document.getElementById('camVideo').style.display     = 'block'
    document.getElementById('camPlaceholder').style.display = 'none'
    document.getElementById('photoPreview').style.display  = 'none'
    document.getElementById('btnSnapCam').style.display  = 'inline-flex'
    document.getElementById('btnCloseCam').style.display = 'inline-flex'
    document.getElementById('btnOpenCam').style.display  = 'none'
  } catch(e) { setAgeResult('เปิดกล้องไม่ได้: '+e.message) }
}

function closeCamera() {
  if (camStream) { camStream.getTracks().forEach(t=>t.stop()); camStream=null }
  document.getElementById('camVideo').style.display       = 'none'
  document.getElementById('camPlaceholder').style.display = 'flex'
  document.getElementById('btnSnapCam').style.display  = 'none'
  document.getElementById('btnCloseCam').style.display = 'none'
  document.getElementById('btnOpenCam').style.display  = 'inline-flex'
}

async function snapAndEstimate() {
  const v=document.getElementById('camVideo')
  const c=document.createElement('canvas')
  c.width=v.videoWidth||640; c.height=v.videoHeight||480
  c.getContext('2d').drawImage(v,0,0)
  document.getElementById('photoPreview').src=c.toDataURL('image/jpeg')
  document.getElementById('photoPreview').style.display='block'
  closeCamera(); setAgeResult('กำลังวิเคราะห์ใบหน้า รอแปปง้าบ...')
  const b64=c.toDataURL('image/jpeg').split(',')[1]
  try {
    const r=await fetch('/api/estimate-age-b64',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_base64:b64})}).then(r=>r.json())
    if (r.success) { document.getElementById('inp-age').value=r.age; setAgeResult(`Face++ ประเมิน: ${r.age} ปี (${r.gender})`) }
    else setAgeResult(r.error)
  } catch(e) { setAgeResult('เชื่อมต่อ API ไม่ได้') }
}

function handlePhoto(input) {
  const file=input.files[0]; if(!file) return
  const reader=new FileReader()
  reader.onload=e=>{
    document.getElementById('photoPreview').src=e.target.result
    document.getElementById('photoPreview').style.display='block'
    document.getElementById('camPlaceholder').style.display='none'
  }
  reader.readAsDataURL(file); estimateAgeFromFile(file)
}

async function estimateAgeFromFile(file) {
  setAgeResult('กำลังวิเคราะห์ใบหน้า...')
  const fd=new FormData(); fd.append('file',file)
  try {
    const r=await fetch('/api/estimate-age',{method:'POST',body:fd}).then(r=>r.json())
    if (r.success) { document.getElementById('inp-age').value=r.age; setAgeResult(`Face++ ประเมิน: ${r.age} ปี (${r.gender})`) }
    else setAgeResult(r.error)
  } catch(e) { setAgeResult('เกิดข้อผิดพลาด: '+e.message) }
}

function setAgeResult(msg) {
  const el=document.getElementById('ageResult')
  if (el) { el.style.display='block'; el.textContent=msg }
}

async function analyzeRisk() {
  const age    =parseInt(document.getElementById('inp-age').value)
  const tambon =document.getElementById('inp-tambon').value
  const disease=document.getElementById('inp-disease').checked
  if (!tambon) return alert('กรุณาเลือกเขต')
  if (!age||isNaN(age)) return alert('กรุณาใส่อายุ')

  document.getElementById('personalResult').style.display='flex'
  document.getElementById('resultExplanation').innerHTML='<div class="typing-indicator"><span></span><span></span><span></span></div>'
  document.getElementById('ringScore').textContent='...'
  document.getElementById('ringLevel').textContent=''
  document.getElementById('scoreBreakdown').style.display='none'

  try {
    const data=await fetch('/api/personal-risk',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({age,tambon,has_disease:disease,source:activeSource})
    }).then(r=>r.json())

    const score=data.personal_score||0
    document.getElementById('ringScore').textContent=Math.round(score*100)+'%'
    document.getElementById('ringLevel').textContent=data.level||'--'
    document.getElementById('ringFill').style.strokeDashoffset=314-(314*score)
    document.getElementById('ringFill').style.stroke=riskColor(score)

    if (data.score_breakdown) {
      document.getElementById('scoreBreakdown').style.display='block'
      document.getElementById('bd-hazard').textContent=`${data.score_breakdown.hazard?.toFixed(4)} (HI ${data.heat_index}°C)`
      document.getElementById('bd-age').textContent   =`${data.score_breakdown.age?.toFixed(4)} (factor ${data.age_factor})`
      document.getElementById('bd-tambon').textContent=`${data.score_breakdown.tambon?.toFixed(4)} (vuln ${data.tambon_vuln})`
    }

    const txt=data.explanation||'ไม่มีข้อมูล'
    document.getElementById('resultExplanation').innerHTML=
      '<div style="white-space:pre-wrap;line-height:1.9">'
      + txt.replace(/\*\*(.*?)\*\*/g,'<b>$1</b>').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/&lt;b&gt;/g,'<b>').replace(/&lt;\/b&gt;/g,'</b>')
      + '</div>'
  } catch(e) {
    document.getElementById('resultExplanation').textContent='เกิดข้อผิดพลาด: '+e.message
    document.getElementById('ringScore').textContent='Err'
  }
}

function locateAndFill() {
  if (!navigator.geolocation) return alert('ไม่รองรับ GPS')
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      const geo=await fetch(`/api/geojson?source=${activeSource}`).then(r=>r.json())
      let best=null, bestD=Infinity
      geo.features.forEach(f=>{
        const c=centroid(f.geometry)
        const d=Math.hypot(c[0]-pos.coords.longitude, c[1]-pos.coords.latitude)
        if (d<bestD) { bestD=d; best=f.properties.tambon_clean }
      })
      if (best) document.getElementById('inp-tambon').value=best
    } catch(e) {}
  }, ()=>alert('ไม่สามารถดึงตำแหน่ง'))
}

// ── CHAT ──────────────────────────────
async function sendChat() {
  const input=document.getElementById('chatInput')
  const msg=input.value.trim(); if(!msg) return
  appendChat('user', escHtml(msg)); input.value=''
  const tid='typing-'+Date.now()
  appendChat('bot','<div class="typing-indicator"><span></span><span></span><span></span></div>',tid)
  try {
    const data=await fetch('/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg,source:activeSource})
    }).then(r=>r.json())
    document.getElementById(tid)?.remove()
    appendChat('bot',(data.reply||'ไม่มีคำตอบ').replace(/\n/g,'<br>'))
  } catch(e) {
    document.getElementById(tid)?.remove()
    appendChat('bot','เกิดข้อผิดพลาด: '+e.message)
  }
}

function quickAsk(q) { document.getElementById('chatInput').value=q; sendChat() }

function appendChat(role, html, id='') {
  const msgs=document.getElementById('chatMessages')
  const div=document.createElement('div')
  div.className=`chat-msg ${role}`; if(id) div.id=id
  div.innerHTML=`<div class="chat-bubble">${html}</div>`
  msgs.appendChild(div); msgs.scrollTop=msgs.scrollHeight
}

const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

// ── INIT ──────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem('theme')||'dark')
  startClock()
  setTimeout(initMap, 150)
  loadWeather()
  setInterval(loadWeather, 5*60*1000)

  fetch('/api/weather-sources').then(r=>r.json()).then(s=>{
    if (!s.tmd){const btn=document.getElementById('srcBtn-tmd');if(btn){btn.title='ยังไม่ได้ตั้งค่า TMD_API_KEY';btn.style.borderStyle='dashed'}}
    if (!s.weatherapi){const btn=document.getElementById('srcBtn-weatherapi');if(btn){btn.title='ยังไม่ได้ตั้งค่า WEATHERAPI_KEY';btn.style.borderStyle='dashed'}}
  }).catch(()=>{})

  document.getElementById('chatInput')?.addEventListener('keydown', e=>{
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  })
})