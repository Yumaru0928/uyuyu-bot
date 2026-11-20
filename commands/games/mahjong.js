// commands/games/mahjong.js (discord.js v14 / CommonJS)
//
// /mahjong → Web版 三人麻雀の対局ルームを作り、招待リンクを返す。
// 対局そのものは Web（/play/mahjong）で WebSocket で進む（utils/mahjong-server.js）。
// ババ抜きと同じハイブリッド方式（Discord はリンク発行の入口）。
//
// ・そのサーバーに自動投稿チャンネル（ダッシュボードで設定する
//   guildConfig.mahjongChannel）があれば、Bot がそこへも投稿する（フェーズ3「A 自動投稿」）:
//   - 人間対戦: 参加リンク＋ルームコード付きの募集を投稿する。投稿は対局が始まったら
//     「募集終了」に、待機期限が切れたら「時間切れ」に編集される。
//   - Bot 戦: 他の人は参加できないので、参加リンクは付けず告知だけを投稿する。
//   - 対局結果（順位・スコア）も同じチャンネルへ投稿されるが、人間の参加者が
//     2人以上の対局のときだけ（判定は utils/mahjong-server.js の finishMatch 側。
//     Bot戦などの結果はスパム防止のため流さない）。
// ・DM で実行された場合は自動投稿せず、リンクを返すだけ。

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');

const mahjongServer = require('../../utils/mahjong-server.js');
const { getChannelConfig } = require('../../utils/channel-config.js');

const WAITING_MINUTES = Math.round(mahjongServer.WAITING_TTL_MS / 60000);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mahjong')
        .setDescription('Web版 三人麻雀の対局ルームを作って、招待リンクを発行します')
        .addStringOption((o) =>
            o
                .setName('opponent')
                .setDescription('対戦相手（省略時は人間）')
                .addChoices(
                    { name: '人間（待機ルームで募集・3人）', value: 'human' },
                    { name: 'Bot（すぐに2人のBotと対戦）', value: 'bot' },
                ),
        )
        .addStringOption((o) =>
            o
                .setName('length')
                .setDescription('対局の長さ（省略時は東風戦）')
                .addChoices(
                    { name: '東風戦', value: 'east' },
                    { name: '半荘戦', value: 'south' },
                ),
        ),

    async execute(interaction) {
        const mode = interaction.options.getString('opponent') ?? 'human';
        const length = interaction.options.getString('length') ?? 'east';
        const host = interaction.user;
        const hostName = interaction.member?.displayName ?? host.globalName ?? host.username;

        const room = mahjongServer.createRoom({ mode, hostId: host.id, hostName, length });
        if (!room) {
            return interaction.reply({
                content: '今は混み合っていてルームを作れませんでした。少し待ってからもう一度お試しください。',
                flags: MessageFlags.Ephemeral,
            });
        }
        const url = mahjongServer.inviteUrl(room.code);
        const linkRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('対局ページを開く').setURL(url).setStyle(ButtonStyle.Link),
        );
        const lengthLabel = length === 'south' ? '半荘戦' : '東風戦';

        // サーバー内での実行なら、設定されていれば自動投稿チャンネルへ投稿する（ババ抜きと同じ方式）
        let postNote = '';
        if (interaction.guildId) {
            const channelId = getChannelConfig()[interaction.guildId]?.mahjongChannel;
            if (channelId) {
                try {
                    const channel = await interaction.client.channels.fetch(channelId);
                    if (!channel || typeof channel.send !== 'function') throw new Error('投稿できるチャンネルではありません');
                    let message;
                    if (mode === 'human') {
                        const postRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setLabel('参加する').setURL(url).setStyle(ButtonStyle.Link),
                        );
                        message = await channel.send({
                            content:
                                `🀄 **${hostName}** さんがWeb版三人麻雀（${lengthLabel}）の対戦相手を募集しています！\n` +
                                `ルームコード: \`${room.code}\`\n` +
                                `参加はこちらから（Discordログインが必要です）: ${url}`,
                            components: [postRow],
                        });
                    } else {
                        // Bot戦は他の人が参加できないので、参加リンクは付けず告知だけにする
                        message = await channel.send({
                            content: `🀄 **${hostName}** さんがWeb版三人麻雀（${lengthLabel}）のBot戦を始めました！`,
                        });
                    }
                    // 対局が始まったら・待機期限が切れたら投稿を書き換える。結果の投稿は
                    // finishMatch 側で「人間の参加者が2人以上」のときだけ onFinish が呼ばれる
                    room.hooks = {
                        onStart: async () => {
                            await message.edit({
                                content: mode === 'human'
                                    ? `🀄 **${hostName}** さんのWeb版三人麻雀（${lengthLabel}）の対局が始まりました！（募集は終了しました）`
                                    : `🀄 **${hostName}** さんのWeb版三人麻雀（${lengthLabel}）のBot戦が始まりました！`,
                                components: [],
                            });
                        },
                        onExpire: async () => {
                            await message.edit({
                                content: mode === 'human'
                                    ? `🀄 **${hostName}** さんのWeb版三人麻雀（${lengthLabel}）の募集は、${WAITING_MINUTES}分間対局が始まらなかったため終了しました。`
                                    : `🀄 **${hostName}** さんのWeb版三人麻雀（${lengthLabel}）のBot戦ルームは、${WAITING_MINUTES}分間対局が始まらなかったため終了しました。`,
                                components: [],
                            });
                        },
                        onFinish: async (finishedRoom, summary) => {
                            const medals = ['🥇', '🥈', '🥉'];
                            const lines = summary.results.map((r) =>
                                `${medals[r.rank - 1] || `${r.rank}位`} **${r.name}** ${Number(r.score).toLocaleString('ja-JP')}点（${r.total > 0 ? '+' : ''}${r.total}pt）`);
                            await channel.send({
                                content:
                                    `🀄 **三人麻雀（${summary.length === 'south' ? '半荘戦' : '東風戦'}）の対局結果**\n` +
                                    lines.join('\n'),
                            });
                        },
                    };
                    postNote = mode === 'human'
                        ? '\n📣 このサーバーの自動投稿チャンネルにも募集を投稿しました。'
                        : '\n📣 このサーバーの自動投稿チャンネルにも投稿しました。';
                } catch (error) {
                    console.error('[Mahjong] 自動投稿に失敗しました:', error);
                    postNote = '\n⚠️ 自動投稿チャンネルへの投稿に失敗しました（下のリンクは有効です）。';
                }
            }
        }

        const content = mode === 'bot'
            ? `🀄 **三人麻雀（${lengthLabel}）** の Bot 戦ルームを作りました。リンクを開くとすぐに対局が始まります。\n${url}` + postNote
            : `🀄 **三人麻雀（${lengthLabel}）** の待機ルームを作りました（コード: \`${room.code}\`）。\nリンクを共有して3人そろったら、ホスト（あなた）がページで「対局開始」を押してください。空席は Bot で埋めることもできます。\n⏰ ルームの有効期限は約${WAITING_MINUTES}分です。\n${url}` + postNote;
        return interaction.reply({ content, components: [linkRow] });
    },
};
