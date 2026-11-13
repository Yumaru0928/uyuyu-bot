'use strict';

// ゲーム共通の「対戦申し込み」ヘルパー。
// どの対戦コマンドからでも、承諾/辞退/タイムアウトの流れをそのまま使い回せます。
//
//   const res = await requestChallenge(interaction, { opponent, gameLabel: 'オセロ' });
//   if (res.status !== 'accepted') return;        // 辞退・タイムアウトは内部で表示済み
//   await res.interaction.update({ ...ゲーム開始メッセージ });  // ← 承諾ボタンへの応答
//   const message = res.message;                  // 以降はこのメッセージにコレクターを付ける

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const ACCEPT_ID = 'challenge:accept';
const DECLINE_ID = 'challenge:decline';

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} opts
 * @param {import('discord.js').User} opts.opponent 指名された相手
 * @param {string} opts.gameLabel                  ゲームの表示名
 * @param {number} [opts.timeoutMs=300000]         応答待ち時間
 * @returns {Promise<{status:'accepted'|'declined'|'timeout', interaction?:any, message:any}>}
 */
async function requestChallenge(interaction, { opponent, gameLabel, timeoutMs = 5 * 60 * 1000 }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ACCEPT_ID).setLabel('受ける').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(DECLINE_ID).setLabel('辞退').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    content:
      `<@${opponent.id}> さん、<@${interaction.user.id}> さんから**${gameLabel}**の対戦申し込みです！\n` +
      '承諾しますか？',
    components: [row],
  });
  const message = await interaction.fetchReply();

  return new Promise((resolve) => {
    const collector = message.createMessageComponentCollector({ time: timeoutMs });

    collector.on('collect', async (i) => {
      if (i.user.id !== opponent.id) {
        i.reply({
          content: '対戦相手として指名された人だけが操作できます。',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      collector.stop('answered');

      if (i.customId === DECLINE_ID) {
        await i
          .update({ content: `<@${opponent.id}> さんは対戦を辞退しました。`, components: [] })
          .catch(() => {});
        resolve({ status: 'declined', message });
        return;
      }
      // 承諾: 呼び出し側が i.update(...) でゲーム画面に切り替える
      resolve({ status: 'accepted', interaction: i, message });
    });

    collector.on('end', async (_collected, reason) => {
      if (reason === 'answered') return;
      await message
        .edit({
          content: `<@${opponent.id}> さんからの応答がなかったため、対戦申し込みを取り消しました。`,
          components: [],
        })
        .catch(() => {});
      resolve({ status: 'timeout', message });
    });
  });
}

module.exports = { requestChallenge };