#!/usr/bin/env node
'use strict';

// /mahjong コマンドと自動投稿チャンネル設定の動作確認（npm test には含めない手動チェック）。
//   node dev/check-mahjong-command.js
// Discord クライアントはスタブ化し、実 Discord には接続しない。
// (1) コマンドが既存ローダーの流儀（commands/ を走査して data/execute を読む）で読み込めること
// (2) チャンネル設定（utils/channel-config.js）の読み書きが既存方式で動き、
//     設定キー mahjongChannel が往復すること
// (3) 自動投稿の分岐: 設定あり＋人間対戦→募集を投稿する／設定なし→投稿しない／
//     Bot戦→告知だけ投稿する（参加リンクなし）／DM→投稿しない ことと、
//     フック（onStart の編集・onFinish の結果投稿）が付くこと
// config-channels.json は実行前に退避し、終わったら元に戻す。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config-channels.json');
const originalConfig = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;

function restoreConfig() {
  if (originalConfig === null) fs.rmSync(CONFIG_PATH, { force: true });
  else fs.writeFileSync(CONFIG_PATH, originalConfig, 'utf-8');
}

function makeChannelStub(id) {
  const sent = [];
  const edits = [];
  const message = { edit: async (payload) => { edits.push(payload); return message; } };
  const channel = { id, send: async (payload) => { sent.push(payload); return message; } };
  return { channel, sent, edits };
}

function makeInteraction({ guildId, mode, channelStub }) {
  const replies = [];
  return {
    replies,
    user: { id: '111', username: 'hostuser', globalName: 'ホスト' },
    member: { displayName: 'ホスト表示名' },
    guildId,
    options: { getString: (name) => (name === 'opponent' ? mode : null) },
    client: {
      channels: {
        fetch: async (id) => (channelStub && id === channelStub.channel.id ? channelStub.channel : null),
      },
    },
    reply: async (payload) => { replies.push(payload); return payload; },
  };
}

function roomCodeOf(text) {
  const m = String(text).match(/\/play\/mahjong\?room=([A-Z0-9]{6})/);
  return m && m[1];
}

async function main() {
  const mahjongServer = require('../utils/mahjong-server.js');
  const channelConfig = require('../utils/channel-config.js');

  // (1) 既存ローダーと同じ走査で、全コマンドが data/execute を持ち、mahjong が含まれること
  {
    const commandsPath = path.join(__dirname, '..', 'commands');
    const names = [];
    for (const folder of fs.readdirSync(commandsPath)) {
      const dir = path.join(commandsPath, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const command = require(path.join(dir, file));
        assert('data' in command && 'execute' in command, `${folder}/${file} に data/execute がない`);
        names.push(command.data.name);
      }
    }
    assert(names.includes('mahjong'), '/mahjong コマンドが読み込めていない');
    console.log(`コマンド読み込み: OK（${names.length}件、mahjong を含む）`);
  }

  const command = require('../commands/games/mahjong.js');
  const GUILD_WITH = 'guild-with-post';
  const GUILD_WITHOUT = 'guild-without-post';

  try {
    // (2) チャンネル設定の読み書き（既存方式）と mahjongChannel の往復
    channelConfig.updateChannelConfig((data) => {
      channelConfig.ensureGuildConfig(data, GUILD_WITH).mahjongChannel = 'ch-post';
    });
    assert.strictEqual(channelConfig.getChannelConfig()[GUILD_WITH].mahjongChannel, 'ch-post');
    console.log('チャンネル設定の読み書き（mahjongChannel）: OK');

    // (3a) 設定あり＋人間対戦 → 募集を投稿する。フックの onStart で募集終了に編集され、
    //      onFinish で結果（順位・スコア）が同じチャンネルへ投稿される
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: GUILD_WITH, mode: 'human', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 1, '自動投稿がされていない');
      assert(stub.sent[0].content.includes('ホスト表示名'), '投稿にホスト名が含まれていない');
      assert(stub.sent[0].content.includes('募集しています'), '投稿が募集文になっていない');
      const code = roomCodeOf(stub.sent[0].content);
      assert(code, '投稿に招待リンクが含まれていない');
      assert(stub.sent[0].content.includes(`ルームコード: \`${code}\``), '投稿にルームコードが含まれていない');
      assert(stub.sent[0].components && stub.sent[0].components.length > 0, '投稿に参加ボタンが付いていない');
      assert.strictEqual(interaction.replies.length, 1);
      assert.notStrictEqual(interaction.replies[0].flags, MessageFlags.Ephemeral, '返信が ephemeral になっている（公開返信のはず）');
      assert(interaction.replies[0].content.includes(`/play/mahjong?room=${code}`), '返信と投稿のリンクが一致しない');
      assert(interaction.replies[0].content.includes('自動投稿チャンネルにも募集を投稿しました'), '返信に自動投稿の注記がない');
      const room = mahjongServer.rooms.get(code);
      assert(room && room.hostId === '111' && room.mode === 'human', 'ルームにホストが記録されていない');
      assert(room.hooks && typeof room.hooks.onStart === 'function' && typeof room.hooks.onExpire === 'function' && typeof room.hooks.onFinish === 'function', 'フックが付いていない');
      await room.hooks.onStart(room);
      assert.strictEqual(stub.edits.length, 1, '対局開始時の編集がされていない');
      assert(stub.edits[0].content.includes('募集は終了しました'), '編集内容が募集終了になっていない');
      await room.hooks.onFinish(room, {
        length: 'east',
        humanCount: 2,
        results: [
          { rank: 1, name: 'ホスト表示名', bot: false, score: 51200, total: 36.2 },
          { rank: 2, name: '相手', bot: false, score: 34800, total: -5.2 },
          { rank: 3, name: 'Bot 1', bot: true, score: 19000, total: -31 },
        ],
      });
      assert.strictEqual(stub.sent.length, 2, '結果が投稿されていない');
      assert(stub.sent[1].content.includes('対局結果'), '結果投稿の見出しがない');
      assert(stub.sent[1].content.includes('ホスト表示名') && stub.sent[1].content.includes('51,200点'), '結果に順位・スコアが含まれていない');
      console.log('自動投稿（設定あり・人間対戦→募集＋開始時編集＋結果投稿）: OK');
    }

    // (3b) 設定なし＋人間対戦 → 投稿しない（リンク返信のみ）
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: GUILD_WITHOUT, mode: 'human', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 0, '設定がないのに投稿している');
      assert(roomCodeOf(interaction.replies[0].content), '返信にリンクが含まれていない');
      console.log('自動投稿（設定なし→投稿しない）: OK');
    }

    // (3c) 設定あり＋Bot戦 → 告知だけ投稿する（参加リンク・ボタンなし、結果フックは付くが
    //      finishMatch 側の「人間2人以上」判定で呼ばれない）
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: GUILD_WITH, mode: 'bot', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 1, 'Bot戦の告知が投稿されていない');
      assert(stub.sent[0].content.includes('Bot戦を始めました'), '告知の文面が違う');
      assert(!roomCodeOf(stub.sent[0].content), 'Bot戦の告知に参加リンクが含まれている');
      assert(!stub.sent[0].components, 'Bot戦の告知にボタンが付いている');
      assert(interaction.replies[0].content.includes('自動投稿チャンネルにも投稿しました'), '返信に自動投稿の注記がない');
      console.log('自動投稿（Bot戦→告知のみ）: OK');
    }

    // (3d) DM（guildId なし）＋人間対戦 → 投稿しない
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: null, mode: 'human', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 0, 'DMなのに投稿している');
      assert(roomCodeOf(interaction.replies[0].content), '返信にリンクが含まれていない');
      console.log('自動投稿（DM→投稿しない）: OK');
    }
  } finally {
    restoreConfig();
  }

  console.log('check-mahjong-command: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); restoreConfig(); process.exit(1); });
