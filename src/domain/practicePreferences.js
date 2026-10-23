/** Apply a default only when starting a new session, never to a saved draft. */
export function selectPracticeRecords(records, size = 'all') {
  return size === 'all' ? records : records.slice(0, Number(size));
}
