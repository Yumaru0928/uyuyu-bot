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
    '<:crying_uyuyu:1524698363532935248>',
    '<:myumyumyu:1521842573314887762>',
    '<:suyarunn:1528488334014283806>',
    '<:uuuuuuuyuyuuuuuuu:1537390880934203392>',
    '<:uyuyu:1549375294614540409>',
    '<:uyuyu_:1551217609880510534>',
    '<:uyuyu_dango:1512638117268685020>',
    '<:uyuyu_fuck:1528265962984439970>',
    '<:uyuyu_mu:1528093863573585924>',
    '<:uyuyu_space:1523354371986030692>',
    '<:uyuyu_sweat:1527287285446344704>',
    '<:uyuyumarunn:1528036666936131715>',
    '<:WT_uyuyu:1529686813071900814>',
    '<:uyuyu_take:1539487778553729064>'
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
        componentType: ComponentType.Button
    });

    collector.on('collect', async i => {

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