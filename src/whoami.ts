// 診断用: Bot が今どのギルドに参加しているかを表示する。
// GUILD_ID が正しいか、そもそも招待できているかの切り分けに使う。
import { Client, GatewayIntentBits } from 'discord.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN が設定されていません (.env を確認)');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  console.log(`ログイン成功: ${client.user?.tag}\n`);

  const guilds = await client.guilds.fetch();
  if (guilds.size === 0) {
    console.log('この Bot はどのサーバーにも参加していません。');
    console.log('→ Developer Portal の OAuth2 → URL Generator で作った招待URLを');
    console.log('   ブラウザで開き、サーバーを選んで「認証」まで完了させてください。');
  } else {
    console.log('参加中のサーバー:');
    for (const g of guilds.values()) {
      const mark = g.id === GUILD_ID ? '  ← .env の GUILD_ID と一致' : '';
      console.log(`  ${g.id}  ${g.name}${mark}`);
    }
    if (GUILD_ID && !guilds.has(GUILD_ID)) {
      console.log(`\n.env の GUILD_ID (${GUILD_ID}) は上のどれとも一致しません。`);
      console.log('→ 上の一覧から正しい ID を .env にコピーしてください。');
    }
  }

  await client.destroy();
});

client.login(DISCORD_TOKEN);
