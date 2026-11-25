let audio: AudioContext | null = null;

export function unlockChatNotificationSound() {
  const AudioContextClass = globalThis.AudioContext || (globalThis as any).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audio) audio = new AudioContextClass();
  if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
  return audio;
}

export function playChatNotificationSound() {
  if (!audio) return false;
  if (audio.state === 'suspended') {
    void audio.resume().then(() => playChatNotificationSound()).catch(() => undefined);
    return false;
  }
  if (audio.state !== 'running') return false;
  const start = audio.currentTime;
  for (const [index, frequency] of [660, 880].entries()) {
    const offset = index * 0.085;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.045, start + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.13);
  }
  return true;
}
