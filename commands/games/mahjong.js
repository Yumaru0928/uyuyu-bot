// commands/games/mahjong.js (discord.js v14 / CommonJS)
//
// /mahjong → Web版 三人麻雀の対局ルームを作り、招待リンクを返す。
// 対局そのものは Web（/play/mahjong）で WebSocket で進む（utils/mahjong-server.js）。
// ババ抜きと同じハイブリッド方式（Discord はリンク発行の入口）。
// 自動投稿チャンネル対応はフェーズ3で追加予定（決定シート参照）。

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');

const mahjongServer = require('../../utils/mahjong-server.js');

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
        const content = mode === 'bot'
            ? `🀄 **三人麻雀（${lengthLabel}）** の Bot 戦ルームを作りました。リンクを開くとすぐに対局が始まります。\n${url}`
            : `🀄 **三人麻雀（${lengthLabel}）** の待機ルームを作りました（コード: \`${room.code}\`）。\nリンクを共有して3人そろったら、ホスト（あなた）がページで「対局開始」を押してください。空席は Bot で埋めることもできます。\n⏰ ルームの有効期限は約${WAITING_MINUTES}分です。\n${url}`;
        return interaction.reply({ content, components: [linkRow] });
    },
};
