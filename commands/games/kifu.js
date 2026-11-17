const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const kifuStore = require('../../utils/kifu-store');
const { GAMES } = require('../../utils/games');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://uyuyu-bot.onrender.com';

const REASON_LABEL = {
  checkmate: '詰み',
  nomove: '指せる手なし',
  resign: '投了',
  timeout: '時間切れ',
  perpetual: '連続王手の千日手',
  repetition: '千日手',
  maxply: '持将棋',
  score: '石数',
  four: '4つ並び',
};
const LEVEL_LABEL = { easy: '弱い', normal: '普通', hard: '強い' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kifu')
    .setDescription('自分の最近の対局の棋譜（再生リンクと棋譜コード）を表示します'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const records = kifuStore.listForUser(userId).slice(0, 5);
    const listUrl = `${BASE_URL}/play/kifu`;

    if (records.length === 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📜 あなたの棋譜')
            .setColor('#0099ff')
            .setDescription(
              'まだ棋譜がありません。\n対戦ゲーム（将棋・オセロ・四目並べ）で対局すると、棋譜が自動で残ります。\n' +
                `棋譜の一覧と再生は [棋譜ページ](${listUrl}) からも見られます。`,
            ),
        ],
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('📜 あなたの最近の棋譜')
      .setColor('#0099ff')
      .setDescription(`棋譜は30日間保管されます（お気に入りは自動で消えません）。\n一覧・再生・お気に入りは [棋譜ページ](${listUrl}) から。`);

    for (const r of records) {
      const opponent = r.players.find((p) => p.id !== userId) ?? r.players[1];
      const isFirst = r.firstId === userId;
      const result = r.winnerId === null ? '🤝 引き分け' : r.winnerId === userId ? '🏆 勝ち' : '負け';
      const fav = kifuStore.getFavorite(userId, r.id);
      const oppLabel = opponent.bot
        ? `${opponent.name}（Bot・${LEVEL_LABEL[r.level] ?? r.level ?? ''}）`
        : opponent.name;
      const date = new Date(r.createdAt).toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      embed.addFields({
        name: `${fav ? '★ ' : ''}${fav?.name ?? `${GAMES[r.game]?.label ?? r.game} vs ${oppLabel}`}`,
        value:
          `${GAMES[r.game]?.label ?? r.game} vs ${oppLabel}（${isFirst ? '先手' : '後手'}） ・ ${result} ・ ${r.moves.length}手 ・ ` +
          `${REASON_LABEL[r.reason] ?? r.reason} ・ ${date}\n` +
          `棋譜コード: **${r.code}** ・ [棋譜を見る](${BASE_URL}/play/kifu/${r.code})`,
      });
    }

    return interaction.reply({ embeds: [embed] });
  },
};
