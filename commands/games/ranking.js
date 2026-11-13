// commands/ranking.js  (discord.js v14 / CommonJS)
//
//   /ranking top     [game] [scope]   … レートランキング（scope: このサーバー / 全体）
//   /ranking profile [game] [user]    … 個人のレート・順位・戦績
//
// 対戦ゲームを増やしたら lib/games.js に追加するだけで、ここの選択肢にも反映されます。

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const rating = require('../../utils/rating');
const { GAMES, DEFAULT_GAME } = require('../../utils/games');

const TOP_N = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const gameChoices = Object.entries(GAMES).map(([value, g]) => ({ name: g.label, value }));

const addGameOption = (sub) =>
  sub.addStringOption((o) =>
    o
      .setName('game')
      .setDescription(`ゲーム（省略時: ${GAMES[DEFAULT_GAME]?.label ?? '-'}）`)
      .addChoices(...gameChoices),
  );

const winRate = (r) => {
  const total = r.wins + r.losses + r.draws;
  return total === 0 ? '-' : `${Math.round((r.wins / total) * 100)}%`;
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('対戦ゲームのレートランキングと戦績')
    .addSubcommand((sub) =>
      addGameOption(sub.setName('top').setDescription('レートランキングを表示')).addStringOption((o) =>
        o
          .setName('scope')
          .setDescription('範囲（省略時: このサーバー）')
          .addChoices(
            { name: 'このサーバー', value: 'server' },
            { name: '全体', value: 'global' },
          ),
      ),
    )
    .addSubcommand((sub) =>
      addGameOption(sub.setName('profile').setDescription('レート・順位・戦績を表示')).addUserOption((o) =>
        o.setName('user').setDescription('対象ユーザー（省略時: 自分）'),
      ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const gameId = interaction.options.getString('game') ?? DEFAULT_GAME;
    const label = GAMES[gameId].label;

    // ----- ランキング -----
    if (sub === 'top') {
      const scope = interaction.options.getString('scope') ?? 'server';
      const guildId = scope === 'server' ? interaction.guildId : null; // DMでは全体にフォールバック
      const scopeLabel = guildId ? interaction.guild?.name ?? 'このサーバー' : '全体';

      const rows = rating.getRanking(gameId, { guildId, limit: TOP_N });
      const embed = new EmbedBuilder()
        .setTitle(`🏆 ${label} レートランキング（${scopeLabel}）`)
        .setColor(0xf1c40f);

      if (rows.length === 0) {
        embed.setDescription('まだ対戦記録がありません。');
      } else {
        embed.setDescription(
          rows
            .map((r, idx) => {
              const place = MEDALS[idx] ?? `**${idx + 1}.**`;
              return `${place} <@${r.userId}> — **${Math.round(r.rating)}**  (${r.wins}勝 ${r.losses}敗 ${r.draws}分)`;
            })
            .join('\n'),
        );
        // 自分が圏外なら順位を添える
        if (!rows.some((r) => r.userId === interaction.user.id)) {
          const me = rating.getRank(gameId, interaction.user.id, guildId);
          if (me) embed.setFooter({ text: `あなたの順位: ${me.rank}位 / ${me.total}人` });
        }
      }
      return interaction.reply({ embeds: [embed] });
    }

    // ----- 個人戦績 -----
    const target = interaction.options.getUser('user') ?? interaction.user;
    if (target.bot) {
      return interaction.reply({ content: 'Botにはレートがありません。', flags: MessageFlags.Ephemeral });
    }

    const profile = rating.getProfile(gameId, target.id);
    if (!profile) {
      return interaction.reply({
        content: `<@${target.id}> さんはまだ${label}をプレイしていません。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const global = rating.getRank(gameId, target.id);
    const server = interaction.guildId ? rating.getRank(gameId, target.id, interaction.guildId) : null;

    const embed = new EmbedBuilder()
      .setTitle(`${label} の戦績`)
      .setDescription(`<@${target.id}>`)
      .setColor(0x3498db)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'レート', value: `**${Math.round(profile.rating)}**`, inline: true },
        { name: '全体順位', value: global ? `${global.rank}位 / ${global.total}人` : '-', inline: true },
        { name: 'サーバー順位', value: server ? `${server.rank}位 / ${server.total}人` : '-', inline: true },
        {
          name: '戦績',
          value: `${profile.wins}勝 ${profile.losses}敗 ${profile.draws}分（勝率 ${winRate(profile)}）`,
        },
      );
    return interaction.reply({ embeds: [embed] });
  },
};