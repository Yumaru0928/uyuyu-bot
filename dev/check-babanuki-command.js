#!/usr/bin/env node
'use strict';

// /babanuki コマンドと自動投稿チャンネル設定の動作確認（npm test には含めない手動チェック）。
//   node dev/check-babanuki-command.js
// Discord クライアントはスタブ化し、実 Discord には接続しない。
// (1) コマンドが既存ローダーの流儀（commands/ を走査して data/execute を読む）で読み込めること
// (2) チャンネル設定（utils/channel-config.js）の読み書きが既存方式で動き、
//     設定キー babanukiChannel が往復すること
// (3) 自動投稿の分岐: 設定あり＋人間対戦→投稿する／設定なし→投稿しない／
//     Bot戦→投稿しない／DM→投稿しない ことと、投稿の編集フック（onStart）が付くこと
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
  const m = String(text).match(/\/play\/babanuki\?room=([A-Z0-9]{6})/);
  return m && m[1];
}

async function main() {
  const babanukiServer = require('../utils/babanuki-server.js');
  const channelConfig = require('../utils/channel-config.js');

  // (1) 既存ローダーと同じ走査で、全コマンドが data/execute を持ち、babanuki が含まれること
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
    assert(names.includes('babanuki'), '/babanuki コマンドが読み込めていない');
    console.log(`コマンド読み込み: OK（${names.length}件、babanuki を含む）`);
  }

  const command = require('../commands/games/babanuki.js');
  const GUILD_WITH = 'guild-with-post';
  const GUILD_WITHOUT = 'guild-without-post';

  try {
    // (2) チャンネル設定の読み書き（既存方式）と babanukiChannel の往復
    channelConfig.updateChannelConfig((data) => {
      channelConfig.ensureGuildConfig(data, GUILD_WITH).babanukiChannel = 'ch-post';
    });
    assert.strictEqual(channelConfig.getChannelConfig()[GUILD_WITH].babanukiChannel, 'ch-post');
    console.log('チャンネル設定の読み書き（babanukiChannel）: OK');

    // (3a) 設定あり＋人間対戦 → 投稿する。返信は ephemeral で同じリンクを含む
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: GUILD_WITH, mode: 'human', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 1, '自動投稿がされていない');
      assert(stub.sent[0].content.includes('ホスト表示名'), '投稿にホスト名が含まれていない');
      const code = roomCodeOf(stub.sent[0].content);
      assert(code, '投稿に招待リンクが含まれていない');
      assert.strictEqual(interaction.replies.length, 1);
      assert.strictEqual(interaction.replies[0].flags, MessageFlags.Ephemeral, '返信が ephemeral ではない');
      assert(interaction.replies[0].content.includes(`/play/babanuki?room=${code}`), '返信と投稿のリンクが一致しない');
      assert(interaction.replies[0].content.includes('自動投稿チャンネルにも募集を投稿しました'), '返信に自動投稿の注記がない');
      const room = babanukiServer.rooms.get(code);
      assert(room && room.hostId === '111' && room.mode === 'human', 'ルームにホストが記録されていない');
      assert(room.hooks && typeof room.hooks.onStart === 'function' && typeof room.hooks.onExpire === 'function', '編集フックが付いていない');
      await room.hooks.onStart(room);
      assert.strictEqual(stub.edits.length, 1, '対局開始時の編集がされていない');
      assert(stub.edits[0].content.includes('募集は終了しました'), '編集内容が募集終了になっていない');
      console.log('自動投稿（設定あり・人間対戦→投稿＋開始時編集）: OK');
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

    // (3c) 設定あり＋Bot戦 → 投稿しない
    {
      const stub = makeChannelStub('ch-post');
      const interaction = makeInteraction({ guildId: GUILD_WITH, mode: 'bot', channelStub: stub });
      await command.execute(interaction);
      assert.strictEqual(stub.sent.length, 0, 'Bot戦なのに投稿している');
      assert(roomCodeOf(interaction.replies[0].content), '返信にリンクが含まれていない');
      console.log('自動投稿（Bot戦→投稿しない）: OK');
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

  console.log('check-babanuki-command: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); restoreConfig(); process.exit(1); });
