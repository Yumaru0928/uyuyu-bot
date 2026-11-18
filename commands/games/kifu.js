const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const kifuStore = require('../../utils/kifu-store');
const mahjongHistory = require('../../utils/mahjong-history-store');
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

function fmtDate(ts) {
  return new Date(ts).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kifu')
    .setDescription('自分の最近の対戦履歴（再生リンクとコード）を表示します'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const records = kifuStore.listForUser(userId).slice(0, 5);
    const mjRecords = mahjongHistory.listForUser(userId).slice(0, 3);
    const listUrl = `${BASE_URL}/play/kifu`;

    if (records.length === 0 && mjRecords.length === 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📜 あなたの対戦履歴')
            .setColor('#0099ff')
            .setDescription(
              'まだ対戦履歴がありません。\n対戦ゲーム（将棋・オセロ・四目並べ）やWeb版麻雀で対局すると、対戦履歴が自動で残ります。\n' +
                `一覧と再生は [対戦履歴ページ](${listUrl}) からも見られます。`,
            ),
        ],
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('📜 あなたの最近の対戦履歴')
      .setColor('#0099ff')
      .setDescription(`対戦履歴は30日間保管されます（お気に入りは自動で消えません）。\n一覧・再生・お気に入りは [対戦履歴ページ](${listUrl}) から。`);

    for (const r of records) {
      const opponent = r.players.find((p) => p.id !== userId) ?? r.players[1];
      const isFirst = r.firstId === userId;
      const result = r.winnerId === null ? '🤝 引き分け' : r.winnerId === userId ? '🏆 勝ち' : '負け';
      const fav = kifuStore.getFavorite(userId, r.id);
      const oppLabel = opponent.bot
        ? `${opponent.name}（Bot・${LEVEL_LABEL[r.level] ?? r.level ?? ''}）`
        : opponent.name;
      embed.addFields({
        name: `${fav ? '★ ' : ''}${fav?.name ?? `${GAMES[r.game]?.label ?? r.game} vs ${oppLabel}`}`,
        value:
          `${GAMES[r.game]?.label ?? r.game} vs ${oppLabel}（${isFirst ? '先手' : '後手'}） ・ ${result} ・ ${r.moves.length}手 ・ ` +
          `${REASON_LABEL[r.reason] ?? r.reason} ・ ${fmtDate(r.createdAt)}\n` +
          `コード: **${r.code}** ・ [対戦履歴を見る](${BASE_URL}/play/kifu/${r.code})`,
      });
    }

    for (const r of mjRecords) {
      const mySeat = r.players.findIndex((p) => p.id === userId && !p.bot);
      const placement = mySeat >= 0 && r.placements ? r.placements[mySeat] : null;
      const fav = mahjongHistory.getFavorite(userId, r.id);
      const names = r.players.map((p) => p.name).join(' / ');
      const top = r.scores ? Math.max(...r.scores) : null;
      embed.addFields({
        name: `${fav ? '★ ' : ''}${fav?.name ?? `三人麻雀（${r.length === 'south' ? '半荘' : '東風'}）`}`,
        value:
          `${names} ・ ${placement ? `${placement}位` : ''}${top !== null ? ` ・ トップ ${top}点` : ''} ・ ${r.rounds.length}局 ・ ${fmtDate(r.createdAt)}\n` +
          `コード: **${r.code}** ・ [リプレイを見る](${BASE_URL}/play/mahjong/replay/${r.code})`,
      });
    }

    return interaction.reply({ embeds: [embed] });
  },
};
