import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { openDb, type ScanStateRow } from './db.js';
import { periodKeyOf, periodRange } from './period.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
const args = process.argv.slice(2);
const periods = args.filter((a) => !a.startsWith('--'));
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('DISCORD_TOKEN と GUILD_ID を環境変数で指定してください');
  process.exit(1);
}
if (periods.length === 0) {
  console.error('使い方: node src/scan.js 2026-06 [2026-07 ...] [--fresh]');
  process.exit(1);
}
const bad = periods.filter((p) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(p));
if (bad.length > 0) {
  console.error(`期間の形式が不正です: ${bad.join(', ')} (YYYY-MM で指定してください)`);
  process.exit(1);
}

// 走査対象の時間範囲。指定された全期間を覆う最小の窓を取る。
const ranges = periods.map(periodRange);
const windowStart = Math.min(...ranges.map((r) => r.startMs));
const windowEnd = Math.max(...ranges.map((r) => r.endMs));
const wanted = new Set(periods);

const db = openDb(new URL('../data.sqlite', import.meta.url).pathname);
// リアクション経由で見かけた人。ロール情報は持たないので既存の値を壊さないこと
// （メンバー一覧側で入れた is_member / roles を上書きしない）。
//
// 表示名はサーバーのニックネームを優先したいが、ここで取れるのは User オブジェクトの
// グローバル表示名だけ。メンバー一覧側 (upsertMember) の方が正確なので、
// 一度でもメンバーとして記録された人の display_name は上書きしない。
const upsertUser = db.prepare(
  `INSERT INTO users (user_id, display_name, avatar_url, is_bot) VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     display_name = CASE WHEN users.is_member = 1 THEN users.display_name ELSE excluded.display_name END,
     avatar_url = excluded.avatar_url`
);
// ギルドメンバー一覧から入れる方。こちらはロール情報まで持っている。
const upsertMember = db.prepare(
  `INSERT INTO users (user_id, display_name, avatar_url, is_bot, is_member, roles) VALUES (?, ?, ?, ?, 1, ?)
   ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name,
     avatar_url = excluded.avatar_url, is_bot = excluded.is_bot,
     is_member = 1, roles = excluded.roles`
);
const insertMessage = db.prepare(
  `INSERT OR IGNORE INTO messages (message_id, channel_id, author_id, message_ts, period)
   VALUES (?, ?, ?, ?, ?)`
);
const insertReaction = db.prepare(
  `INSERT OR IGNORE INTO reactions
   (message_id, channel_id, emoji_key, emoji_label, emoji_url, giver_id, receiver_id, message_ts, period)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// 進捗キー。同じ期間の組み合わせでのみ再開を有効にする。
const periodKey = [...periods].sort().join(',');
const getState = db.prepare('SELECT oldest_seen_id, completed FROM scan_state WHERE channel_id = ? AND period_key = ?');
const saveState = db.prepare(
  `INSERT INTO scan_state (channel_id, period_key, oldest_seen_id, completed) VALUES (?, ?, ?, ?)
   ON CONFLICT(channel_id, period_key) DO UPDATE SET
     oldest_seen_id = excluded.oldest_seen_id, completed = excluded.completed`
);
const isFresh = process.argv.includes('--fresh');
if (isFresh) {
  db.prepare('DELETE FROM scan_state WHERE period_key = ?').run(periodKey);
  console.log('--fresh: 進捗をリセットして最初から走査します');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
  let guild;
  try {
    guild = await client.guilds.fetch(GUILD_ID);
  } catch (err) {
    if (err.code === 10004) {
      console.error(`\nギルド ${GUILD_ID} が見つかりません。`);
      console.error('Bot が招待されていないか、GUILD_ID が違います。');
      console.error('`npm run whoami` で参加中のサーバー一覧を確認してください。');
      await client.destroy();
      process.exit(1);
    }
    throw err;
  }
  console.log(`ギルド: ${guild.name}`);

  // メンバー一覧とロールを毎回取り直す。ロールの付け外しがあっても最新の状態で集計できる。
  // 走査済みチャンネルが全部 skip される再実行でも、ここは必ず通る。
  const members = await guild.members.fetch();
  const syncMembers = db.transaction(() => {
    // 退会者を現メンバー扱いのまま残さない。リアクションの記録自体は消さない。
    db.prepare('UPDATE users SET is_member = 0, roles = \'[]\'').run();
    for (const m of members.values()) {
      const roles = m.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name);
      upsertMember.run(
        m.id,
        // サーバー内のニックネームを最優先。無ければグローバル表示名 → ユーザー名。
        // リアクション経由 (upsertUser) では nickname が取れないのでこちらが正となる。
        m.nickname ?? m.user.globalName ?? m.user.username,
        m.user.displayAvatarURL(),
        m.user.bot ? 1 : 0,
        JSON.stringify(roles)
      );
    }
  });
  syncMembers();
  console.log(`メンバー ${members.size}人のロールを取得しました`);

  const me = await guild.members.fetchMe();
  const canRead = (c) => !!c?.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory']);
  // スレッドは親チャンネル名を添えないとどこの話か分からない
  const label = (c) => (c.isThread?.() ? `#${c.parent?.name ?? '?'} > ${c.name}` : `#${c.name}`);

  // 走査対象を集める。
  // フォーラムチャンネル自体はメッセージを持たず、中の各スレッドが実体なので、
  // スレッドを展開しないとフォーラムの投稿は丸ごと集計から漏れる（実際に漏れていた）。
  // 通常のテキストチャンネルから派生したスレッドも同様に拾う。
  const all = await guild.channels.fetch();
  const parents = [...all.values()].filter(
    (c) =>
      c &&
      (c.type === ChannelType.GuildText ||
        c.type === ChannelType.GuildAnnouncement ||
        c.type === ChannelType.GuildForum ||
        c.type === ChannelType.GuildMedia)
  );

  const targets = [];
  let threadCount = 0;
  for (const parent of parents) {
    if (!canRead(parent)) continue;
    // フォーラム/メディアは器なので、本体は走査しない（メッセージが無い）
    const isContainer = parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildMedia;
    if (!isContainer) targets.push(parent);

    // アクティブ + アーカイブ済みの両方。フォーラムの投稿は一定期間で自動アーカイブ
    // されるため、アーカイブ済みを取らないと過去分がほとんど拾えない。
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

      // アーカイブ済みは 100件ずつ。古い方へ辿るので before に最終アーカイブ時刻を渡す。
      // ページングしないと 100件を超えるフォーラムで静かに取りこぼす。
      let before;
      while (true) {
        const res = await parent.threads.fetchArchived({ type: 'public', limit: 100, before });
        if (res.threads.size === 0) break;
        let oldest;
        for (const t of res.threads.values()) {
          take(t);
          oldest = t.archivedAt ?? oldest;
        }
        if (!res.hasMore || !oldest) break;
        before = oldest;
      }
    } catch (err) {
      // 権限不足などでスレッド一覧が引けないことがある。そのチャンネルだけ諦めて続行。
      console.log(`  ! #${parent.name} のスレッド取得に失敗 (${err.message})`);
    }
  }
  console.log(`走査対象: ${targets.length}件 (うちスレッド ${threadCount}件)`);
  const channels = new Map(targets.map((c) => [c.id, c]));

  let totalMessages = 0;
  let totalReactions = 0;
  let totalPosts = 0;
  let skipped = 0;
  // 取得できなかった絵文字と、その取りこぼし件数。黙って捨てず最後に必ず報告する。
  const unfetchable = new Map();

  for (const channel of channels.values()) {
    // 権限は targets を組む時点で確認済み
    const state = getState.get(channel.id, periodKey) as ScanStateRow | undefined;
    if (state?.completed) {
      console.log(`  ${label(channel)} ... 走査済み (スキップ)`);
      skipped++;
      continue;
    }

    const resuming = !!state?.oldest_seen_id;
    process.stdout.write(`  ${label(channel)} ${resuming ? '(再開) ' : ''}... `);
    let scanned = 0;
    let found = 0;
    let posted = 0;   // 期間内の投稿数（リアクションの有無を問わない）
    let before = state?.oldest_seen_id ?? undefined;
    let done = false;

    // 新しい方から遡る。窓より古いメッセージに到達したら打ち切り。
    while (!done) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
      if (batch.size === 0) break;

      // 1バッチ分を溜めてから一括コミットする。DB書き込みとカーソル前進を
      // 同一トランザクションに入れることで、途中で落ちても取りこぼし・
      // 二重計上のどちらも起きない状態を保つ。
      const pending = [];
      let cursor = before;

      for (const msg of batch.values()) {
        const ts = msg.createdTimestamp;
        if (ts < windowStart) { done = true; break; }
        cursor = msg.id;
        scanned++;
        if (ts >= windowEnd) continue;

        const period = periodKeyOf(ts);
        if (!wanted.has(period)) continue;

        // 投稿数の集計用。リアクションが付いていない投稿も必ず記録するので、
        // reactions の有無を見る前にここで拾う。
        const author = msg.author;
        pending.push(['user', author.id, author.displayName ?? author.username, author.displayAvatarURL(), author.bot ? 1 : 0]);
        pending.push(['message', msg.id, channel.id, author.id, ts, period]);
        posted++;

        if (msg.reactions.cache.size === 0) continue;

        for (const reaction of msg.reactions.cache.values()) {
          const emoji = reaction.emoji;
          const key = emoji.id ?? emoji.name;
          const label = emoji.id ? `:${emoji.name}:` : emoji.name;
          const url = emoji.id ? emoji.imageURL() : null;

          // reaction.users.fetch() は 100 件ずつ。多数付いた場合はページングする。
          let after;
          try {
            while (true) {
              const users = await reaction.users.fetch({ limit: 100, ...(after && { after }) });
              if (users.size === 0) break;
              for (const user of users.values()) {
                pending.push(['user', user.id, user.displayName ?? user.username, user.displayAvatarURL(), user.bot ? 1 : 0]);
                pending.push(['reaction', msg.id, channel.id, key, label, url, user.id, author.id, ts, period]);
                found++;
                after = user.id;
              }
              if (users.size < 100) break;
            }
          } catch (err) {
            // Unknown Emoji (10014): 異体字セレクタを含む合成絵文字 (*️⃣, 0️⃣, #️⃣ 等) は
            // Discord API が users エンドポイントを引けない。count は取れるが誰が付けたかは
            // 取得不能。API 側の制約なので、その絵文字だけ諦めて走査は続行する。
            if (err.code === 10014) {
              const n = reaction.count ?? 0;
              unfetchable.set(label, (unfetchable.get(label) ?? 0) + n);
              continue;
            }
            throw err;
          }
        }
      }

      const commit = db.transaction(() => {
        for (const [kind, ...vals] of pending) {
          if (kind === 'user') upsertUser.run(...vals);
          else if (kind === 'message') insertMessage.run(...vals);
          else insertReaction.run(...vals);
        }
        saveState.run(channel.id, periodKey, cursor, done ? 1 : 0);
      });
      commit();

      before = cursor;
      if (batch.size < 100) { done = true; saveState.run(channel.id, periodKey, cursor, 1); }
    }

    totalMessages += scanned;
    totalReactions += found;
    totalPosts += posted;
    console.log(`${scanned}件走査 / 期間内の投稿${posted}件 / リアクション${found}件`);
  }

  console.log(
    `\n完了: ${totalMessages}メッセージ走査、投稿${totalPosts}件、${totalReactions}リアクション記録` +
      (skipped > 0 ? ` (走査済み ${skipped}チャンネルはスキップ)` : '')
  );
  console.log('進捗は保存済み。中断した場合は同じコマンドで再開できます。');

  if (unfetchable.size > 0) {
    const lost = [...unfetchable.values()].reduce((a, b) => a + b, 0);
    console.log(`\n⚠ 集計できなかったリアクションが ${lost} 件あります:`);
    for (const [label, n] of [...unfetchable].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${label}  約${n}件`);
    }
    console.log('  キーキャップ系の絵文字 (*️⃣ 0️⃣ #️⃣ など) は Discord API の制約で');
    console.log('  「誰が付けたか」を取得できません。件数は分かりますが個人に紐付けられないため、');
    console.log('  集計から除外されています。');
  }
  await client.destroy();
  db.close();
});

client.login(DISCORD_TOKEN);
