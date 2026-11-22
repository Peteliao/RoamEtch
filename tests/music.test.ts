import { describe, expect, it } from 'vitest';
import {
  MUSIC_TRACKS, MUSIC_PREF_RANDOM, composeLoop, isMusicTrackId,
  midiToFreq, musicLoopSeconds, noteName, resolveMusicTrack
} from '../src/core/music';

describe('video music', () => {
  it('ships four distinct procedural tracks', () => {
    expect(MUSIC_TRACKS).toHaveLength(4);
    expect(new Set(MUSIC_TRACKS.map((track) => track.id)).size).toBe(4);
    expect(MUSIC_TRACKS.every((track) => track.labelKey.startsWith('music.'))).toBe(true);
  });

  it('resolves a manual choice and otherwise shuffles', () => {
    expect(resolveMusicTrack('ridge', () => 0).id).toBe('ridge');
    expect(resolveMusicTrack(MUSIC_PREF_RANDOM, () => 0).id).toBe(MUSIC_TRACKS[0].id);
    expect(resolveMusicTrack(MUSIC_PREF_RANDOM, () => 0.999999).id).toBe(MUSIC_TRACKS[MUSIC_TRACKS.length - 1].id);
    expect(resolveMusicTrack('not-a-track', () => 0.5).id).toBe(MUSIC_TRACKS[2].id);
    expect(isMusicTrackId('star')).toBe(true);
    expect(isMusicTrackId('random')).toBe(false);
  });

  it('composes sustained pad, bass, pluck and bell voices inside the loop', () => {
    for (const track of MUSIC_TRACKS) {
      const { events, loopSeconds, beatsPerBar } = composeLoop(track);
      expect(beatsPerBar).toBe(4);
      expect(loopSeconds).toBeCloseTo(musicLoopSeconds(track), 6);
      expect(events.length).toBeGreaterThan(30);
      for (const event of events) {
        expect(event.beat).toBeGreaterThanOrEqual(0);
        expect(event.beat).toBeLessThan(track.bars * 4);
        expect(event.dur).toBeGreaterThan(0);
        expect(event.midi).toBeGreaterThan(20);
        expect(event.midi).toBeLessThan(100);
        expect(event.gain).toBeGreaterThan(0);
        expect(['pad', 'pluck', 'bass', 'bell']).toContain(event.voice);
      }
      expect(events.some((event) => event.voice === 'pad')).toBe(true);
      expect(events.some((event) => event.voice === 'bass')).toBe(true);
      expect(events.some((event) => event.voice === 'pluck')).toBe(true);
    }
  });

  it('keeps track tempos and note helpers sane', () => {
    for (const track of MUSIC_TRACKS) {
      const loop = musicLoopSeconds(track);
      expect(loop).toBeGreaterThan(8);
      expect(loop).toBeLessThan(20);
      expect(track.brightness).toBeGreaterThan(800);
    }
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(noteName(69)).toBe('A4');
    expect(noteName(60)).toBe('C4');
  });
});
