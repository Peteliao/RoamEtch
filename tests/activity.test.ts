import { describe, expect, it } from 'vitest';
import { classifyActivity } from '../src/core/activity';

describe('auto activity classifier', () => {
  it('keeps hiking and running samples in their own envelopes', () => {
    expect(classifyActivity(Array(6).fill(1.5))).toBe('hike');
    expect(classifyActivity(Array(6).fill(2.8))).toBe('run');
  });

  it('recognises sustained high-speed rail as travel', () => {
    expect(classifyActivity(Array(6).fill(90))).toBe('travel');
  });

  it('does not mistake stop-and-go driving for high-speed travel', () => {
    expect(classifyActivity([1.5, 1.5, 1.5, 9, 9, 9])).toBe('drive');
    expect(classifyActivity([1.5, 1.5, 1.5, 60, 60, 60])).toBe('travel');
  });

  it('ignores impossible samples instead of letting them poison classification', () => {
    expect(classifyActivity([1.5, 1.5, 1.5, 300, 300, 300])).toBeNull();
  });
});
