const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");

const Emojis = [
    '1549375294614540409',
    '1524698363532935248',
    '1521842573314887762',
    '1528488334014283806',
    '1537390880934203392',
    '1551217609880510534',
    '1512638117268685020',
    '1528265962984439970',
    '1528093863573585924',
    '1527287285446344704',
    '1528036666936131715',
    '1529686813071900814',
    '1539487778553729064',
    'a:rolling_uyuyu:1529182253207392267'
];

// ガチャ結果の文字列を生成する関数
function drawGacha() {
    const result = [];
    for (let i = 0; i < 10; i++) {
        const rand = Math.floor(Math.random() * Emojis.length);
        const item = Emojis[rand];
        if (item.startsWith('a:')) {
            result.push(`<${item}>`);
        } else {
            result.push(`<:emoji:${item}>`);
        }
    }
    return result.join(" ");
}

// ガチャの埋め込みメッセージとボタンを生成するヘルパー
function buildGachaMessage() {
    const embed = new EmbedBuilder()
        .setColor("#0099ff")
        .setTitle("うゆゆガチャ結果")
        .setDescription(drawGacha());

    const rerollButton = new ButtonBuilder()
        .setCustomId("reroll")
        .setLabel("もう一度回す")
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(rerollButton);

    return { embeds: [embed], components: [row] };
}

// メッセージに対してボタンの入力受け取りをセットアップする再帰関数
async function setupCollector(targetInteraction, responseMessage, userId) {
    const collector = responseMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 15000
    });

    collector.on('collect', async i => {
        if (i.user.id !== userId) {
            await i.reply({ content: 'このボタンは実行した本人のみ使用できます。', ephemeral: true });
            return;
        }

        // 1. 元のメッセージのボタンを無効化
        const disabledButton = new ButtonBuilder()
            .setCustomId("reroll_disabled")
            .setLabel("もう一度回す")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true);
        
        await i.update({ components: [new ActionRowBuilder().addComponents(disabledButton)] });

        // 2. 新しいガチャ結果を「新規メッセージ（返信）」として投稿
        const newPayload = buildGachaMessage();
        const newResponse = await i.followUp({
            ...newPayload,
            fetchReply: true
        });

        // 3. 新しく投稿されたメッセージにボタンの監視を引き継ぐ
        setupCollector(i, newResponse, userId);
    });

    collector.on('end', async (collected, reason) => {
        // 時間切れ等の場合、ボタンを無効化
        if (reason === 'time') {
            const disabledButton = new ButtonBuilder()
                .setCustomId("reroll_disabled")
                .setLabel("もう一度回す")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true);

            await targetInteraction.editReply({
                components: [new ActionRowBuilder().addComponents(disabledButton)]
            }).catch(() => {});
        }
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("uyuyu-gacha")
        .setDescription("うゆゆガチャを回します。")
        // サーバーインストール & ユーザー個人の連携アプリ(ユーザーインストール)の両方に対応
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        // サーバー内、BotのDM、ユーザーの個人DMなど全コンテキストで実行可能にする
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ]),

    async execute(interaction) {
        const payload = buildGachaMessage();

        const response = await interaction.reply({
            ...payload,
            fetchReply: true
        });

        // ボタン待機の開始
        setupCollector(interaction, response, interaction.user.id);
    }
};