import { describe, expect, it } from 'vitest';
import { stripSharedSentences } from './state-envelope.js';

describe('System One state envelope', () => {
  it('removes an exact shared prefix when both distinct claims remain', () => {
    expect(stripSharedSentences(
      'Background note: plants were watered. The gateway accepts signed requests.',
      'Background note: plants were watered. The gateway rejects unsigned requests.',
    )).toEqual([
      'The gateway accepts signed requests.',
      'The gateway rejects unsigned requests.',
    ]);
  });

  it('removes an exact shared suffix', () => {
    expect(stripSharedSentences(
      'The gateway accepts signed requests. The kitchen rota is complete.',
      'The gateway rejects unsigned requests. The kitchen rota is complete.',
    )).toEqual([
      'The gateway accepts signed requests.',
      'The gateway rejects unsigned requests.',
    ]);
  });

  it('preserves the original pair if stripping would empty either side', () => {
    const left = 'The gateway accepts signed requests.';
    const right = 'The gateway accepts signed requests. Tests confirm this behaviour.';
    expect(stripSharedSentences(left, right)).toEqual([left, right]);
  });

  it('does not remove merely similar sentences', () => {
    const left = 'The timeout is three seconds.';
    const right = 'The timeout is four seconds.';
    expect(stripSharedSentences(left, right)).toEqual([left, right]);
  });
});
