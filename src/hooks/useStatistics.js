import { useCallback, useEffect, useRef, useState } from 'react';
import { openDatabase } from '../data/index.js';
import { readStatisticsSnapshot } from '../data/statistics.js';
import { buildStatistics } from '../domain/statistics.js';

/**
 * Load the read-only statistics projection used by the dashboard and the
 * statistics page.  A request token keeps a slower request from an earlier
 * mount (or a StrictMode probe) from replacing a newer result.
 */
export function useStatistics({ days = 14, timeZone = 'Asia/Ho_Chi_Minh' } = {}) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const statsRef = useRef(null);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const hasStats = Boolean(statsRef.current);
    if (mountedRef.current) {
      setLoading(!hasStats);
      setRefreshing(hasStats);
      setError(null);
    }

    let db;
    try {
      db = await openDatabase();
      const snapshot = await readStatisticsSnapshot(db);
      const next = buildStatistics({
        ...snapshot,
        now: new Date(),
        timeZone,
        days,
      });
      if (!mountedRef.current || requestId !== requestRef.current) return next;
      statsRef.current = next;
      setStats(next);
      setLastUpdated(new Date());
      setError(null);
      return next;
    } catch (cause) {
      if (mountedRef.current && requestId === requestRef.current) {
        // Keep a previous successful projection visible while making the
        // refresh failure explicit.  A failed read must never look like zero.
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      return null;
    } finally {
      db?.close?.();
      if (mountedRef.current && requestId === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [days, timeZone]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, [load]);

  // Returning to the tab is a convenient way to see checks made in another
  // route or tab without introducing polling or any database writes.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  return {
    stats,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh: load,
  };
}

export default useStatistics;
