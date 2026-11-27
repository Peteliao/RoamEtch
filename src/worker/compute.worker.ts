// Background compute: stats, splits, simplification, formats, annual stats,
// backup archive building and streaming GPX parsing.
import { streamGPX } from '../core/gpxStream';
import { decodeWorkerPayload } from '../core/workerPayload';
import { runComputeTask } from './computeTasks';

const streamAcks = new Map<string, Map<number, () => void>>();

function errorMessage(error: any) {
  return String(error?.message || error);
}

function postFailure(id: string | number, session: string, error: any) {
  self.postMessage({
    id, session, ok: false,
    error: errorMessage(error),
    name: error?.name,
    code: error?.code,
    stack: error?.stack
  });
}

async function runStream(id: string | number, session: string, file: Blob, singlePass: boolean) {
  const key = `${id}:${session}`;
  const acks = new Map<number, () => void>();
  streamAcks.set(key, acks);
  let seq = 0;
  try {
    const result = await streamGPX(file, async (event) => {
      const eventSeq = ++seq;
      const ack = new Promise<void>((resolve) => acks.set(eventSeq, resolve));
      self.postMessage({ id, session, type: 'gpx-event', seq: eventSeq, event });
      await ack;
    }, {
      singlePass,
      onProgress: (loaded, total) => self.postMessage({ id, session, type: 'gpx-progress', loaded, total })
    });
    self.postMessage({ id, session, ok: true, result });
  } catch (error) {
    postFailure(id, session, error);
  } finally {
    streamAcks.delete(key);
  }
}

self.onmessage = async (e) => {
  const data = e.data || {};
  const { id, session, type, ack } = data;
  if (type == null && ack != null) {
    streamAcks.get(`${id}:${session}`)?.get(ack)?.();
    return;
  }
  if (type === 'stream-gpx') {
    await runStream(id, session, data.payload?.file, data.payload?.singlePass !== false);
    return;
  }
  try {
    const payload = decodeWorkerPayload(data.payload);
    const result = runComputeTask(type, payload);
    if (result && typeof result.then === 'function') {
      result.then(
        (value: any) => self.postMessage({ id, session, ok: true, result: value }),
        (err: any) => postFailure(id, session, err)
      );
    } else {
      self.postMessage({ id, session, ok: true, result });
    }
  } catch (err) {
    postFailure(id, session, err);
  }
};
