// commands/games/babanuki.js (discord.js v14 / CommonJS)
//
// /babanuki [opponent:人間|Bot] → Web版ババ抜きの対戦ルームを作り、招待リンクを返す。
//
// 対局そのものは Web（/play/babanuki）で WebSocket で進む（utils/babanuki-server.js）。
// Discord は「リンク発行・募集」の入口に徹するハイブリッド方式（決定シート参照）。
// リンクは URL なので、別のサーバーの人や DM 経由でも参加できる（クロスサーバー対戦）。
//
// ・返信は ephemeral（リンクをコピーして好きな場所に貼れるように、他人には見せない）
// ・人間対戦のとき、そのサーバーに自動投稿チャンネル（ダッシュボードで設定する
//   guildConfig.babanukiChannel）があれば、Bot がそこへも募集を投稿する。
//   投稿は対局が始まったら「募集終了」に、待機期限が切れたら「時間切れ」に編集される。
// ・Bot 戦ルームは自動投稿しない。DM で実行された場合は自動投稿せず、リンクを返すだけ。

const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');

const babanukiServer = require('../../utils/babanuki-server.js');
const { getChannelConfig } = require('../../utils/channel-config.js');

const WAITING_MINUTES = Math.round(babanukiServer.WAITING_TTL_MS / 60000);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('babanuki')
        .setDescription('Web版ババ抜きの対戦ルームを作って、招待リンクを発行します')
        .addStringOption((o) =>
            o
                .setName('opponent')
                .setDescription('対戦相手（省略時は人間）')
                .addChoices(
                    { name: '人間（対戦相手を募集）', value: 'human' },
                    { name: 'Bot（すぐに対戦）', value: 'bot' },
                ),
        ),

    async execute(interaction) {
        const mode = interaction.options.getString('opponent') ?? 'human';
        const host = interaction.user;
        const hostName = interaction.member?.displayName ?? host.globalName ?? host.username;

        const room = babanukiServer.createRoom({ mode, hostId: host.id, hostName });
        if (!room) {
            return interaction.reply({
                content: '今は混み合っていてルームを作れませんでした。少し待ってからもう一度お試しください。',
                flags: MessageFlags.Ephemeral,
            });
        }
        const url = babanukiServer.inviteUrl(room.code);
        const linkRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('対戦ページを開く').setURL(url).setStyle(ButtonStyle.Link),
        );

        // 人間対戦＋サーバー内での実行なら、設定されていれば自動投稿チャンネルへ募集を投稿する
        let postNote = '';
        if (mode === 'human' && interaction.guildId) {
            const channelId = getChannelConfig()[interaction.guildId]?.babanukiChannel;
            if (channelId) {
                try {
                    const channel = await interaction.client.channels.fetch(channelId);
                    if (!channel || typeof channel.send !== 'function') throw new Error('投稿できるチャンネルではありません');
                    const postRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setLabel('参加する').setURL(url).setStyle(ButtonStyle.Link),
                    );
                    const message = await channel.send({
                        content:
                            `🃏 **${hostName}** さんがWeb版ババ抜きの対戦相手を募集しています！\n` +
                            `参加はこちらから（Discordログインが必要です）: ${url}`,
                        components: [postRow],
                    });
                    // 対局が始まったら・待機期限が切れたら、投稿を募集終了の表示に書き換える
                    room.hooks = {
                        onStart: async () => {
                            await message.edit({
                                content: `🃏 **${hostName}** さんのWeb版ババ抜き対戦が始まりました！（募集は終了しました）`,
                                components: [],
                            });
                        },
                        onExpire: async () => {
                            await message.edit({
                                content: `🃏 **${hostName}** さんのWeb版ババ抜きの募集は、${WAITING_MINUTES}分間相手が現れなかったため終了しました。`,
                                components: [],
                            });
                        },
                    };
                    postNote = '\n📣 このサーバーの自動投稿チャンネルにも募集を投稿しました。';
                } catch (error) {
                    console.error('[Babanuki] 自動投稿に失敗しました:', error);
                    postNote = '\n⚠️ 自動投稿チャンネルへの投稿に失敗しました（下のリンクは有効です）。';
                }
            }
        }

        if (mode === 'bot') {
            return interaction.reply({
                content:
                    `🤖 Bot対戦ルームを作りました！\n` +
                    `このリンクを開くと対戦が始まります（あなたがホストとして入ります）:\n${url}`,
                components: [linkRow],
                flags: MessageFlags.Ephemeral,
            });
        }
        return interaction.reply({
            content:
                `🃏 ババ抜きの待機ルームを作りました！\n` +
                `まず、あなた自身がこのリンクを開いて待機してください（サイトでDiscordログイン済みだとホスト席に入ります）。\n` +
                `相手にはこのリンクを渡してください。別のサーバーの人や、DMで渡した相手でも参加できます:\n${url}\n` +
                `⏰ ${WAITING_MINUTES}分以内に相手が来ないと、ルームは自動で閉じます。` +
                postNote,
            components: [linkRow],
            flags: MessageFlags.Ephemeral,
        });
    },
};
