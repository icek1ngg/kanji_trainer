import {
  assertPracticeAttempt,
  compareAttempts,
} from './history.js';

/**
 * Build all dashboard and statistics data from immutable local snapshots.
 *
 * The function deliberately treats individual attempts as the lifetime source
 * of truth.  Session counters describe a live draft and are reported beside
 * (rather than added to) the recorded-attempt totals.
 */
export function buildStatistics({
  records = [],
  attempts = [],
  sessions = [],
  now = new Date(),
  timeZone = 'Asia/Ho_Chi_Minh',
  days = 14,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be an array.');
  if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array.');

  const nowDate = toDate(now);
  const requestedDays = normalizeDays(days);
  // Constructing a formatter validates the supplied IANA timezone before any
  // work is performed.  All date grouping below uses this same timezone.
  const dateFormatter = createDateFormatter(timeZone);

  const liveRecords = normalizeRecords(records);
  const recordsById = new Map(liveRecords.map(record => [record.id, record]));
  const recognized = [];
  let ignoredAttempts = 0;
  const seenAttemptIds = new Set();
  for (const candidate of attempts) {
    try {
      assertPracticeAttempt(candidate);
    } catch {
      ignoredAttempts += 1;
      continue;
    }
    // IndexedDB keys are unique.  A caller can still provide a concatenated
    // snapshot containing a duplicate, so count each immutable event once.
    if (seenAttemptIds.has(candidate.id)) continue;
    seenAttemptIds.add(candidate.id);
    recognized.push(cloneAttempt(candidate));
  }

  const history = [...recognized].sort(compareNewest).map(attempt => ({
    ...cloneAttempt(attempt),
    deleted: !recordsById.has(attempt.kanjiId),
  }));
  const latestByKanji = latestAttemptsByKanji(recognized);
  const attemptsByKanji = groupAttemptsByKanji(recognized);

  const latest = {
    correct: 0,
    incorrect: 0,
    unanswered: 0,
    practiced: 0,
  };
  for (const record of liveRecords) {
    const attempt = latestByKanji.get(record.id);
    if (!attempt) {
      latest.unanswered += 1;
    } else if (attempt.isCorrect) {
      latest.correct += 1;
      latest.practiced += 1;
    } else {
      latest.incorrect += 1;
      latest.practiced += 1;
    }
  }

  const correct = recognized.filter(attempt => attempt.isCorrect).length;
  const totals = {
    attempts: recognized.length,
    correct,
    incorrect: recognized.length - correct,
    accuracy: recognized.length ? Math.round((correct / recognized.length) * 100) : 0,
  };

  const recentKanji = [...latestByKanji.entries()]
    .sort((left, right) => compareNewest(left[1], right[1]))
    .slice(0, 8)
    .map(([id, latestAttempt]) => joinKanjiSnapshot(id, latestAttempt, recordsById));

  const difficultKanji = [...attemptsByKanji.entries()]
    .map(([id, grouped]) => {
      const current = recordsById.get(id);
      const snapshot = current ?? grouped.latest;
      const total = grouped.attempts.length;
      return {
        id,
        kanji: snapshot.kanji,
        hanViet: current ? [...current.hanViet] : [...grouped.latest.requiredReadings],
        deleted: !current,
        incorrect: grouped.incorrect,
        total,
        accuracy: total ? Math.round(((total - grouped.incorrect) / total) * 100) : 0,
        _latest: grouped.latest,
      };
    })
    // A difficult list is for Kanji that still have an incorrect recorded
    // answer.  Correct-only history belongs in lifetime/latest totals but
    // should not make the "most frequently incorrect" list look populated.
    .filter(item => item.incorrect > 0)
    .sort((left, right) => {
      if (right.incorrect !== left.incorrect) return right.incorrect - left.incorrect;
      if (right.total !== left.total) return right.total - left.total;
      return left.id.localeCompare(right.id);
    })
    .slice(0, 10)
    .map(({ _latest, ...item }) => item);

  const activity = buildActivity(recognized, nowDate, dateFormatter, requestedDays, timeZone);
  const recentSessions = buildRecentSessions(sessions, recognized);

  return {
    library: {
      total: liveRecords.length,
      multiReading: liveRecords.filter(record => record.hanViet.length > 1).length,
    },
    totals,
    latest,
    recentKanji,
    difficultKanji,
    activity,
    recentSessions,
    history,
    ignoredAttempts,
  };
}

function normalizeRecords(records) {
  const seen = new Set();
  const normalized = [];
  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) continue;
    if (typeof candidate.kanji !== 'string' || !candidate.kanji.trim()) continue;
    if (!Array.isArray(candidate.hanViet) || candidate.hanViet.length === 0
      || candidate.hanViet.some(reading => typeof reading !== 'string' || !reading.trim())) continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    normalized.push({ ...candidate, hanViet: [...candidate.hanViet] });
  }
  return normalized;
}

function cloneAttempt(attempt) {
  return {
    ...attempt,
    requiredReadings: [...attempt.requiredReadings],
  };
}

function compareNewest(left, right) {
  return compareAttempts(right, left);
}

function latestAttemptsByKanji(attempts) {
  const latest = new Map();
  for (const attempt of attempts) {
    const current = latest.get(attempt.kanjiId);
    if (!current || compareAttempts(current, attempt) < 0) latest.set(attempt.kanjiId, attempt);
  }
  return latest;
}

function groupAttemptsByKanji(attempts) {
  const grouped = new Map();
  for (const attempt of attempts) {
    const current = grouped.get(attempt.kanjiId) ?? { attempts: [], incorrect: 0, latest: attempt };
    current.attempts.push(attempt);
    if (!attempt.isCorrect) current.incorrect += 1;
    if (compareAttempts(current.latest, attempt) < 0) current.latest = attempt;
    grouped.set(attempt.kanjiId, current);
  }
  return grouped;
}

function joinKanjiSnapshot(id, latestAttempt, recordsById) {
  const current = recordsById.get(id);
  return {
    id,
    kanji: current?.kanji ?? latestAttempt.kanji,
    hanViet: current ? [...current.hanViet] : [...latestAttempt.requiredReadings],
    deleted: !current,
    latestAttempt: cloneAttempt(latestAttempt),
  };
}

function toDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date.');
  return date;
}

function normalizeDays(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError('days must be an integer.');
  }
  return Math.min(365, Math.max(0, value));
}

function createDateFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function localDate(value, formatter) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateRange(endDate, count) {
  if (count === 0) return [];
  const [year, month, day] = endDate.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const result = new Date(Date.UTC(year, month - 1, day - (count - 1 - index)));
    return result.toISOString().slice(0, 10);
  });
}

function buildActivity(attempts, nowDate, formatter, days, timeZone) {
  if (!days) return [];
  const today = localDate(nowDate, formatter);
  const dates = dateRange(today, days);
  const counts = new Map(dates.map(date => [date, { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, correct: 0, incorrect: 0, total: 0 }]));
  for (const attempt of attempts) {
    const date = localDate(attempt.createdAt, formatter);
    // Keep the chart bounded to the requested calendar window.  A future
    // clock value on today's date remains a stored event; later calendar
    // dates never appear in the activity chart.
    if (!date || date > today || !counts.has(date)) continue;
    const item = counts.get(date);
    item.total += 1;
    if (attempt.isCorrect) item.correct += 1;
    else item.incorrect += 1;
  }
  // `timeZone` is intentionally accepted by this helper's signature to make
  // the calendar boundary explicit to callers and tests.
  void timeZone;
  return dates.map(date => counts.get(date));
}

const SESSION_MODES = new Set(['table', 'flashcard', 'wrong']);

function buildRecentSessions(sessions, attempts) {
  const attemptsBySession = new Map();
  for (const attempt of attempts) {
    const list = attemptsBySession.get(attempt.sessionId) ?? [];
    list.push(attempt);
    attemptsBySession.set(attempt.sessionId, list);
  }
  return sessions
    .map(session => recognizeSession(session, attemptsBySession.get(session?.id) ?? []))
    .filter(Boolean)
    .sort((left, right) => {
      const updated = timeValue(right.updatedAt) - timeValue(left.updatedAt);
      if (updated) return updated;
      const created = timeValue(right.createdAt) - timeValue(left.createdAt);
      if (created) return created;
      return left.id.localeCompare(right.id);
    })
    .slice(0, 10);
}

function recognizeSession(session, sessionAttempts) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  if (typeof session.id !== 'string' || !session.id.trim() || !SESSION_MODES.has(session.mode)) return null;
  if (typeof session.active !== 'boolean' || !Array.isArray(session.items) || session.items.length === 0) return null;
  if (!isTimestamp(session.createdAt) || !isTimestamp(session.updatedAt)) return null;
  const current = { total: session.items.length, correct: 0, incorrect: 0, unanswered: 0 };
  for (const item of session.items) {
    if (!item || typeof item !== 'object' || typeof item.answer !== 'string'
      || (item.checkedAnswer !== null && typeof item.checkedAnswer !== 'string')
      || (item.result !== null && typeof item.result !== 'boolean')) return null;
    const checked = item.checkedAnswer !== null && item.checkedAnswer === item.answer && typeof item.result === 'boolean';
    if (!checked) current.unanswered += 1;
    else if (item.result) current.correct += 1;
    else current.incorrect += 1;
  }
  const correct = sessionAttempts.filter(attempt => attempt.isCorrect).length;
  const attemptsCount = sessionAttempts.length;
  const result = {
    id: session.id,
    mode: session.mode,
    active: session.active,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    attempts: attemptsCount,
    correct,
    incorrect: attemptsCount - correct,
    accuracy: attemptsCount ? Math.round((correct / attemptsCount) * 100) : 0,
    current,
  };
  if (Number.isSafeInteger(session.checks) && session.checks >= attemptsCount) {
    const legacyChecks = session.checks - attemptsCount;
    if (legacyChecks > 0) result.legacyChecks = legacyChecks;
  }
  return result;
}

function isTimestamp(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function timeValue(value) {
  const result = Date.parse(value ?? '');
  return Number.isNaN(result) ? Number.NEGATIVE_INFINITY : result;
}

