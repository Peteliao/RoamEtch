// Shared backup / restore flow: one download path and one verified restore preview.
import { t } from '../core/i18n';
import { get, set } from '../core/settings';
import { emit } from '../core/events';
import { exportBackup, inspectBackup, restoreBackup } from '../core/backup';
import { isEncryptedBackupFile, MIN_BACKUP_PASSWORD } from '../core/backupCrypto';
import { triggerDownload } from '../core/gpx';
import { isWeChat, wechatFileGuidance } from '../core/shareEnv';
import { el, icon, modal, toast } from './helpers';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function askExportPassword() {
  return new Promise<{ password: string } | null>((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const encrypt = el('input', { type: 'checkbox', checked: true });
    const pwd = el('input', { type: 'password', autocomplete: 'new-password', maxlength: '256', placeholder: t('backup.passwordPh') });
    const confirm = el('input', { type: 'password', autocomplete: 'new-password', maxlength: '256', placeholder: t('backup.passwordPh') });
    const err = el('div', { class: 'backup-error', style: { display: 'none' } }, icon('warn', 14), el('span', {}));
    const fields = el('div', { style: { marginTop: '10px' } },
      el('div', { class: 'field' }, el('label', {}, t('backup.passwordLabel', { n: MIN_BACKUP_PASSWORD })), pwd),
      el('div', { class: 'field', style: { marginTop: '10px' } }, el('label', {}, t('backup.passwordConfirm')), confirm));
    const exportBtn = el('button', { class: 'btn primary', disabled: true }, t('backup.exportAction'));
    const showError = (text) => {
      err.style.display = text ? '' : 'none';
      err.querySelector('span').textContent = text || '';
    };
    const sync = () => {
      fields.style.display = encrypt.checked ? '' : 'none';
      showError('');
      if (!encrypt.checked) { exportBtn.disabled = false; return; }
      if (pwd.value && pwd.value.length < MIN_BACKUP_PASSWORD) {
        showError(t('backup.passwordMin', { n: MIN_BACKUP_PASSWORD }));
      } else if (confirm.value && confirm.value !== pwd.value) {
        showError(t('backup.passwordMismatch'));
      }
      exportBtn.disabled = !(pwd.value.length >= MIN_BACKUP_PASSWORD && confirm.value === pwd.value);
    };
    const submit = () => {
      if (exportBtn.disabled) return;
      const password = encrypt.checked ? pwd.value : '';
      done({ password });
      m.close();
    };
    exportBtn.onclick = submit;
    encrypt.onchange = sync;
    pwd.oninput = sync;
    confirm.oninput = sync;
    for (const input of [pwd, confirm]) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
    const m = modal({
      title: t('backup.exportTitle'),
      body: el('div', {},
        el('div', { class: 'small muted', style: { lineHeight: 1.55 } }, t('backup.exportIntro')),
        el('label', { class: 'row', style: { cursor: 'pointer', marginTop: '12px', alignItems: 'center' } },
          encrypt, el('span', {}, t('backup.encryptLabel'))),
        el('div', { class: 'small faint', style: { margin: '4px 0 0 22px', lineHeight: 1.5 } }, t('backup.encryptDesc')),
        fields,
        err,
        el('div', { class: 'backup-warning', style: { marginTop: '12px' } }, icon('shield', 14), t('backup.encryptWarn'))),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => { done(null); m.close(); } }, t('common.cancel')),
        exportBtn
      ],
      onClose: () => done(null)
    });
    sync();
    setTimeout(() => pwd.focus(), 60);
  });
}

function askRestorePassword(name, wrong = false) {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const pwd = el('input', { type: 'password', autocomplete: 'current-password', maxlength: '256', placeholder: t('backup.passwordPh') });
    const unlock = el('button', { class: 'btn primary', disabled: true }, t('backup.unlockAction'));
    const submit = () => {
      if (!pwd.value) return;
      done(pwd.value);
      m.close();
    };
    const sync = () => { unlock.disabled = !pwd.value; };
    pwd.oninput = sync;
    pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    unlock.onclick = submit;
    const m = modal({
      title: t('backup.unlockTitle'),
      body: el('div', {},
        el('div', { class: 'small muted', style: { lineHeight: 1.55 } }, t('backup.unlockIntro')),
        name ? el('div', { class: 'small faint', style: { marginTop: '6px', wordBreak: 'break-all' } }, name) : null,
        el('div', { class: 'field', style: { marginTop: '12px' } }, el('label', {}, t('backup.passwordLabel', { n: MIN_BACKUP_PASSWORD })), pwd),
        wrong ? el('div', { class: 'backup-error' }, icon('warn', 14), t('backup.wrongPassword')) : null,
        el('div', { class: 'backup-warning', style: { marginTop: '12px' } }, icon('shield', 14), t('backup.encryptWarn'))),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => { done(null); m.close(); } }, t('common.cancel')),
        unlock
      ],
      onClose: () => done(null)
    });
    setTimeout(() => pwd.focus(), 60);
  });
}

export async function exportBackupFlow({ silentOnWeChat = false, promptEncryption = true, password: fixedPassword = '' } = {}) {
  let password = fixedPassword || '';
  if (promptEncryption) {
    const choice = await askExportPassword();
    if (!choice) return false;
    password = choice.password;
  }
  const { blob, filename, tripCount, counts, exportedAt, encrypted } = await exportBackup({ password });
  if (isWeChat()) {
    if (!silentOnWeChat) wechatFileGuidance();
    return false;
  }
  triggerDownload(blob, filename);
  set('lastBackupAt', Date.parse(exportedAt) || Date.now());
  emit('backup:exported', { tripCount, counts, encrypted });
  toast(t(encrypted ? 'backup.encryptedOk' : 'trips.backupOk', { n: tripCount }), 'ok');
  return true;
}

function infoRow(label, value, tone = '') {
  return el('div', { class: 'backup-info-row' },
    el('span', { class: 'k' }, label),
    el('span', { class: `v ${tone}`.trim() }, value));
}

export async function restoreBackupFlow(file, { onRestored = null } = {}) {
  const encryptedFile = await isEncryptedBackupFile(file);
  let password = '';
  if (encryptedFile) {
    const entered = await askRestorePassword(file?.name || '');
    if (entered == null) return false;
    password = entered;
  }
  let inspected;
  for (;;) {
    try {
      inspected = await inspectBackup(file, password);
      break;
    } catch (e) {
      if (e?.code === 'backup-decrypt-failed' || e?.code === 'backup-password-required') {
        const retry = await askRestorePassword(file?.name || '', true);
        if (retry == null) return false;
        password = retry;
        continue;
      }
      console.error(e);
      toast(t(e?.code === 'backup-encrypted-unsupported' ? 'backup.unsupported' : 'trips.restoreErr'), 'err');
      return false;
    }
  }
  const { manifest, conflicts, integrity, encrypted } = inspected;
  const counts = manifest.counts || {};
  const tripCount = counts.trips ?? manifest.trips.length;
  const waypointCount = counts.waypoints ?? manifest.waypoints.length;
  const mediaCount = counts.media ?? (manifest.mediaMeta || []).length;
  const integrityText = integrity.ok === true
    ? t('backup.verified', { n: integrity.checked })
    : integrity.ok === false
      ? t('backup.verifyFailed')
      : t('backup.legacy');

  let snapshotBeforeRestore = false;
  const snapshotState = el('span', { class: 'backup-snapshot-state' }, t('backup.snapshotOff'));
  const snapshotToggle = el('button', {
    type: 'button', class: 'btn ghost block backup-snapshot-toggle', 'aria-pressed': 'false',
    style: { justifyContent: 'space-between', marginTop: '12px', textAlign: 'left' }
  },
    el('span', {}, icon('shield', 15), t('backup.snapshotBefore')),
    snapshotState);
  snapshotToggle.onclick = () => {
    snapshotBeforeRestore = !snapshotBeforeRestore;
    snapshotToggle.setAttribute('aria-pressed', String(snapshotBeforeRestore));
    snapshotToggle.classList.toggle('primary', snapshotBeforeRestore);
    snapshotToggle.classList.toggle('ghost', !snapshotBeforeRestore);
    snapshotState.textContent = t(snapshotBeforeRestore ? 'backup.snapshotOn' : 'backup.snapshotOff');
  };
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
          encrypted ? infoRow(t('backup.encrypted'), t('backup.encryptedValue'), 'ok') : null,
          infoRow(t('backup.checksum'), integrityText, integrity.ok === false ? 'bad' : integrity.ok === true ? 'ok' : 'muted'),
          conflicts.length ? infoRow(t('backup.conflicts'), t('backup.conflictsValue', { n: conflicts.length }), 'bad') : null),
        el('div', { class: 'small faint', style: { margin: '12px 0 6px' } }, t('backup.manifestNote')),
        encrypted
          ? el('div', { class: 'backup-warning ok' }, icon('shield', 14), t('backup.encryptedNote'))
          : el('div', { class: 'backup-warning' }, icon('warn', 14), t('backup.plaintextWarning')),
        integrity.ok === false ? el('div', { class: 'backup-error' }, icon('warn', 15), t('backup.corruptHint')) : null,
        snapshotToggle),
      footer: buttons,
      onClose: () => done(null)
    });
  });
  if (!choice) return false;
  if (snapshotBeforeRestore) {
    let exported = false;
    try {
      exported = await exportBackupFlow({ silentOnWeChat: true, promptEncryption: false, password: encrypted ? password : '' });
    } catch (e) {
      console.error('pre-restore snapshot export failed', e);
    }
    if (!exported) {
      toast(t('backup.snapshotFailed'), 'err', 5200);
      return false;
    }
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
