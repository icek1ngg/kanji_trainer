/**
 * Pure helpers for parsing Sino-Vietnamese readings and checking an answer.
 *
 * This module deliberately has no UI, storage, or browser dependencies. It is
 * safe to use from every practice mode once those modes are implemented.
 */

const READING_SEPARATOR = /[\/;｜]/u;
const READING_SEPARATOR_SPLIT = /[\/;｜]/u;

// A reading is made of Latin letters (including Vietnamese letters), optional
// combining marks, and optional whitespace between words. Punctuation, digits,
// separators, and control characters are not readings.
const READING_TOKEN = /^(?:(?:\p{Script=Latin}\p{M}*)+)(?: +(?:(?:\p{Script=Latin}\p{M}*)+))*$/u;

export const READING_REASONS = Object.freeze({
  EMPTY_INPUT: 'empty_input',
  INVALID_INPUT: 'invalid_input',
  MALFORMED_INPUT: 'malformed_input',
  DUPLICATE_READINGS: 'duplicate_readings',
  INVALID_REQUIRED_READINGS: 'invalid_required_readings',
  READINGS_MISMATCH: 'readings_mismatch',
});

/**
 * Normalize one reading without transliterating or removing Vietnamese marks.
 * NFC is applied after uppercasing as well because case conversion can produce
 * combining sequences in some Unicode scripts.
 */
export function normalizeReading(value) {
  if (typeof value !== 'string') throw new TypeError('A reading must be a string.');
  return value.normalize('NFC').trim().toUpperCase().normalize('NFC');
}

function invalidResult(readings, reason) {
  return { readings, isValid: false, reason };
}

/**
 * Parse a submitted answer. Separators are intentionally limited to `/`, `;`,
 * and the full-width vertical bar `｜`. Empty segments remain in `readings` so
 * malformed input can never be silently accepted.
 */
export function parseReadings(input) {
  if (typeof input !== 'string') {
    return invalidResult([], READING_REASONS.INVALID_INPUT);
  }

  if (!input.trim()) {
    return invalidResult([], READING_REASONS.EMPTY_INPUT);
  }

  const readings = input.split(READING_SEPARATOR_SPLIT).map(normalizeReading);
  if (readings.some(reading => reading.length === 0)) {
    return invalidResult(readings, READING_REASONS.MALFORMED_INPUT);
  }
  if (readings.some(reading => !READING_TOKEN.test(reading))) {
    return invalidResult(readings, READING_REASONS.MALFORMED_INPUT);
  }

  const uniqueReadings = new Set(readings);
  if (uniqueReadings.size !== readings.length) {
    return invalidResult(readings, READING_REASONS.DUPLICATE_READINGS);
  }

  return { readings, isValid: true, reason: null };
}

/** Return the number of stored readings without changing or deduplicating them. */
export function getReadingCount(hanViet) {
  if (!Array.isArray(hanViet)) throw new TypeError('hanViet must be an array.');
  return hanViet.length;
}

/** Return the user-facing Vietnamese count label used beside a Kanji. */
export function getReadingCountLabel(hanViet) {
  return `${getReadingCount(hanViet)} âm`;
}

function normalizeRequiredReadings(requiredReadings) {
  if (!Array.isArray(requiredReadings) || requiredReadings.length === 0) return null;

  // Array.from visits sparse slots as undefined. That makes sparse data fail
  // validation rather than disappearing through Array.prototype.map holes.
  const normalized = Array.from(requiredReadings, value => {
    if (typeof value !== 'string') return null;
    if (READING_SEPARATOR.test(value)) return null;
    const reading = normalizeReading(value);
    if (!reading || !READING_TOKEN.test(reading)) return null;
    return reading;
  });

  if (normalized.some(reading => reading === null)) return null;
  if (new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

/**
 * Check all submitted readings against all required readings.
 *
 * The result intentionally contains counts and submitted values only; required
 * values are never copied into it, which prevents an accidental answer reveal.
 */
export function validateAnswer(input, requiredReadings) {
  const requiredCount = Array.isArray(requiredReadings) ? requiredReadings.length : 0;
  const parsed = parseReadings(input);
  const submittedReadings = parsed.readings;
  const submittedCount = submittedReadings.length;
  const validRequired = normalizeRequiredReadings(requiredReadings);

  if (!validRequired) {
    return {
      isCorrect: false,
      submittedReadings,
      requiredCount,
      submittedCount,
      reason: READING_REASONS.INVALID_REQUIRED_READINGS,
    };
  }

  if (!parsed.isValid) {
    return {
      isCorrect: false,
      submittedReadings,
      requiredCount,
      submittedCount,
      reason: parsed.reason,
    };
  }

  const requiredSet = new Set(validRequired);
  const isCorrect = submittedCount === requiredCount
    && submittedReadings.every(reading => requiredSet.has(reading));

  return {
    isCorrect,
    submittedReadings,
    requiredCount,
    submittedCount,
    reason: isCorrect ? null : READING_REASONS.READINGS_MISMATCH,
  };
}

