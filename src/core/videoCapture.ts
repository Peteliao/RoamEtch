// Canvas + MediaRecorder helpers shared by trip recaps and footprint clips.
export const videoSupported = () =>
  typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

export function pickVideoMime(hasAudio = false) {
  const candidates = hasAudio ? [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ] : [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function videoIsWebmOnly(hasAudio = false) {
  return videoSupported() && !pickVideoMime(hasAudio).startsWith('video/mp4');
}

export function makeVideoRecorder(stream: MediaStream, hasAudio = false) {
  const mime = pickVideoMime(hasAudio);
  const options: MediaRecorderOptions = { videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 };
  if (mime) options.mimeType = mime;
  try {
    return new MediaRecorder(stream, options);
  } catch {
    try { return new MediaRecorder(stream, { videoBitsPerSecond: 6_000_000 }); }
    catch { return new MediaRecorder(stream); }
  }
}
