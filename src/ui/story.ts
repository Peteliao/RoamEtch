// Travel story tab: day chapters, batch photo association, disclosed weather,
// offline sun times, node notes and a printable travel book.
import { t, currentLang } from '../core/i18n';
import { get } from '../core/settings';
import { on } from '../core/events';
import { fmtDistance, fmtDuration, fmtAltitude } from '../core/geo';
import { buildStoryDays, normalizeStory, storyTitle, storySummary } from '../core/story';
import type { Story, StoryDay, StoryPhoto } from '../core/story';
import {
  cachedWeatherDay, fetchWeatherDay, mergeManualWeather, summarizeWeather,
  weatherCodeKey, weatherIcon
} from '../core/weather';
import type { ManualWeather, WeatherSummary } from '../core/weather';
import { buildTravelBook } from '../core/travelBook';
import { importMatchedPhotos, updateTrip } from '../core/store';
import { processPhoto } from '../core/photos';
import { readLocalImageHeader } from '../core/chatImage';
import { matchPhotoToTrip } from '../core/photoMatch';
import { exportFile } from '../core/shareEnv';
import { appState, refreshActiveTrip, isTripSectionActive } from './state';
import { el, icon, modal, toast, filePickerMulti } from './helpers';
import { openWaypointModal } from './editor';
import { renderTripEmptyState } from './tripEmptyState';

type WeatherEntry = {
  summary: WeatherSummary;
  cached: boolean;
  fetchedAt: number;
  model: 'forecast' | 'archive';
};

function fmtClock(ms) {
  const lang = currentLang();
  return new Date(ms).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtDayDate(day: string) {
  const lang = currentLang();
  return new Date(`${day}T12:00:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short', day: 'numeric', weekday: 'long'
  });
}

function distanceText(meters: number) {
  const d = fmtDistance(meters, get('units'));
  return `${d.v} ${d.u}`;
}

function altitudeText(meters: number) {
  const a = fmtAltitude(meters, get('units'));
  return `${a.v} ${a.u}`;
}

export function createStoryView(navigate, { embedded = false } = {}) {
  const view = el('div', { class: 'view', id: 'view-story' });
  const scroll = el('div', { class: 'view-scroll story-scroll' });
  view.append(scroll);

  const head = el('div', { class: 'page-head story-head' },
    el('div', { class: 'page-head-row' },
      el('h2', { class: 'page-title' }, t('story.title')),
      el('div', { class: 'story-head-actions' },
        el('button', { class: 'btn sm', onclick: () => void openPhotoImport() }, icon('photo', 15), t('story.addPhotos')),
        el('button', { class: 'btn sm primary', onclick: () => openBookExport() }, icon('book', 15), t('story.exportBook'))
      )
    ),
    el('div', { class: 'small muted story-subtitle' }, t('story.subtitle')));
  const body = el('div', { class: 'story-body' });
  const emptyBox = el('div', { class: 'empty-state', style: { display: 'none' } });
  scroll.append(head, emptyBox, body);
  if (embedded) head.classList.add('story-head-embedded');

  let story: Story = normalizeStory(null);
  let storyTripId = '';
  let days: StoryDay[] = [];
  let weather = new Map<string, WeatherEntry>();
  let weatherErrors = new Map<string, string>();
  let weatherBusy = new Set<string>();
  let renderSeq = 0;
  let saveTimer = null;
  let savedHint = null;
  let thumbUrls = new Set<string>();
  let destroyed = false;

  function activeFull() {
    const full = appState.activeTripFull;
    return full && full.trip?.id === appState.activeTripId ? full : null;
  }

  function storyActive() {
    return isTripSectionActive('story') && appState.view === 'trips';
  }

  function trackKey(full) {
    return full ? `${full.trip.id}:${full.trip.updatedAt || 0}` : '';
  }

  function revokeThumbs() {
    for (const url of thumbUrls) {
      try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    }
    thumbUrls.clear();
  }

  function scheduleSave() {
    if (savedHint) savedHint.textContent = '';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void saveStory(); }, 550);
  }

  async function saveStory() {
    const full = activeFull();
    if (!full) return;
    const id = full.trip.id;
    try {
      story.updatedAt = Date.now();
      await updateTrip(id, { story: normalizeStory(story) }, { touch: false });
      if (appState.activeTripFull?.trip.id === id) {
        appState.activeTripFull = {
          ...appState.activeTripFull,
          trip: { ...appState.activeTripFull.trip, story: normalizeStory(story) }
        };
      }
      if (savedHint && activeFull()?.trip.id === id) savedHint.textContent = t('story.saved');
    } catch (error) {
      console.error(error);
      if (savedHint) savedHint.textContent = t('story.saveFail');
      toast(t('story.saveFail'), 'err');
    }
  }

  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      await saveStory();
    }
  }

  function weatherLabel(summary, manual?: ManualWeather | null) {
    if (manual?.condition?.trim()) return manual.condition.trim();
    return t(`story.codes.${weatherCodeKey(summary.code)}`);
  }

  function baseSummary(): WeatherSummary {
    return { temp: null, code: null, rain: null, wind: null, uv: null, hour: 12, sample: '', missing: ['rain', 'uv'] };
  }

  function displaySummary(day: StoryDay) {
    const record = weather.get(day.day);
    const manual = story.manualWeather[day.day];
    if (record) return mergeManualWeather(record.summary, manual);
    if (manual) return { ...mergeManualWeather(baseSummary(), manual), manual: true };
    return null;
  }

  function weatherBox(day: StoryDay) {
    const record = weather.get(day.day);
    const manual = story.manualWeather[day.day];
    const summary = displaySummary(day);
    const busy = weatherBusy.has(day.day);
    const error = weatherErrors.get(day.day);
    const buttons = el('div', { class: 'story-weather-actions' },
      el('button', {
        class: 'btn sm ghost', disabled: busy || !day.center,
        onclick: () => void fetchDayWeather(day)
      }, icon('refresh', 13), busy ? t('story.fetching') : (record ? t('story.refreshWeather') : t('story.fetch'))),
      el('button', {
        class: 'btn sm ghost',
        onclick: () => openManualWeather(day)
      }, icon('edit', 13), t('story.manualSupplement')));
    if (!summary) {
      return el('div', { class: 'story-weather card-flat' },
        el('div', { class: 'story-weather-head' }, icon('sun', 16), el('h4', {}, t('story.weather')), buttons),
        el('div', { class: 'story-weather-empty' }, error
          ? t(error === 'weather-offline' ? 'story.weatherOffline' : 'story.weatherFail')
          : t('story.weatherNone')),
        el('div', { class: 'story-weather-src' }, t('story.weatherNeedNetwork')));
    }
    const condition = weatherLabel(summary, manual);
    const source = record
      ? `${t('story.weatherSource')} · ${t(record.model === 'archive' ? 'story.weatherArchive' : 'story.weatherForecast')} · ${t(record.cached ? 'story.weatherCached' : 'story.weatherNetwork')} · ${fmtClock(record.fetchedAt)}`
      : t('story.manualSupplement');
    return el('div', { class: 'story-weather card-flat' },
      el('div', { class: 'story-weather-head' },
        el('span', { class: 'story-weather-ic' }, weatherIcon(summary.code || null)),
        el('h4', {}, condition),
        summary.manual ? el('span', { class: 'story-tag' }, t('story.manualTag')) : null,
        buttons),
      el('div', { class: 'story-weather-vals' },
        summary.temp != null ? el('span', {}, `${Math.round(summary.temp)}°C`) : null,
        summary.rain != null ? el('span', {}, `☔ ${Math.round(summary.rain)}%`) : null,
        summary.wind != null ? el('span', {}, `💨 ${Math.round(summary.wind)} km/h`) : null,
        summary.uv != null ? el('span', {}, `UV ${Math.round(summary.uv)}`) : null),
      summary.missing.length
        ? el('div', { class: 'story-weather-missing' },
          t('story.weatherMissing', { fields: summary.missing.map((key) => t(`story.missing.${key}`)).join(' / ') }))
        : null,
      el('div', { class: 'story-weather-src' },
        source,
        record?.summary?.sample ? ` · ${t('story.weatherSample')} ${record.summary.sample}` : ''),
      error ? el('div', { class: 'story-weather-err' },
        t(error === 'weather-offline' ? 'story.weatherOffline' : 'story.weatherFail')) : null,
      manual?.note ? el('div', { class: 'story-weather-note' }, manual.note) : null);
  }

  function sunBox(day: StoryDay) {
    if (!day.sun.available) return null;
    const polar = day.sun.polar === 'day' ? t('story.polarDay') : day.sun.polar === 'night' ? t('story.polarNight') : '';
    return el('div', { class: 'story-sun card-flat' },
      el('div', { class: 'story-sun-head' }, icon('sun', 16), el('h4', {}, t('story.sunTitle'))),
      el('div', { class: 'story-sun-times' },
        day.sun.sunrise ? el('span', {}, `↑ ${t('story.sunrise')} ${day.sun.sunrise}`) : null,
        day.sun.sunset ? el('span', {}, `↓ ${t('story.sunset')} ${day.sun.sunset}`) : null,
        polar ? el('span', {}, polar) : null),
      el('div', { class: 'story-weather-src' }, t('story.sunOffline')));
  }

  function updateWeatherBox(day: StoryDay) {
    const holder = body.querySelector(`[data-weather-day="${day.day}"]`);
    if (!holder) return;
    holder.replaceChildren(weatherBox(day), sunBox(day) || document.createTextNode(''));
  }

  async function fetchDayWeather(day: StoryDay, opts: { silent?: boolean } = {}) {
    if (weatherBusy.has(day.day) || !day.center) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      weatherErrors.set(day.day, 'weather-offline');
      updateWeatherBox(day);
      if (!opts.silent) toast(t('story.weatherOffline'), 'warn');
      return false;
    }
    weatherBusy.add(day.day);
    weatherErrors.delete(day.day);
    updateWeatherBox(day);
    try {
      const res = await fetchWeatherDay(day.center.lat, day.center.lon, day.day);
      if (destroyed) return false;
      weather.set(day.day, {
        summary: summarizeWeather(res.data, day.firstTime),
        cached: res.cached,
        fetchedAt: res.data.fetchedAt,
        model: res.data.model
      });
      return true;
    } catch (error) {
      if (!destroyed) {
        weatherErrors.set(day.day, error?.message === 'weather-offline' ? 'weather-offline' : 'weather-fail');
        if (!opts.silent) {
          toast(t(error?.message === 'weather-offline' ? 'story.weatherOffline' : 'story.weatherFail'), 'warn', 4200);
        }
      }
      return false;
    } finally {
      weatherBusy.delete(day.day);
      if (!destroyed) updateWeatherBox(day);
    }
  }

  async function fetchAllWeather(button) {
    const full = activeFull();
    if (!full) return;
    await flushSave();
    button.disabled = true;
    let failures = 0;
    for (const day of days) {
      if (destroyed) return;
      if (!day.center) continue;
      const ok = await fetchDayWeather(day, { silent: true });
      if (!ok) failures++;
    }
    button.disabled = false;
    if (!destroyed) {
      toast(failures
        ? t('story.weatherAllPartial', { n: failures })
        : t('story.weatherAllDone'), failures ? 'warn' : 'ok', 3600);
    }
  }

  function loadCachedWeather(seq: number) {
    const requests = [];
    for (const day of days) {
      if (!day.center || weather.has(day.day)) continue;
      const cached = cachedWeatherDay(day.center.lat, day.center.lon, day.day);
      if (cached) {
        weather.set(day.day, {
          summary: summarizeWeather(cached.data, day.firstTime),
          cached: true,
          fetchedAt: cached.data.fetchedAt,
          model: cached.data.model
        });
        requests.push(day);
      }
    }
    if (seq !== renderSeq || destroyed) return;
    requests.forEach(updateWeatherBox);
  }

  function openManualWeather(day: StoryDay) {
    const current = story.manualWeather[day.day] || {};
    const temp = el('input', { type: 'number', step: '0.1', value: current.temp ?? '' });
    const condition = el('input', { type: 'text', value: current.condition || '', placeholder: t('story.manualCondition') });
    const rain = el('input', { type: 'number', min: '0', max: '100', step: '1', value: current.rain ?? '' });
    const wind = el('input', { type: 'number', min: '0', step: '0.1', value: current.wind ?? '' });
    const uv = el('input', { type: 'number', min: '0', step: '0.1', value: current.uv ?? '' });
    const note = el('textarea', {}, current.note || '');
    const m = modal({
      title: `${t('story.manualTitle')} · ${day.label}`,
      body: el('div', {},
        el('div', { class: 'hint' }, t('story.manualHint')),
        el('div', { class: 'field' }, el('label', {}, t('story.manualTemp')), temp),
        el('div', { class: 'field' }, el('label', {}, t('story.manualCondition')), condition),
        el('div', { class: 'story-field-row' },
          el('div', { class: 'field' }, el('label', {}, t('story.manualRain')), rain),
          el('div', { class: 'field' }, el('label', {}, t('story.manualWind')), wind),
          el('div', { class: 'field' }, el('label', {}, t('story.manualUv')), uv)),
        el('div', { class: 'field' }, el('label', {}, t('story.manualNote')), note)),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, t('story.cancel')),
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            const num = (node) => node.value === '' ? null : Number(node.value);
            const entry: ManualWeather = {
              temp: num(temp), condition: condition.value.trim(),
              rain: num(rain), wind: num(wind), uv: num(uv),
              note: note.value.trim(), updatedAt: Date.now()
            };
            if ([entry.temp, entry.rain, entry.wind, entry.uv, entry.condition, entry.note].every((v) => v == null || v === '')) {
              delete story.manualWeather[day.day];
            } else {
              story.manualWeather[day.day] = entry;
            }
            await saveStory();
            updateWeatherBox(day);
            m.close();
            toast(t('story.manualSaved'), 'ok');
          }
        }, t('story.manualSave'))
      ]
    });
  }

  function openPhotoLightbox(photos: StoryPhoto[], start: number) {
    if (!photos.length) return;
    const urls = photos.map((photo) => {
      try { return URL.createObjectURL(photo.media.blob || photo.media.thumb); } catch { return ''; }
    });
    let index = Math.max(0, Math.min(start, photos.length - 1));
    const img = el('img', { class: 'story-lightbox-img', alt: '' });
    const caption = el('div', { class: 'story-lightbox-cap' });
    const prev = el('button', { class: 'btn sm', onclick: () => { index = (index - 1 + photos.length) % photos.length; render(); } }, icon('chevronRight', 15));
    prev.firstElementChild.style.transform = 'rotate(180deg)';
    const next = el('button', { class: 'btn sm', onclick: () => { index = (index + 1) % photos.length; render(); } }, icon('chevronRight', 15));
    const counter = el('span', { class: 'small faint' });
    function render() {
      const photo = photos[index];
      img.src = urls[index];
      img.alt = photo.nodeName || t('story.photo');
      caption.textContent = `${photo.nodeName || t('story.photo')}${photo.time ? ` · ${fmtClock(photo.time)}` : ''}`;
      counter.textContent = `${index + 1} / ${photos.length}`;
    }
    render();
    modal({
      title: t('story.photos'),
      wide: true,
      body: el('div', { class: 'story-lightbox' }, img, caption),
      footer: [prev, counter, next],
      onClose: () => {
        for (const url of urls) {
          try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
        }
      }
    });
  }

  function photoGrid(day: StoryDay) {
    if (!day.photos.length) return null;
    const grid = el('div', { class: 'story-photo-grid' });
    for (let i = 0; i < day.photos.length; i++) {
      const photo = day.photos[i];
      let url = '';
      try {
        url = URL.createObjectURL(photo.media.thumb || photo.media.blob);
        thumbUrls.add(url);
      } catch { /* unsupported blob */ }
      grid.append(el('button', {
        class: 'story-photo', title: photo.nodeName || t('story.photo'),
        onclick: () => openPhotoLightbox(day.photos, i)
      }, url ? el('img', { src: url, alt: photo.nodeName || t('story.photo'), loading: 'lazy' }) : icon('photo', 24)));
    }
    return grid;
  }

  function nodeList(full, day: StoryDay) {
    const list = el('div', { class: 'story-node-list' });
    if (!day.nodes.length) {
      list.append(el('div', { class: 'story-node-empty' }, t('story.nodeEmpty')));
    }
    for (const node of day.nodes) {
      const original = full.waypoints.find((w) => w.id === node.id) || {};
      list.append(el('div', { class: 'story-node' },
        el('span', { class: 'story-node-time' }, node.time ? fmtClock(node.time) : ''),
        el('div', { class: 'story-node-main' },
          el('div', { class: 'story-node-name' }, node.name || t('story.unnamedNode'),
            node.photoCount ? el('span', { class: 'story-node-badge' }, `📷 ${node.photoCount}`) : null),
          node.desc ? el('div', { class: 'story-node-desc' }, node.desc) : null),
        el('button', {
          class: 'btn sm ghost story-node-edit',
          onclick: async () => {
            await flushSave();
            openWaypointModal(original, { tripId: full.trip.id });
          },
          'aria-label': t('story.nodeEdit')
        }, icon('edit', 13), t('story.nodeEdit'))));
    }
    return list;
  }

  function dayCard(full, day: StoryDay) {
    const note = el('textarea', {
      class: 'story-day-note', rows: '2', placeholder: t('story.dayNotePh')
    });
    note.value = story.dayNotes[day.day] || '';
    note.oninput = () => {
      if (note.value.trim()) story.dayNotes[day.day] = note.value;
      else delete story.dayNotes[day.day];
      scheduleSave();
    };
    const center = day.center;
    return el('section', { class: 'story-day', 'data-day': day.day },
      el('header', { class: 'story-day-head' },
        el('div', { class: 'story-day-title' },
          el('span', { class: 'story-day-index' }, String(days.indexOf(day) + 1).padStart(2, '0')),
          el('div', {},
            el('h3', {}, fmtDayDate(day.day)),
            el('div', { class: 'story-day-meta' },
              day.hasTrack
                ? `${distanceText(day.distance)} · ${day.duration ? fmtDuration(day.duration, { compact: true }) : '--'} · ↑${altitudeText(day.ascent)}`
                : `${day.nodes.length} ${t('story.nodes')} · ${day.photos.length} ${t('story.photos')}`))),
        el('button', {
          class: 'btn sm ghost',
          onclick: async () => {
            await flushSave();
            openWaypointModal({ lat: center?.lat, lon: center?.lon, time: day.firstTime || Date.now() }, { tripId: full.trip.id });
          },
          disabled: !center
        }, icon('plus', 13), t('story.nodeAdd'))),
      el('div', { class: 'story-env', 'data-weather-day': day.day }, weatherBox(day), sunBox(day) || document.createTextNode('')),
      note,
      nodeList(full, day),
      photoGrid(day));
  }

  function renderAll() {
    const seq = ++renderSeq;
    if (destroyed) return;
    const full = activeFull();
    const open = appState.tripDetail.open && appState.tripDetail.section === 'story';
    if (!open || !full) {
      body.replaceChildren();
      emptyBox.style.display = full ? 'none' : '';
      if (!full) renderTripEmptyState(emptyBox, navigate, {
        iconKey: 'book', titleKey: 'story.emptyTitle', hintKey: 'story.emptyHint'
      });
      return;
    }
    emptyBox.style.display = 'none';
    revokeThumbs();
    const key = trackKey(full);
    if (storyTripId !== full.trip.id) {
      storyTripId = full.trip.id;
      story = normalizeStory(full.trip.story);
      weather = new Map();
      weatherErrors = new Map();
    } else {
      story = normalizeStory(full.trip.story || story);
    }
    days = buildStoryDays(full, {
      ascentThreshold: get('ascentThreshold'),
      activity: full.trip.activity,
      weightKg: get('weightKg'),
      lang: currentLang()
    });
    const total = storySummary(days);
    const titleInput = el('input', {
      class: 'story-title-input', value: story.title, placeholder: storyTitle(full.trip, { ...story, title: '' }) || t('story.coverTitlePh'),
      'aria-label': t('story.coverTitle')
    });
    titleInput.oninput = () => { story.title = titleInput.value; scheduleSave(); };
    titleInput.onblur = () => void flushSave();
    const introInput = el('textarea', {
      class: 'story-intro-input', rows: '3', placeholder: t('story.introPh'), 'aria-label': t('story.intro')
    });
    introInput.value = story.intro;
    introInput.oninput = () => { story.intro = introInput.value; scheduleSave(); };
    savedHint = el('span', { class: 'story-saved-hint', role: 'status' });
    const fetchAllBtn = el('button', {
      class: 'btn sm ghost',
      onclick: () => void fetchAllWeather(fetchAllBtn)
    }, icon('refresh', 14), t('story.fetchAll'));

    const cover = el('section', { class: 'story-cover' },
      el('div', { class: 'story-eyebrow' }, icon('book', 14), t('story.coverTitle'), savedHint),
      titleInput,
      introInput,
      el('div', { class: 'story-cover-meta' },
        el('span', {}, `${days.length} ${t('story.days')}`),
        el('span', {}, distanceText(total.distance)),
        el('span', {}, `↑ ${altitudeText(total.ascent)}`),
        el('span', {}, `${total.nodes} ${t('story.nodes')}`),
        el('span', {}, `${total.photos} ${t('story.photos')}`)),
      el('div', { class: 'story-cover-actions' },
        el('button', { class: 'btn sm', onclick: () => void openPhotoImport() }, icon('photo', 14), t('story.addPhotos')),
        el('button', { class: 'btn sm primary', onclick: () => openBookExport() }, icon('book', 14), t('story.exportBook'))));
    const banner = el('div', { class: 'story-weather-banner' },
      icon('info', 15),
      el('div', { class: 'story-weather-banner-text' }, t('story.weatherHint')),
      fetchAllBtn);
    body.replaceChildren(cover, banner, el('div', { class: 'story-days' }, ...days.map((day) => dayCard(full, day))));
    loadCachedWeather(seq);
  }

  function openBookExport() {
    const full = activeFull();
    if (!full) return;
    if (!days.length) { toast(t('story.exportEmpty'), 'warn'); return; }
    const radius = el('input', { type: 'number', min: '0', max: '5000', step: '50', value: get('privacyRadius') });
    const includePhotos = el('input', { type: 'checkbox' });
    includePhotos.checked = true;
    const hideStart = el('input', { type: 'checkbox' });
    const hideEnd = el('input', { type: 'checkbox' });
    const busy = el('span', { class: 'small faint' });
    const exportBtn = el('button', {
      class: 'btn primary',
      onclick: async () => {
        exportBtn.disabled = true;
        busy.textContent = t('story.exporting');
        try {
          await flushSave();
          const weatherForBook: any = {};
          for (const day of days) {
            const entry = weather.get(day.day);
            if (entry) weatherForBook[day.day] = entry;
          }
          const html = await buildTravelBook(full, {
            story,
            weather: weatherForBook,
            includePhotos: includePhotos.checked,
            privacy: {
              radius: Math.max(0, Number(radius.value) || 0),
              hideSensitive: true,
              hideStartIcon: hideStart.checked,
              hideEndIcon: hideEnd.checked
            }
          });
          const name = (storyTitle(full.trip, story) || 'trip').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 42);
          exportFile(new Blob([html], { type: 'text/html' }), `roametch-story-${name}.html`);
          m.close();
          toast(t('story.exportDone'), 'ok');
        } catch (error) {
          console.error(error);
          busy.textContent = t('story.exportFail');
          exportBtn.disabled = false;
          toast(t('story.exportFail'), 'err');
        }
      }
    }, t('story.exportBook'));
    const m = modal({
      title: t('story.exportBookTitle'),
      body: el('div', {},
        el('div', { class: 'hint' }, t('story.exportBookHint')),
        el('div', { class: 'field' }, el('label', {}, t('story.exportRadius')), radius),
        el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px', margin: '10px 0' } }, includePhotos, t('story.exportIncludePhotos')),
        el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px', margin: '10px 0' } }, hideStart, t('story.exportHideStart')),
        el('label', { class: 'row', style: { cursor: 'pointer', fontSize: '13px', margin: '10px 0' } }, hideEnd, t('story.exportHideEnd')),
        busy),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, t('story.cancel')),
        exportBtn
      ]
    });
  }

  async function openPhotoImport() {
    const full = activeFull();
    if (!full) { toast(t('story.noTrip'), 'warn'); return; }
    const files = await filePickerMulti('image/*');
    if (!files.length) return;
    await flushSave();
    const list = el('div', { class: 'story-import-list' });
    const progress = el('div', { class: 'story-import-progress' });
    const summary = el('div', { class: 'hint' }, t('story.photoImportHint'));
    const confirm = el('button', { class: 'btn primary', disabled: true });
    const entries = [];
    const urls = [];
    let failed = 0;
    let closed = false;
    const m = modal({
      title: t('story.photoImportTitle'),
      wide: true,
      body: el('div', {}, summary, progress, list),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, t('story.cancel')),
        confirm
      ],
      onClose: () => {
        closed = true;
        for (const url of urls) {
          try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
        }
      }
    });
    function refreshConfirm() {
      const count = entries.filter((entry) => entry.checked).length;
      confirm.disabled = !count;
      confirm.textContent = t('story.importCount', { n: count });
    }
    confirm.onclick = async () => {
      const chosen = entries.filter((entry) => entry.checked && entry.candidate);
      if (!chosen.length) { toast(t('story.importNone'), 'warn'); return; }
      confirm.disabled = true;
      try {
        const result = await importMatchedPhotos({
          tripId: full.trip.id,
          items: chosen,
          nameFor: (n) => `${t('story.photo')} ${n}`
        });
        m.close();
        toast(t('story.imported', { linked: result.linked, created: result.created }), 'ok', 4200);
        await refreshActiveTrip(full.trip.id, { recalc: false, metadataOnly: true });
      } catch (error) {
        console.error(error);
        confirm.disabled = false;
        toast(t('story.importFail'), 'err');
      }
    };
    refreshConfirm();
    for (let i = 0; i < files.length; i++) {
      if (closed) return;
      progress.textContent = t('story.processing', { done: i + 1, total: files.length });
      let processed = null;
      try {
        if (!(await readLocalImageHeader(files[i]))) throw new Error('bad-image');
        processed = await processPhoto(files[i]);
      } catch {
        failed++;
        continue;
      }
      const candidate = matchPhotoToTrip(processed.exif || {}, full.segments, full.waypoints);
      const entry = { photo: processed, candidate, checked: !!candidate, file: files[i] };
      entries.push(entry);
      let url = '';
      try { url = URL.createObjectURL(processed.thumb); urls.push(url); } catch { /* no thumb */ }
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = !!candidate;
      checkbox.disabled = !candidate;
      checkbox.onchange = () => { entry.checked = checkbox.checked; refreshConfirm(); };
      const meta = [];
      if (processed.exif?.time) meta.push(`${t('story.photoTime')} ${fmtClock(processed.exif.time)}`);
      if (candidate) {
        meta.push(t(`story.basis${candidate.basis === 'gps+time' ? 'GpsTime' : candidate.basis === 'time' ? 'Time' : 'Gps'}`));
        meta.push(t(`story.confidence${candidate.confidence[0].toUpperCase()}${candidate.confidence.slice(1)}`));
      }
      list.append(el('label', { class: 'story-import-item' + (candidate ? '' : ' unmatched') },
        checkbox,
        url ? el('img', { src: url, alt: '' }) : el('span', { class: 'story-import-noimg' }, icon('photo', 20)),
        el('div', { class: 'story-import-main' },
          el('div', { class: 'story-import-name' }, files[i].name),
          el('div', { class: 'story-import-meta' }, meta.join(' · ')),
          el('div', { class: 'story-import-match' }, candidate
            ? (candidate.waypointId ? `${t('story.matchedNode')} · ${candidate.waypointName || t('story.unnamedNode')}` : t('story.noNode'))
            : t('story.unmatched')))));
      refreshConfirm();
    }
    if (closed) return;
    progress.textContent = '';
    if (!entries.length) {
      summary.textContent = failed
        ? `${t('story.noExif')} · ${t('story.importReadFail', { n: failed })}`
        : t('story.noExif');
      return;
    }
    summary.textContent = t('story.photoImportHint');
    if (failed) summary.append(` · ${t('story.importReadFail', { n: failed })}`);
    const matched = entries.filter((entry) => entry.candidate).length;
    if (matched) toast(t('story.autoMatched', { n: matched }), 'info', 2800);
  }

  on('trip:active', () => {
    if (storyActive()) renderAll();
  });

  return {
    view,
    refresh: () => renderAll(),
    resize: () => {},
    destroy: () => {
      destroyed = true;
      renderSeq++;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        if (storyTripId) void updateTrip(storyTripId, { story: normalizeStory(story) }, { touch: false });
      }
      revokeThumbs();
    }
  };
}
