import { describe, expect, it } from 'vitest';
import { getReadingCount, getReadingCountLabel, normalizeReading, parseReadings, validateAnswer } from './readings.js';

const required = Object.freeze(['TÁN', 'TẢN']);

describe('all readings of 散 are required', () => {
  it.each([
    ['TÁN', false], ['TẢN', false], ['TÁN/TẢN', true],
    ['TẢN/TÁN', true], ['tán/tản', true], [' TÁN / TẢN ', true],
    ['TÁN;TẢN', true], ['TÁN｜TẢN', true], ['TÁN/TÁN', false],
    ['TÁN/TẢN/TÁN', false], ['TAN/TAN', false], ['TÁN/TẢN/OTHER', false],
    ['TAN/TẢN', false], ['TÁN/TAN', false], ['TẢN/TẢN', false],
  ])('%s => %s', (input, expected) => {
    expect(validateAnswer(input, required).isCorrect).toBe(expected);
  });

  it('returns counts and normalized submissions without exposing the answer', () => {
    expect(validateAnswer(' tán ', required)).toEqual({
      isCorrect: false, submittedReadings: ['TÁN'], requiredCount: 2,
      submittedCount: 1, reason: 'readings_mismatch',
    });
    expect(validateAnswer('tản/tán', required)).toEqual({
      isCorrect: true, submittedReadings: ['TẢN', 'TÁN'], requiredCount: 2,
      submittedCount: 2, reason: null,
    });
  });
});

describe('normalization and parsing', () => {
  it('normalizes both answer and reference to NFC and uppercase', () => {
    const decomposed = 'tán/tản'.normalize('NFD');
    expect(validateAnswer(decomposed, required).isCorrect).toBe(true);
    expect(validateAnswer('TẢN/TÁN', [' tán '.normalize('NFD'), 'tản']).isCorrect).toBe(true);
    expect(normalizeReading(' \tđặng\n')).toBe('ĐẶNG');
    expect(normalizeReading(' tản '.normalize('NFD'))).toBe('TẢN');
  });

  it('preserves diacritics, including đ versus d', () => {
    expect(validateAnswer('DẠI', ['ĐẠI']).isCorrect).toBe(false);
    expect(validateAnswer('đại', ['ĐẠI']).isCorrect).toBe(true);
    expect(validateAnswer('hoc', ['HỌC']).isCorrect).toBe(false);
  });

  it('supports mixed separators without silently dropping empty tokens', () => {
    expect(parseReadings(' A / B ; C ｜ D ')).toEqual({ readings: ['A', 'B', 'C', 'D'], isValid: true, reason: null });
    expect(parseReadings('TÁN//TẢN').readings).toEqual(['TÁN', '', 'TẢN']);
  });

  it.each(['', '   ', '/TÁN/TẢN', 'TÁN/TẢN/', 'TÁN//TẢN', 'TÁN;;TẢN', 'TÁN; /TẢN', 'TÁN｜｜TẢN', 'TÁN/ /TẢN', 'TÁN,TẢN', 'TÁN|TẢN', 'TÁN/TẢN!', 'TÁN/123', 'TÁN/TẢN\u0000', 'TÁN/\u200bTẢN'])('rejects malformed input %j', input => {
    expect(parseReadings(input).isValid).toBe(false);
    expect(validateAnswer(input, required).isCorrect).toBe(false);
  });

  it.each([undefined, null, 42, {}, ['TÁN', 'TẢN']])('rejects non-string submission %j', input => {
    expect(parseReadings(input)).toEqual({ readings: [], isValid: false, reason: 'invalid_input' });
    expect(validateAnswer(input, required).isCorrect).toBe(false);
  });

  it('rejects normalized duplicates even if case or Unicode form differs', () => {
    expect(parseReadings('tán/TÁN').reason).toBe('duplicate_readings');
    expect(parseReadings(`TÁN/${'TÁN'.normalize('NFD')}`).reason).toBe('duplicate_readings');
  });

  it.each(['TÁN\nTẢN', 'TÁN\tTẢN', 'TÁN\rTẢN', 'TÁN\u2028TẢN'])('rejects embedded control or line whitespace %j', input => {
    expect(parseReadings(input)).toMatchObject({ isValid: false, reason: 'malformed_input' });
    expect(validateAnswer(input, [input])).toMatchObject({ isCorrect: false, reason: 'invalid_required_readings' });
  });

  it('still ignores whitespace surrounding individual segments', () => {
    expect(validateAnswer('\tTÁN\n /\r TẢN\t', required).isCorrect).toBe(true);
  });

  it('does not mutate caller data or accept an invalid reference set', () => {
    for (const invalid of [[], undefined, null, 'TÁN/TẢN', [''], [' '], ['TÁN', 'tán'], ['TÁN/TẢN'], [null], Array(2)]) {
      expect(validateAnswer('TÁN/TẢN', invalid)).toMatchObject({ isCorrect: false, reason: 'invalid_required_readings' });
    }
    const reference = Object.freeze([' TÁN ', 'TẢN'.normalize('NFD')]);
    validateAnswer('tản/tán', reference);
    expect(reference).toEqual([' TÁN ', 'TẢN'.normalize('NFD')]);
  });
});

describe('reading counts and arbitrary set sizes', () => {
  it('calculates labels from the current array and updates after editing', () => {
    const readings = ['HỌC'];
    expect(getReadingCount(readings)).toBe(1);
    expect(getReadingCountLabel(readings)).toBe('1 âm');
    readings.push('TẢN');
    expect(getReadingCountLabel(readings)).toBe('2 âm');
    expect(getReadingCount([])).toBe(0);
    expect(getReadingCountLabel(['A', 'B', 'C'])).toBe('3 âm');
    expect(() => getReadingCount(null)).toThrow(TypeError);
  });

  it('handles one reading without a separator', () => {
    expect(validateAnswer(' học ', ['HỌC']).isCorrect).toBe(true);
    expect(validateAnswer('HỌC/SINH', ['HỌC']).isCorrect).toBe(false);
  });

  it('compares all permutations of three readings and rejects equal-sized wrong sets', () => {
    const reference = ['A', 'B', 'C'];
    for (const input of ['A/B/C', 'A/C/B', 'B/A/C', 'B/C/A', 'C/A/B', 'C/B/A']) {
      expect(validateAnswer(input, reference).isCorrect).toBe(true);
    }
    expect(validateAnswer('A/B/D', reference).isCorrect).toBe(false);
    expect(validateAnswer('A/B/A', reference).isCorrect).toBe(false);
  });
});
