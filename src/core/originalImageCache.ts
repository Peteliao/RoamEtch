export const ORIGINAL_IMAGE_CACHE_COUNT = 10;
export const ORIGINAL_IMAGE_CACHE_BYTES = 50 * 1024 * 1024;

export type OriginalImageMeta = {
  fileId: string;
  sha256: string;
  size: number;
  mime: string;
  width: number;
  height: number;
};

export type CachedOriginalImage = OriginalImageMeta & {
  blob: Blob;
  createdAt: number;
  lastUsed: number;
};

export class OriginalImageCache {
  private entries = new Map<string, CachedOriginalImage>();
  private bytes = 0;

  constructor(
    private maxCount = ORIGINAL_IMAGE_CACHE_COUNT,
    private maxBytes = ORIGINAL_IMAGE_CACHE_BYTES
  ) {}

  put(entry: CachedOriginalImage) {
    if (!entry?.fileId || !(entry.blob instanceof Blob) || entry.blob.size !== entry.size || entry.size > this.maxBytes) return false;
    this.delete(entry.fileId);
    this.entries.set(entry.fileId, { ...entry });
    this.bytes += entry.size;
    this.evict();
    return this.entries.has(entry.fileId);
  }

  get(fileId: string) {
    const entry = this.entries.get(fileId);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    this.entries.delete(fileId);
    this.entries.set(fileId, entry);
    return entry;
  }

  delete(fileId: string) {
    const entry = this.entries.get(fileId);
    if (!entry) return false;
    this.entries.delete(fileId);
    this.bytes -= entry.size;
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  get byteSize() {
    return this.bytes;
  }

  private evict() {
    while (this.entries.size > this.maxCount || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.delete(oldest[0]);
    }
  }
}
