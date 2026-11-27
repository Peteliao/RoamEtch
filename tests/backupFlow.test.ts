// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exportBackup: vi.fn(),
  inspectBackup: vi.fn(),
  restoreBackup: vi.fn(),
  appendBackupHistory: vi.fn(),
  set: vi.fn(),
  emit: vi.fn(),
  triggerDownload: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../src/core/backup', () => ({
  exportBackup: mocks.exportBackup,
  inspectBackup: mocks.inspectBackup,
  restoreBackup: mocks.restoreBackup
}));
vi.mock('../src/core/backupHistory', () => ({ appendBackupHistory: mocks.appendBackupHistory }));
vi.mock('../src/core/backupCrypto', () => ({ isEncryptedBackupFile: vi.fn(async () => false), MIN_BACKUP_PASSWORD: 8 }));
vi.mock('../src/core/store', () => ({ TRIP_SCHEMA_VERSION: 7 }));
vi.mock('../src/core/settings', () => ({ get: vi.fn(() => 0), set: mocks.set }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit, on: vi.fn() }));
vi.mock('../src/core/gpx', () => ({ triggerDownload: mocks.triggerDownload }));
vi.mock('../src/core/shareEnv', () => ({ isWeChat: () => false, wechatFileGuidance: vi.fn() }));
vi.mock('../src/core/i18n', () => ({ t: (key: string) => key }));
vi.mock('../src/ui/helpers', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/helpers')>(),
  toast: mocks.toast
}));

import { exportBackupFlow, restoreBackupFlow } from '../src/ui/backupFlow';

const counts = { trips: 2, segments: 3, trackChunks: 4, waypoints: 5, media: 6 };

function inspected(overrides = {}) {
  return {
    manifest: {
      format: 'localtrace-backup', version: 3, tripSchemaVersion: 7, appVersion: '3.4.0',
      counts, trips: [{ id: 'a' }, { id: 'b' }], waypoints: [], mediaMeta: []
    },
    conflicts: [],
    integrity: { ok: true, checked: 6, failed: [] },
    encrypted: false,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  mocks.appendBackupHistory.mockResolvedValue(true);
  mocks.exportBackup.mockResolvedValue({
    blob: new Blob(['backup']), filename: 'roametch-backup-20261126.trip',
    tripCount: 2, counts, exportedAt: '2026-11-26T10:00:00.000Z', encrypted: false
  });
  mocks.inspectBackup.mockResolvedValue(inspected());
  mocks.restoreBackup.mockResolvedValue(2);
});

describe('backup flow history', () => {
  it('records a successful manual export without retaining the blob', async () => {
    await expect(exportBackupFlow({ promptEncryption: false })).resolves.toBe(true);

    expect(mocks.appendBackupHistory).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'export', status: 'exported', createdAt: Date.parse('2026-11-26T10:00:00.000Z'),
      filename: 'roametch-backup-20261126.trip', bytes: 6, encrypted: false,
      backupFormat: 'localtrace-backup', tripSchema: 7, appVersion: '3.6.0',
      trips: 2, segments: 3, chunks: 4, waypoints: 5, media: 6, source: 'manual'
    }));
    expect(mocks.set).toHaveBeenCalledWith('lastBackupAt', Date.parse('2026-11-26T10:00:00.000Z'));
    expect(mocks.triggerDownload).toHaveBeenCalledOnce();
  });

  it('records failed exports and pre-restore snapshots with their source', async () => {
    mocks.exportBackup.mockRejectedValueOnce(new Error('disk full'));
    await expect(exportBackupFlow({ promptEncryption: false, historySource: 'pre-restore' })).rejects.toThrow('disk full');
    expect(mocks.appendBackupHistory).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'export', status: 'failed', source: 'pre-restore', encrypted: false
    }));

    mocks.exportBackup.mockResolvedValueOnce({
      blob: new Blob(['snapshot']), filename: 'snapshot.trip', tripCount: 2, counts,
      exportedAt: '2026-11-26T11:00:00.000Z', encrypted: true
    });
    await exportBackupFlow({ promptEncryption: false, password: 'secret', historySource: 'pre-restore' });
    expect(mocks.appendBackupHistory).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'export', status: 'exported', source: 'pre-restore', encrypted: true
    }));
  });

  it('records verified restore success and notifies listeners', async () => {
    const file = new File(['backup'], 'restore.trip');
    const onRestored = vi.fn();
    const pending = restoreBackupFlow(file, { onRestored });
    await vi.waitFor(() => expect(document.querySelector('.modal-backdrop .btn.primary')).toBeTruthy());
    document.querySelector<HTMLButtonElement>('.modal-backdrop .btn.primary')!.click();

    await expect(pending).resolves.toBe(true);
    expect(mocks.appendBackupHistory).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'restore', status: 'restored', filename: 'restore.trip', bytes: 6,
      mediaChecked: 6, mediaFailed: 0, trips: 2, segments: 3, chunks: 4,
      waypoints: 5, media: 6, source: 'manual'
    }));
    expect(mocks.emit).toHaveBeenCalledWith('backup:restored', { restored: 2, filename: 'restore.trip' });
    expect(onRestored).toHaveBeenCalledWith(2);
  });

  it('records restore failure after a verified inspection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.restoreBackup.mockRejectedValueOnce(new Error('transaction failed'));
    const file = new File(['backup'], 'broken.trip');
    const pending = restoreBackupFlow(file);
    await vi.waitFor(() => expect(document.querySelector('.modal-backdrop .btn.primary')).toBeTruthy());
    document.querySelector<HTMLButtonElement>('.modal-backdrop .btn.primary')!.click();

    await expect(pending).resolves.toBe(false);
    expect(mocks.appendBackupHistory).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'restore', status: 'failed', filename: 'broken.trip', mediaChecked: 6, mediaFailed: 0
    }));
    expect(mocks.emit).not.toHaveBeenCalledWith('backup:restored', expect.anything());
  });

  it('shows actionable restore-limit guidance instead of a generic error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error(
      'backup file too large: the restore limit is 256 MiB. Export selected trips to GPX; GPX does not include media or share-import history.'
    ), { code: 'backup-limit-exceeded' });
    mocks.inspectBackup.mockRejectedValueOnce(error);

    await expect(restoreBackupFlow(new File(['backup'], 'large.trip'))).resolves.toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(error.message, 'err', 7000);
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });
});
