// 集計期間: 日本時間の毎月1日 06:00 JST から翌月1日 06:00 JST まで。
// JST は UTC+9 固定（日本に夏時間は無い）ので、オフセット計算で完結させる。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_BOUNDARY_HOUR = 6;

/** UTC epoch(ms) -> その時刻が属する「JST 6時始まり」の月キー "YYYY-MM" */
export function periodKeyOf(epochMs: number): string {
  // JST の壁時計に変換したうえで 6 時間戻すと、6:00 始まりの日付境界に揃う。
  const shifted = new Date(epochMs + JST_OFFSET_MS - DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** "YYYY-MM" -> { startMs, endMs } (endMs は排他) */
export function periodRange(key: string): { startMs: number; endMs: number } {
  const [y, m] = key.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, 1, DAY_BOUNDARY_HOUR) - JST_OFFSET_MS;
  const endMs = Date.UTC(y, m, 1, DAY_BOUNDARY_HOUR) - JST_OFFSET_MS;
  return { startMs, endMs };
}

/** "YYYY-MM" の1つ前の月キー。年またぎも扱う (2026-01 -> 2025-12) */
export function previousPeriodKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}
