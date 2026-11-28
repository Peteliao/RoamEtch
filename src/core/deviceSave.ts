import { t } from './i18n';

// The web platform has no silent "save to Photos". A full-resolution capture is
// handed to the system share sheet (which can store it in the device gallery),
// then to the File System Access picker, and finally to a plain download.

export type DeviceSaveResult = 'shared' | 'picked' | 'downloaded' | 'cancelled' | 'failed';

function photoFileName(takenAt: number) {
  const d = new Date(takenAt || Date.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `roametch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

function shareSupported(file: File) {
  try {
    return !!navigator.share && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

export async function saveOriginalPhoto(blob: Blob, takenAt = Date.now()): Promise<DeviceSaveResult> {
  if (!(blob instanceof Blob) || !blob.size) return 'failed';
  const type = blob.type || 'image/jpeg';
  const name = photoFileName(takenAt);
  let file: File;
  try {
    file = new File([blob], name, { type, lastModified: takenAt });
  } catch {
    file = blob as any;
    (file as any).name = name;
  }

  if (shareSupported(file)) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }

  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: t('common.jpegImage'), accept: { [type || 'image/jpeg']: ['.jpg', '.jpeg'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return 'picked';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
