// Analysis view: stats grid, elevation/speed charts (uPlot) linked with a mini map,
// slope distribution, segment table, timeline, difficulty & fatigue advisories.
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { t } from '../core/i18n';
import { get } from '../core/settings';
import { on } from '../core/events';
import { listTrips } from '../core/store';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude } from '../core/geo';
import { TrackMap } from './map';
import { WP_ICONS } from '../core/waypointMeta';
import { canvasPalette } from '../core/palette';
import { appState, setActiveTrip } from './state';
import { el, icon } from './helpers';

export function createAnalysisView() {
  const view = el('div', { class: 'view', id: 'view-analysis' });
  const scroll = el('div', { class: 'view-scroll' });
  view.append(scroll);

  const tripSel = el('select', {});
  const head = el('div', { class: 'page-head' },
    el('h2', { class: 'page-title' }, t('analysis.title')),
    el('div', { class: 'search-bar', style: { margin: '10px 0 14px' } }, icon('analysis', 18), tripSel));
  tripSel.onchange = async () => { if (tripSel.value) await setActiveTrip(tripSel.value); };

  const statsBox = el('div', { class: 'stat-grid' });
  const diffBox = el('div', {});
  const advisory = el('div', {});
  const miniMapBox = el('div', { class: 'analysis-map' });
  const chartWrap = el('div', { class: 'chart-wrap' });
  const altTab = el('button', { class: 'active', onclick: () => setChartMode('alt') }, t('analysis.altTab'));
  const speedTab = el('button', { onclick: () => setChartMode('speed') }, t('analysis.speedTab'));
  const chartTabs = el('div', { class: 'seg-toggle sm' }, altTab, speedTab);
  const chartCard = el('div', { class: 'card chart-card' },
    el('div', { class: 'chart-head' }, el('h3', {}, t('analysis.chartTitle')), chartTabs),
    el('div', { class: 'small faint', style: { marginBottom: '2px' } }, t('analysis.hoverHint')),
    chartWrap);
  const slopeCard = el('div', { class: 'card' }, el('h3', {}, t('analysis.slopeDist')), el('canvas', { id: 'slope-canvas', style: { width: '100%', height: '120px' } }));
  const segCard = el('div', { class: 'card' }, el('h3', {}, t('analysis.segTable')), el('div', { id: 'seg-table' }));
  const tlCard = el('div', { class: 'card' }, el('h3', {}, t('analysis.timeline')), el('div', { id: 'timeline' }));
  const disclaimer = el('div', { class: 'small faint', style: { padding: '4px 2px 20px' } }, '⚠ ' + t('analysis.disclaimer'));

  scroll.append(head, advisory, statsBox, diffBox, miniMapBox, chartCard, slopeCard, segCard, tlCard, disclaimer);

  let miniMap = null;
  let chart = null;
  let chartMode = 'alt';
  let flatPoints = [];

  function setChartMode(mode) {
    chartMode = mode;
    altTab.classList.toggle('active', mode === 'alt');
    speedTab.classList.toggle('active', mode === 'speed');
    if (appState.stats) renderCharts(appState.stats);
  }

  function ensureMiniMap() {
    if (miniMap) return;
    miniMap = new TrackMap(miniMapBox, { compact: true, preserveDrawingBuffer: false }).init([116.4, 39.9], 10);
  }

  async function refreshTripList() {
    const trips = await listTrips();
    tripSel.innerHTML = '';
    tripSel.append(el('option', { value: '' }, '—'));
    for (const tr of trips) {
      tripSel.append(el('option', { value: tr.id }, tr.name || new Date(tr.createdAt).toLocaleString()));
    }
    tripSel.value = appState.activeTripId || '';
  }

  function statBox(label, valueHtml, primary = false) {
    return el('div', { class: 'stat-box' + (primary ? ' primary' : '') }, el('div', { class: 'v', html: valueHtml }), el('div', { class: 'k' }, label));
  }

  function renderStats(stats) {
    const units = get('units');
    statsBox.innerHTML = '';
    diffBox.innerHTML = '';
    if (!stats) return;
    const d = fmtDistance(stats.distance, units);
    const sp = fmtSpeed(stats.avgSpeed, units);
    const mx = fmtSpeed(stats.maxSpeed, units);
    const pc = fmtPace(stats.avgSpeed, units);
    const ha = fmtAltitude(stats.maxAlt, units);
    const la = fmtAltitude(stats.minAlt, units);
    statsBox.append(
      statBox(t('analysis.distance'), `${d.v}<small> ${d.u}</small>`, true),
      statBox(t('analysis.duration'), fmtDuration(stats.duration), true),
      statBox(t('analysis.avgSpeed'), `${sp.v}<small> ${sp.u}</small>`, true),
      statBox(t('analysis.ascent'), `↑${Math.round(stats.ascent)}<small> m</small>`, true),
      statBox(t('analysis.movingTime'), fmtDuration(stats.movingMs, { compact: true })),
      statBox(t('analysis.stillTime'), fmtDuration(stats.stillMs, { compact: true })),
      statBox(t('analysis.maxSpeed'), `${mx.v}<small> ${mx.u}</small>`),
      statBox(t('analysis.avgPace'), `${pc.v}<small> ${pc.u}</small>`),
      statBox(t('analysis.descent'), `↓${Math.round(stats.descent)}<small> m</small>`),
      statBox(t('analysis.calories'), stats.calories != null ? `${Math.round(stats.calories)}<small> kcal</small>` : '—'),
      statBox(t('analysis.maxAlt'), `${ha.v}<small> ${ha.u}</small>`),
      statBox(t('analysis.minAlt'), `${la.v}<small> ${la.u}</small>`),
      statBox(t('analysis.points'), `${stats.pointCount}<small> / ${stats.segCount} ${t('analysis.segShort')}</small>`)
    );
    // difficulty (indicative only)
    const score = Math.max(1, Math.min(5, Math.round(stats.distance / 8000 + stats.ascent / 600)));
    const diff = el('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      el('span', {}, t('analysis.difficulty')),
      el('span', { style: { color: 'var(--warn)', letterSpacing: '2px' } }, '★'.repeat(score) + '☆'.repeat(5 - score)),
      el('span', { class: 'small faint' }, t('analysis.difficultyNote')));
    diffBox.append(diff);
    // fatigue advisory for driving
    advisory.innerHTML = '';
    const act = appState.activeTripFull?.trip?.activity;
    if (act === 'drive' && stats.movingMs > 4 * 3600_000) {
      advisory.append(el('div', { class: 'debug-banner' }, '⚠ ' + t('analysis.fatige')));
    }
    if (!stats.hasTime) {
      advisory.append(el('div', { class: 'debug-banner', style: { borderColor: 'var(--info)', color: 'var(--info)', background: 'rgba(90,167,240,0.08)' } }, t('analysis.noTimeData')));
    }
  }

  function chartOpts(height): any {
    const P = canvasPalette();
    return {
      width: Math.max(280, scroll.clientWidth - 60),
      height,
      scales: { x: { time: false } },
      series: [
        {},
        { stroke: P.accent, width: 2, fill: P.accentSoft, points: { show: false } }
      ],
      axes: [
        { stroke: P.muted, grid: { stroke: P.grid }, size: 42, font: '11px system-ui' },
        { stroke: P.muted, grid: { stroke: P.grid }, size: 46, font: '11px system-ui' }
      ],
      cursor: { drag: { x: false, y: false } },
      legend: { show: false }
    };
  }

  function hoverHook(valueLabel) {
    return (u) => {
      const idx = u.cursor.idx;
      if (idx == null || !flatPoints[idx] || !miniMap) { miniMap?.clearHover(); return; }
      miniMap.showHover(flatPoints[idx].lat, flatPoints[idx].lon, valueLabel ? valueLabel(idx) : null);
    };
  }

  function renderCharts(stats) {
    flatPoints = appState.activeTripFull?.segments.flatMap((s) => s.points) || [];
    chartWrap.innerHTML = '';
    chart?.destroy();
    chart = null;
    if (!stats || !flatPoints.length) { chartCard.style.display = 'none'; return; }

    const xs = stats.series.d.map((d) => d / 1000);
    const alts = stats.series.alt;
    const speeds = stats.series.speed.map((s) => (s != null ? s * 3.6 : null));
    const hasAlt = alts.some((a) => a != null);
    const hasSpeed = stats.hasTime && speeds.some((s) => s != null);
    altTab.disabled = !hasAlt;
    speedTab.disabled = !hasSpeed;
    if (!hasAlt && !hasSpeed) {
      chartCard.style.display = 'none';
      renderSlope(stats);
      return;
    }
    if ((chartMode === 'alt' && !hasAlt) || (chartMode === 'speed' && !hasSpeed)) {
      chartMode = hasAlt ? 'alt' : 'speed';
    }
    altTab.classList.toggle('active', chartMode === 'alt');
    speedTab.classList.toggle('active', chartMode === 'speed');
    chartCard.style.display = '';

    const units = get('units');
    const P = canvasPalette();
    const opts = chartOpts(210);
    opts.axes[0].label = 'km';
    if (chartMode === 'alt') {
      opts.axes[1].label = 'm';
      opts.series[1].stroke = P.accent;
      opts.series[1].fill = P.accentSoft;
      opts.hooks = {
        setCursor: [hoverHook((idx) => {
          if (alts[idx] == null) return null;
          const a = fmtAltitude(alts[idx], units);
          return `${a.v} ${a.u}`;
        })]
      };
      chart = new uPlot(opts, [xs, alts], chartWrap);
    } else {
      opts.axes[1].label = 'km/h';
      opts.series[1].stroke = `rgb(${P.lut[1].join(',')})`;
      opts.series[1].fill = `rgba(${P.lut[1].join(',')},0.12)`;
      opts.hooks = {
        setCursor: [hoverHook((idx) => {
          const raw = stats.series.speed[idx];
          if (raw == null) return null;
          const s = fmtSpeed(raw, units);
          return `${s.v} ${s.u}`;
        })]
      };
      chart = new uPlot(opts, [xs, speeds], chartWrap);
    }
    renderSlope(stats);
  }

  function renderSlope(stats) {
    const P = canvasPalette();
    const canvas = slopeCard.querySelector('#slope-canvas');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300, h = 120;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const buckets = new Array(13).fill(0); // -30..30 step 5
    for (const s of stats.series.slope) {
      if (s == null) continue;
      const b = Math.max(0, Math.min(12, Math.floor((s + 30) / 5)));
      buckets[b]++;
    }
    const max = Math.max(1, ...buckets);
    const bw = w / 13;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    buckets.forEach((n, i) => {
      const bh = (n / max) * (h - 26);
      const x = i * bw + 3;
      ctx.fillStyle = i < 6 ? `rgb(${P.lut[1].join(',')})` : i === 6 ? P.faint : P.amber;
      ctx.fillRect(x, h - 18 - bh, bw - 6, bh);
      ctx.fillStyle = P.muted;
      ctx.fillText(`${i * 5 - 30}`, i * bw + bw / 2, h - 5);
    });
  }

  function renderSegments(stats) {
    const box = segCard.querySelector('#seg-table');
    box.innerHTML = '';
    if (!stats?.segments?.length) { segCard.style.display = 'none'; return; }
    segCard.style.display = '';
    const units = get('units');
    const table = el('table', { style: { width: '100%', fontSize: '12.5px', borderCollapse: 'collapse' } });
    table.append(el('tr', { style: { color: 'var(--text-faint)', textAlign: 'left' } },
      el('th', { style: { padding: '4px' } }, '#'),
      el('th', {}, t('analysis.segDist')),
      el('th', {}, t('analysis.segTime')),
      el('th', {}, t('analysis.segAsc')),
      el('th', {}, t('analysis.points'))));
    stats.segments.forEach((s, i) => {
      const d = fmtDistance(s.distance, units);
      table.append(el('tr', { style: { borderTop: '1px solid var(--border)' } },
        el('td', { style: { padding: '5px 4px' } }, i + 1),
        el('td', { class: 'mono' }, `${d.v}${d.u}`),
        el('td', { class: 'mono' }, fmtDuration(s.duration, { compact: true })),
        el('td', { class: 'mono' }, `↑${Math.round(s.ascent)}m`),
        el('td', { class: 'mono' }, s.pointCount)));
    });
    box.append(table);
  }

  function renderTimeline() {
    const box = tlCard.querySelector('#timeline');
    box.innerHTML = '';
    const wps = (appState.activeTripFull?.waypoints || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!wps.length) { tlCard.style.display = 'none'; return; }
    tlCard.style.display = '';
    for (const w of wps) {
      const row = el('div', { class: 'setting-row', style: { cursor: 'pointer' }, onclick: () => miniMap?.flyTo(w.lat, w.lon, 15) },
        el('span', { style: { fontSize: '18px' } }, WP_ICONS[w.type] || '📍'),
        el('div', { class: 'txt' },
          el('div', { class: 't' }, w.name || t(`wp.types.${w.type}`)),
          el('div', { class: 'd' }, [w.time ? new Date(w.time).toLocaleString() : '', w.desc].filter(Boolean).join(' · '))),
        w.hidden ? el('span', { class: 'tag' }, '🚫') : null);
      box.append(row);
    }
  }

  async function renderAll() {
    await refreshTripList();
    if (!appState.activeTripId && tripSel.options.length > 1) await setActiveTrip(tripSel.options[1].value);
    const full = appState.activeTripFull;
    const stats = appState.stats;
    if (!full) {
      statsBox.innerHTML = '';
      diffBox.innerHTML = '';
      advisory.innerHTML = '';
      chartCard.style.display = 'none';
      slopeCard.style.display = 'none';
      segCard.style.display = 'none';
      tlCard.style.display = 'none';
      miniMapBox.style.display = 'none';
      return;
    }
    chartCard.style.display = '';
    slopeCard.style.display = '';
    miniMapBox.style.display = '';
    ensureMiniMap();
    miniMap.setTrackData(full.segments, full.waypoints);
    setTimeout(() => miniMap.fitTrack(30), 120);
    renderStats(stats);
    renderCharts(stats);
    renderSegments(stats);
    renderTimeline();
  }

  on('trip:active', () => { if (appState.view === 'analysis') renderAll(); });
  on('trip:stats', (stats) => {
    if (appState.view !== 'analysis') return;
    renderStats(stats);
    renderCharts(stats);
    renderSegments(stats);
  });
  on('theme:applied', () => {
    if (appState.view === 'analysis' && appState.stats) { renderCharts(appState.stats); }
  });

  return {
    view,
    refresh: renderAll,
    resize: () => {
      miniMap?.resize();
      const w = Math.max(280, scroll.clientWidth - 60);
      chart?.setSize({ width: w, height: 210 });
      if (appState.stats) renderSlope(appState.stats);
    },
    destroy: () => {
      miniMap?.destroy();
      miniMap = null;
      chart?.destroy();
    }
  };
}