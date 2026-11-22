// Shared backup / restore flow: one download path and one verified restore preview.
import { t } from '../core/i18n';
import { get, set } from '../core/settings';
import { emit } from '../core/events';
import { exportBackup, inspectBackup, restoreBackup } from '../core/backup';
import { triggerDownload } from '../core/gpx';
import { isWeChat, wechatFileGuidance } from '../core/shareEnv';
import { el, icon, modal, toast } from './helpers';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export async function exportBackupFlow({ silentOnWeChat = false } = {}) {
  const { blob, filename, tripCount, counts, exportedAt } = await exportBackup();
  if (isWeChat()) {
    if (!silentOnWeChat) wechatFileGuidance();
    return false;
  }
  triggerDownload(blob, filename);
  set('lastBackupAt', Date.parse(exportedAt) || Date.now());
  emit('backup:exported', { tripCount, counts });
  toast(t('trips.backupOk', { n: tripCount }), 'ok');
  return true;
}

function infoRow(label, value, tone = '') {
  return el('div', { class: 'backup-info-row' },
    el('span', { class: 'k' }, label),
    el('span', { class: `v ${tone}`.trim() }, value));
}

export async function restoreBackupFlow(file, { onRestored = null } = {}) {
  let inspected;
  try {
    inspected = await inspectBackup(file);
  } catch (e) {
    console.error(e);
    toast(t('trips.restoreErr'), 'err');
    return false;
  }
  const { manifest, conflicts, integrity } = inspected;
  const counts = manifest.counts || {};
  const tripCount = counts.trips ?? manifest.trips.length;
  const waypointCount = counts.waypoints ?? manifest.waypoints.length;
  const mediaCount = counts.media ?? (manifest.mediaMeta || []).length;
  const integrityText = integrity.ok === true
    ? t('backup.verified', { n: integrity.checked })
    : integrity.ok === false
      ? t('backup.verifyFailed')
      : t('backup.legacy');

  const snapshot = el('input', { type: 'checkbox', checked: true });
  const choice = await new Promise<{ strategy: string } | null>((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const buttons = [];
    if (integrity.ok !== false) {
      if (conflicts.length) {
        buttons.push(el('button', {
          class: 'btn', onclick: () => { done({ strategy: 'skip' }); m.close(); }
        }, t('trips.conflictSkip')));
        buttons.push(el('button', {
          class: 'btn warn', onclick: () => { done({ strategy: 'overwrite' }); m.close(); }
        }, t('trips.conflictOverwrite')));
      } else {
        buttons.push(el('button', {
          class: 'btn primary', onclick: () => { done({ strategy: 'skip' }); m.close(); }
        }, icon('database', 14), t('backup.restoreAction')));
      }
    }
    buttons.push(el('button', { class: 'btn ghost', onclick: () => { done(null); m.close(); } }, t('common.cancel')));
    const m = modal({
      title: t('backup.previewTitle'),
      body: el('div', {},
        el('div', { class: 'backup-info' },
          infoRow(t('backup.exportedAt'), formatDate(manifest.exportedAt)),
          infoRow(t('backup.contents'), t('backup.contentsValue', { trips: tripCount, nodes: waypointCount, photos: mediaCount })),
          infoRow(t('backup.checksum'), integrityText, integrity.ok === false ? 'bad' : integrity.ok === true ? 'ok' : 'muted'),
          conflicts.length ? infoRow(t('backup.conflicts'), t('backup.conflictsValue', { n: conflicts.length }), 'bad') : null),
        el('div', { class: 'small faint', style: { margin: '12px 0 6px' } }, t('backup.manifestNote')),
        el('div', { class: 'backup-warning' }, icon('warn', 14), t('backup.plaintextWarning')),
        integrity.ok === false ? el('div', { class: 'backup-error' }, icon('warn', 15), t('backup.corruptHint')) : null,
        el('label', { class: 'backup-snapshot' }, snapshot,
          el('span', {}, icon('shield', 15), t('backup.snapshotBefore')))),
      footer: buttons,
      onClose: () => done(null)
    });
  });
  if (!choice) return false;
  if (snapshot.checked) {
    try { await exportBackupFlow({ silentOnWeChat: true }); } catch (e) { console.error(e); }
  }
  try {
    const n = await restoreBackup(file, choice.strategy, inspected);
    toast(t('trips.restoreOk', { n }), 'ok');
    onRestored?.(n);
    return true;
  } catch (e) {
    console.error(e);
    toast(t('trips.restoreErr'), 'err');
    return false;
  }
}

export function lastBackupLabel() {
  const at = Number(get('lastBackupAt')) || 0;
  return at ? formatDate(new Date(at).toISOString()) : t('backup.never');
}

export function backupDue() {
  const at = Number(get('lastBackupAt')) || 0;
  return !at || Date.now() - at > 30 * 24 * 3600_000;
}
