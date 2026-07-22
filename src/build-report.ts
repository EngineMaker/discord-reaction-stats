import type { UserRow, ReactionRow, PostCountRow } from './db.js';

// 絞り込み対象のロール。リアクションが0件でもランキングに載せる。
const FOCUS_ROLE = 'EM住民';

// query だけ持てばよい最小インターフェース。CLI は pg.Pool、Functions は
// @neondatabase/serverless の Pool を渡す。どちらも { rows } を返すので共通で扱える。
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

// Neon を読んでレポート HTML を組み立てて返す純粋な処理。
// CLI (report.ts) と Cloudflare Pages Functions の両方から呼ぶ。
// DB プールは呼び出し側が用意し、閉じるのも呼び出し側の責務（ここでは閉じない）。
export async function buildReportHtml(db: Queryable, includeBots = false): Promise<string> {
const botFilter = includeBots ? '' : `AND g.is_bot = 0 AND r.is_bot = 0`;

const rows = (
  await db.query(
    `SELECT rx.period, rx.emoji_key, rx.emoji_label, rx.emoji_url,
            rx.giver_id, rx.receiver_id
     FROM reactions rx
     JOIN users g ON g.user_id = rx.giver_id
     JOIN users r ON r.user_id = rx.receiver_id
     WHERE rx.giver_id != rx.receiver_id ${botFilter}`
  )
).rows as ReactionRow[];

const users: Record<string, UserRow> = Object.fromEntries(
  (
    await db.query('SELECT user_id, display_name, avatar_url, is_bot, is_member, roles FROM users')
  ).rows.map((u) => [(u as UserRow).user_id, u as UserRow])
);

// 投稿数。リアクションと違い自己リアクション除外のような絞りは不要で、素直に数える。
// messages が空（投稿数対応より前にスキャンした DB）の場合は投稿数の表示自体を出さない。
// COUNT(*) は Postgres では bigint=文字列で返るので Number() で数値に直す。
const postRows = (
  await db.query(
    `SELECT m.period, m.author_id, COUNT(*)::int n FROM messages m
     JOIN users u ON u.user_id = m.author_id
     WHERE TRUE ${includeBots ? '' : 'AND u.is_bot = 0'}
     GROUP BY m.period, m.author_id`
  )
).rows as PostCountRow[];
const hasPosts = postRows.length > 0;

const hasFocusRole = (u: UserRow) => {
  try {
    return JSON.parse(u.roles ?? '[]').includes(FOCUS_ROLE);
  } catch {
    return false;
  }
};

// リアクション 0 件でもランキングに載せる人。現メンバーかつ対象ロール持ち。
const focusIds = Object.values(users)
  .filter((u) => u.is_member && hasFocusRole(u) && (includeBots || !u.is_bot))
  .map((u) => u.user_id);

if (focusIds.length === 0) {
  console.warn(
    `⚠ ロール「${FOCUS_ROLE}」を持つメンバーが見つかりません。` +
      'ロール情報はスキャン時に取得します。`npm run scan -- <期間>` を実行し直してください。'
  );
}

const payload = {
  rows: rows.map((r) => [r.period, r.emoji_key, r.giver_id, r.receiver_id]),
  emojis: Object.fromEntries(
    rows.map((r) => [r.emoji_key, { label: r.emoji_label, url: r.emoji_url }])
  ),
  users: Object.fromEntries(
    Object.entries(users).map(([id, u]) => [
      id,
      { name: u.display_name, avatar: u.avatar_url, focus: hasFocusRole(u) && !!u.is_member },
    ])
  ),
  focusRole: FOCUS_ROLE,
  focusIds,
  // { period: { user_id: 投稿数 } }
  posts: postRows.reduce((acc: Record<string, Record<string, number>>, r) => {
    (acc[r.period] ??= {})[r.author_id] = r.n;
    return acc;
  }, {}),
  hasPosts,
  periods: [...new Set([...rows.map((r) => r.period), ...postRows.map((r) => r.period)])].sort(),
};

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord リアクション集計</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --given: #2a78d6;
    --received: #008300;
    --posted: #8a5cd6;
    --total: #b8791f;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --grid: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --given: #3987e5;
      --received: #008300;
      --posted: #a47ce8;
      --total: #d99a3d;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --grid: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255,255,255,0.10);
    --given: #3987e5;
    --received: #008300;
    --posted: #a47ce8;
    --total: #d99a3d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--page); color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--text-secondary); margin: 0 0 24px; }
  .controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 24px; }
  select, button {
    font: inherit; padding: 6px 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
  }
  button { cursor: pointer; }
  button[aria-pressed="true"] { background: var(--given); color: #fff; border-color: transparent; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 12px; padding: 16px;
  }
  .tile .label { color: var(--text-secondary); font-size: 12px; }
  .tile .value { font-size: 30px; font-weight: 600; line-height: 1.2; }
  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px; margin-bottom: 20px;
  }
  .card h2 { font-size: 15px; margin: 0 0 16px; font-weight: 600; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  .bar { height: 14px; border-radius: 4px; display: block; min-width: 2px; }
  .bar-cell { width: 42%; }
  .who { display: flex; align-items: center; gap: 8px; }
  .who img { width: 22px; height: 22px; border-radius: 50%; }
  .row-link { cursor: pointer; }
  .row-link:hover { background: var(--grid); }
  .emo img { width: 18px; height: 18px; vertical-align: -3px; }
  .back { background: none; border: none; color: var(--given); padding: 0; margin-bottom: 12px; }
  .hide { display: none; }
  .muted { color: var(--muted); }
  .check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
  .check input { cursor: pointer; margin: 0; }
  .tag {
    font-size: 11px; padding: 1px 6px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text-secondary); white-space: nowrap;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Discord リアクション集計</h1>
  <p class="sub">集計期間は日本時間の月単位、日付変更は毎朝6時 (JST)</p>

  <div class="controls">
    <label>期間 <select id="period"></select></label>
    <button id="tab-received" aria-pressed="false">もらった数</button>
    <button id="tab-given" aria-pressed="false">付けた数</button>
    ${hasPosts ? '<button id="tab-posted" aria-pressed="false">投稿数</button>' : ''}
    <button id="tab-total" aria-pressed="true">合計</button>
    <label class="check"><input type="checkbox" id="focus-only"> ${FOCUS_ROLE}のみ</label>
  </div>

  <div id="overview">
    <div class="kpis" id="kpis"></div>
    <div class="card">
      <h2>メンバー別ランキング</h2>
      <div class="legend">
        <span><i style="background:var(--received)"></i>もらった</span>
        <span><i style="background:var(--given)"></i>付けた</span>
        ${hasPosts ? '<span><i style="background:var(--posted)"></i>投稿</span>' : ''}
        <span><i style="background:var(--total)"></i>合計</span>
      </div>
      <div class="scroll"><table id="members"></table></div>
    </div>
    <div class="card">
      <h2>リアクション別内訳</h2>
      <div class="scroll"><table id="emojis"></table></div>
    </div>
  </div>

  <div id="detail" class="hide"></div>
</div>

<script>
const DATA = ${JSON.stringify(payload)};
const [P, E, G, R] = [0, 1, 2, 3];
let mode = 'total';      // 'received' | 'given' | 'posted' | 'total'
let period = DATA.periods[DATA.periods.length - 1];
let detail = null;       // {type:'user'|'emoji', id}
let focusOnly = false;   // 対象ロールのメンバーだけに絞る

const postsOf = (id) => DATA.posts[period]?.[id] ?? 0;

// 表示のしきい値。「合計」がこの値未満の人はその月は表示しない（ユーザーの要件）。
// 当初は EM住民の20位という相対評価だったが、月ごとに基準が動いてしまうため
// 絶対評価に変更した。基準を変えたいときはこの数字だけ触ればよい。
const MIN_TOTAL = 32;

const FOCUS = new Set(DATA.focusIds);
const isFocus = (id) => FOCUS.has(id);
// メンバーが並ぶ表は全部これを通す。絞り込みは表示側だけの操作で、
// 件数そのもの（誰からもらったか等）は絞り込み前の実データのまま。
const visible = (id) => !focusOnly || isFocus(id);

const $ = (id) => document.getElementById(id);
const uname = (id) => (DATA.users[id]?.name ?? id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function emojiHtml(key) {
  const e = DATA.emojis[key];
  if (!e) return esc(key);
  return e.url
    ? '<span class="emo"><img src="' + esc(e.url) + '" alt=""> ' + esc(e.label) + '</span>'
    : '<span class="emo">' + esc(e.label) + '</span>';
}

function avatarHtml(id) {
  const u = DATA.users[id];
  const img = u?.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : '';
  // 絞り込み中は全員が対象なのでタグは冗長になる。出すのは絞っていないときだけ。
  const tag = !focusOnly && isFocus(id) ? '<span class="tag">' + esc(DATA.focusRole) + '</span>' : '';
  return '<span class="who">' + img + esc(uname(id)) + tag + '</span>';
}

const inPeriod = () => DATA.rows.filter((r) => r[P] === period);

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

function barCell(n, max, color) {
  const w = max > 0 ? (n / max) * 100 : 0;
  return '<td class="bar-cell"><span class="bar" style="width:' + w.toFixed(1) + '%;background:' + color + '"></span></td>';
}

function renderOverview() {
  const rows = inPeriod();
  // KPI は絞り込みに追随させる。表だけ絞られて上の数字が全体のままだと誤読を招くため、
  // 絞り込み中は「対象メンバーが関わったリアクション」だけを数える。
  const kpiRows = focusOnly ? rows.filter((r) => isFocus(r[G]) || isFocus(r[R])) : rows;
  const givers = new Set(kpiRows.map((r) => r[G]).filter(visible));
  const receivers = new Set(kpiRows.map((r) => r[R]).filter(visible));

  $('kpis').innerHTML = [
    [focusOnly ? DATA.focusRole + 'が関わったリアクション' : 'リアクション総数', kpiRows.length],
    ['リアクションした人数', givers.size],
    ['もらった人数', receivers.size],
    ['絵文字の種類', new Set(kpiRows.map((r) => r[E])).size],
    ...(DATA.hasPosts
      ? [[focusOnly ? DATA.focusRole + 'の投稿数' : '投稿総数',
          Object.entries(DATA.posts[period] ?? {}).reduce((s, [id, n]) => s + (visible(id) ? n : 0), 0)]]
      : []),
  ].map(([l, v]) => '<div class="tile"><div class="label">' + l + '</div><div class="value">' + v + '</div></div>').join('');

  // メンバー別: 現在のモードで降順、もう一方も並べて出す
  const recv = new Map(tally(rows, (r) => r[R]));
  const give = new Map(tally(rows, (r) => r[G]));
  // 対象ロールの人は 0 件でも必ず載せる（この期間に一度もリアクションが無くても行を作る）。
  // 投稿はあるがリアクションのやり取りが無い人も拾う。
  const posters = Object.keys(DATA.posts[period] ?? {});
  let ids = [...new Set([...recv.keys(), ...give.keys(), ...posters, ...DATA.focusIds])].filter(visible);
  const post = new Map(ids.map((id) => [id, postsOf(id)]));
  const totalOf = (id) => (recv.get(id) ?? 0) + (give.get(id) ?? 0) + postsOf(id);
  const total = new Map(ids.map((id) => [id, totalOf(id)]));

  // 合計が MIN_TOTAL 未満の人は隠す。月ごとに基準が動かない絶対評価。
  const hiddenCount = ids.filter((id) => totalOf(id) < MIN_TOTAL).length;
  ids = ids.filter((id) => totalOf(id) >= MIN_TOTAL);

  const primary = mode === 'received' ? recv : mode === 'given' ? give : mode === 'posted' ? post : total;
  // 同数のときは名前順にして、0件の人が実行ごとに入れ替わらないようにする
  ids.sort((a, b) => (primary.get(b) ?? 0) - (primary.get(a) ?? 0) || uname(a).localeCompare(uname(b), 'ja'));
  const max = Math.max(1, ...ids.map((i) => primary.get(i) ?? 0));
  const color = mode === 'received' ? 'var(--received)' : mode === 'given' ? 'var(--given)'
    : mode === 'posted' ? 'var(--posted)' : 'var(--total)';
  const postCol = DATA.hasPosts ? '<th class="num">投稿</th>' : '';

  $('members').innerHTML =
    '<thead><tr><th>メンバー</th><th class="num">もらった</th><th class="num">付けた</th>' + postCol +
    '<th class="num">合計</th><th></th></tr></thead><tbody>' +
    ids.map((id) =>
      '<tr class="row-link" data-user="' + esc(id) + '"><td>' + avatarHtml(id) + '</td>' +
      '<td class="num">' + (recv.get(id) ?? 0) + '</td>' +
      '<td class="num">' + (give.get(id) ?? 0) + '</td>' +
      (DATA.hasPosts ? '<td class="num">' + postsOf(id) + '</td>' : '') +
      '<td class="num"><b>' + totalOf(id) + '</b></td>' +
      barCell(primary.get(id) ?? 0, max, color) + '</tr>'
    ).join('') + '</tbody>' +
    // 隠した人がいることを黙らせない。何人隠れているか必ず出す。
    (hiddenCount > 0
      ? '<tfoot><tr><td colspan="' + (DATA.hasPosts ? 6 : 5) + '" class="muted">' +
        '合計 ' + MIN_TOTAL + ' 未満の ' + hiddenCount + '人を非表示' +
        '</td></tr></tfoot>'
      : '');

  // 絵文字の内訳も KPI と同じ母集団で見る（総数と割合の分母が食い違わないように）
  const emo = tally(kpiRows, (r) => r[E]);
  const emax = Math.max(1, ...emo.map(([, n]) => n));
  $('emojis').innerHTML =
    '<thead><tr><th>リアクション</th><th class="num">件数</th><th class="num">割合</th><th></th></tr></thead><tbody>' +
    emo.map(([k, n]) =>
      '<tr class="row-link" data-emoji="' + esc(k) + '"><td>' + emojiHtml(k) + '</td>' +
      '<td class="num">' + n + '</td>' +
      '<td class="num">' + ((n / kpiRows.length) * 100).toFixed(1) + '%</td>' +
      barCell(n, emax, 'var(--given)') + '</tr>'
    ).join('') + '</tbody>';
}

// メンバーが並ぶ表用。絞り込みと「0件でも載せる」を効かせる。
// exceptId は自分自身。自己リアクションは集計外なので、詳細画面の「誰から/誰に」に
// 本人が 0 件で並ぶのは意味がない。
function memberEntries(entries, exceptId) {
  const m = new Map(entries);
  for (const id of DATA.focusIds) if (!m.has(id)) m.set(id, 0);
  if (exceptId != null) m.delete(exceptId);
  return [...m]
    .filter(([id]) => visible(id))
    .sort((a, b) => b[1] - a[1] || uname(a[0]).localeCompare(uname(b[0]), 'ja'));
}

function simpleTable(head, entries, render, color) {
  if (entries.length === 0) return '<p class="muted">データなし</p>';
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return '<div class="scroll"><table><thead><tr><th>' + head + '</th><th class="num">件数</th><th></th></tr></thead><tbody>' +
    entries.map(([k, n]) => '<tr><td>' + render(k) + '</td><td class="num">' + n + '</td>' + barCell(n, max, color) + '</tr>').join('') +
    '</tbody></table></div>';
}

function renderDetail() {
  const rows = inPeriod();
  let html = '<button class="back" id="back">← 一覧に戻る</button>';

  if (detail.type === 'user') {
    const id = detail.id;
    const got = rows.filter((r) => r[R] === id);
    const gave = rows.filter((r) => r[G] === id);
    html += '<h2>' + avatarHtml(id) + '</h2>';
    const np = postsOf(id);
    html += '<div class="kpis">' +
      '<div class="tile"><div class="label">もらった総数</div><div class="value">' + got.length + '</div></div>' +
      '<div class="tile"><div class="label">付けた総数</div><div class="value">' + gave.length + '</div></div>' +
      (DATA.hasPosts
        ? '<div class="tile"><div class="label">投稿数</div><div class="value">' + np + '</div></div>' +
          // 1投稿あたり何個もらえたか。投稿0件のときは割れないのでダッシュ。
          '<div class="tile"><div class="label">投稿あたり</div><div class="value">' +
            (np > 0 ? (got.length / np).toFixed(1) : '—') + '</div></div>'
        : '') +
      '</div>';
    html += '<div class="card"><h2>もらったリアクションの内訳</h2>' +
      simpleTable('リアクション', tally(got, (r) => r[E]), emojiHtml, 'var(--received)') + '</div>';
    html += '<div class="card"><h2>誰からもらったか</h2>' +
      simpleTable('メンバー', memberEntries(tally(got, (r) => r[G])), avatarHtml, 'var(--received)') + '</div>';
    html += '<div class="card"><h2>付けたリアクションの内訳</h2>' +
      simpleTable('リアクション', tally(gave, (r) => r[E]), emojiHtml, 'var(--given)') + '</div>';
    html += '<div class="card"><h2>誰に付けたか</h2>' +
      simpleTable('メンバー', memberEntries(tally(gave, (r) => r[R])), avatarHtml, 'var(--given)') + '</div>';
  } else {
    const key = detail.id;
    const sub = rows.filter((r) => r[E] === key);
    html += '<h2>' + emojiHtml(key) + '</h2>';
    html += '<div class="kpis"><div class="tile"><div class="label">総数</div><div class="value">' + sub.length + '</div></div></div>';
    html += '<div class="card"><h2>よくもらった人</h2>' +
      simpleTable('メンバー', memberEntries(tally(sub, (r) => r[R])), avatarHtml, 'var(--received)') + '</div>';
    html += '<div class="card"><h2>よく付けた人</h2>' +
      simpleTable('メンバー', memberEntries(tally(sub, (r) => r[G])), avatarHtml, 'var(--given)') + '</div>';
  }

  $('detail').innerHTML = html;
  // 履歴を戻すことで popstate 経由で一覧に戻る。直接 detail = null にすると
  // 履歴に詳細が残ったままになり、ブラウザの戻るで詳細に入り直してしまう。
  $('back').onclick = () => history.back();
}

function render() {
  $('overview').classList.toggle('hide', !!detail);
  $('detail').classList.toggle('hide', !detail);
  if (detail) renderDetail(); else renderOverview();
}

$('period').innerHTML = DATA.periods.map((p) => '<option value="' + p + '">' + p + '</option>').join('');
$('period').value = period;
$('period').onchange = (e) => { period = e.target.value; render(); };

// 投稿数タブは messages にデータがあるときだけ存在する
const TABS = ['received', 'given', ...(DATA.hasPosts ? ['posted'] : []), 'total'];
for (const m of TABS) {
  $('tab-' + m).onclick = () => {
    mode = m;
    for (const t of TABS) $('tab-' + t).setAttribute('aria-pressed', String(t === m));
    render();
  };
}

// 対象ロールのメンバーが一人もいなければフィルタ自体を隠す（押しても何も起きないので）
if (DATA.focusIds.length === 0) $('focus-only').closest('.check').classList.add('hide');
$('focus-only').onchange = (e) => { focusOnly = e.target.checked; render(); };

document.addEventListener('click', (e) => {
  const row = e.target.closest('.row-link');
  if (!row) return;
  detail = row.dataset.user ? { type: 'user', id: row.dataset.user } : { type: 'emoji', id: row.dataset.emoji };
  // 詳細を開いたら履歴に積む。ブラウザの戻るボタンで一覧に戻れるようにする。
  history.pushState({ detail }, '');
  render();
});

// 戻る/進むで詳細⇔一覧を行き来する。file:// でも history API は使える。
window.addEventListener('popstate', (e) => {
  detail = e.state?.detail ?? null;
  render();
});
// 一覧を履歴の基点にしておく
history.replaceState({ detail: null }, '');

render();
</script>
</body>
</html>`;

  return html;
}
