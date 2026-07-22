// CI(月イチ)で「集計すべき期間 = 前月の YYYY-MM」を標準出力に1行だけ吐く。
// 月初に走らせる前提。今の JST 時刻が属する期間を出し、その1つ前を返す。
// GitHub Actions のランナーは UTC だが、periodKeyOf が JST 基準で計算するので安全。
//
// 使い方: node --import tsx scripts/target-period.ts        -> 前月 (例: 2026-06)
//         node --import tsx scripts/target-period.ts --this -> 当月（手動再集計用）
import { periodKeyOf, previousPeriodKey } from '../src/period.js';

const current = periodKeyOf(Date.now());
const out = process.argv.includes('--this') ? current : previousPeriodKey(current);
process.stdout.write(out);
