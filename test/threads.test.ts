// scan.js のスレッド収集ロジックだけを抜き出して偽 API に対して検証する。
// 確認したいこと:
//   1. フォーラム本体は走査対象に入らない（メッセージが無いので入れてはいけない）
//   2. フォーラム配下のスレッドが拾える
//   3. アーカイブ済みが 100件を超えてもページングで全部拾える
//   4. アクティブとアーカイブで重複しない
//   5. 権限の無いスレッド/チャンネルは除外される
//   6. スレッド取得が失敗しても全体は止まらない

const ChannelType = { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15, GuildMedia: 16, GuildVoice: 2 };

function makeThread(id: string, name: string, parent: any, { readable = true, archivedAt = null as number | null } = {}): any {
  return {
    id, name, parent, archivedAt,
    isThread: () => true,
    permissionsFor: () => ({ has: () => readable }),
  };
}

function makeParent(
  id: string,
  name: string,
  type: number,
  { readable = true, active = [] as any[], archived = [] as any[], failThreads = false } = {}
): any {
  const self: any = {
    id, name, type,
    isThread: () => false,
    permissionsFor: () => ({ has: () => readable }),
  };
  self.threads = {
    fetch: async () => {
      if (failThreads) throw new Error('Missing Access');
      return { threads: new Map(active.map((t) => [t.id, t])) };
    },
    fetchArchived: async ({ limit, before }: { limit: number; before?: number }) => {
      if (failThreads) throw new Error('Missing Access');
      // archivedAt の降順で並んでいる前提。before より古いものを limit 件返す。
      const sorted = [...archived].sort((a, b) => b.archivedAt - a.archivedAt);
      const start = before ? sorted.findIndex((t) => t.archivedAt < before) : 0;
      const slice = start === -1 ? [] : sorted.slice(start, start + limit);
      const consumed = start === -1 ? sorted.length : start + slice.length;
      return { threads: new Map(slice.map((t) => [t.id, t])), hasMore: consumed < sorted.length };
    },
  };
  for (const t of [...active, ...archived]) t.parent = self;
  return self;
}

// --- テストデータ ---
const forum = makeParent('F1', 'フォーラム', ChannelType.GuildForum, {
  active: [makeThread('t-active-1', '進行中の話題', null)],
  // 100件超 → ページングが要る
  archived: Array.from({ length: 250 }, (_, i) =>
    makeThread('t-arch-' + i, 'アーカイブ投稿' + i, null, { archivedAt: 1_000_000 - i })
  ),
});
const text = makeParent('C1', '雑談', ChannelType.GuildText, {
  active: [makeThread('t-text-1', 'テキスト内スレッド', null)],
});
const secretForum = makeParent('F2', '秘密フォーラム', ChannelType.GuildForum, { readable: false });
const brokenForum = makeParent('F3', '壊れフォーラム', ChannelType.GuildForum, { failThreads: true });
const forumWithSecretThread = makeParent('F4', '一部非公開', ChannelType.GuildForum, {
  active: [makeThread('t-secret', '見えないスレッド', null, { readable: false }),
           makeThread('t-open', '見えるスレッド', null)],
});
const voice = makeParent('V1', '通話', ChannelType.GuildVoice);

const allChannels = [forum, text, secretForum, brokenForum, forumWithSecretThread, voice];

// --- scan.js と同じロジック ---
const me = {};
const canRead = (c) => !!c?.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory']);

const parents = allChannels.filter(
  (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement ||
               c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia)
);

const targets = [];
let threadCount = 0;
const logs = [];
for (const parent of parents) {
  if (!canRead(parent)) continue;
  const isContainer = parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia;
  if (!isContainer) targets.push(parent);

  const seen = new Set();
  const take = (thread) => {
    if (seen.has(thread.id) || !canRead(thread)) return;
    seen.add(thread.id);
    targets.push(thread);
    threadCount++;
  };

  try {
    const active = await parent.threads.fetch();
    for (const t of active.threads.values()) take(t);
    let before;
    let guard = 0;
    while (true) {
      if (++guard > 50) throw new Error('無限ループ検出');
      const res = await parent.threads.fetchArchived({ type: 'public', limit: 100, before });
      if (res.threads.size === 0) break;
      let oldest;
      for (const t of res.threads.values()) { take(t); oldest = t.archivedAt ?? oldest; }
      if (!res.hasMore || !oldest) break;
      before = oldest;
    }
  } catch (err) {
    logs.push(`スレッド取得失敗: #${parent.name} (${err.message})`);
  }
}

// --- 検証 ---
const ids = targets.map((t) => t.id);
const ok = (label, cond) => console.log((cond ? '  ✓ ' : '  ✗ FAIL ') + label);

console.log('走査対象:', targets.length, '件 / スレッド', threadCount, '件');
logs.forEach((l) => console.log('  log:', l));
console.log();
ok('フォーラム本体(F1)は対象に入らない', !ids.includes('F1'));
ok('メディア/フォーラムの器を除外', !ids.includes('F4'));
ok('テキストチャンネル(C1)は対象に入る', ids.includes('C1'));
ok('ボイスチャンネルは対象外', !ids.includes('V1'));
ok('フォーラムのアクティブスレッドを拾う', ids.includes('t-active-1'));
ok('テキスト内スレッドを拾う', ids.includes('t-text-1'));
ok('アーカイブ250件を全部拾う (ページング)', Array.from({length:250},(_,i)=>'t-arch-'+i).every((id)=>ids.includes(id)));
ok('重複が無い', ids.length === new Set(ids).size);
ok('権限の無いフォーラム(F2)配下は入らない', !ids.some((i) => i.startsWith('F2')));
ok('権限の無いスレッドは除外', !ids.includes('t-secret'));
ok('同じフォーラムの見えるスレッドは拾う', ids.includes('t-open'));
ok('スレッド取得失敗でも処理継続', logs.some((l) => l.includes('壊れフォーラム')) && ids.includes('t-open'));
ok('期待総数 = 250+1+1+1+1(C1本体)', targets.length === 254);
