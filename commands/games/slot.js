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

// 提供されたIDのリスト
const Emojis = [
    '1549375294614540409',
    '1557748837194403972',
    '1557748839035838626',
    '1557409093059219457',
    '1557407745676943392',
    '1557409243311644846',
    '1557407749556408381',
    '1557407765704478900',
    '1557407751259291698',
    '1557407738919919666',
    '1557407767600570418',
    '1557407760986017853',
    '1557407743931842610',
    '1557407787221516289',
    '1557407747627294761'
];

// IDからカスタム絵文字構文（<:emoji:ID> またはカスタム名付き）を作る関数
function formatEmoji(id) {
    // Discordのカスタム絵文字は名前が適当でもIDがあれば <:slot:ID> の形式で表示できます
    return `<:slot_${id}:${id}>`;
}

// 3つのスロットリールをランダムに回す関数
function spinSlots() {
    const reel = [];
    for (let i = 0; i < 3; i++) {
        const randomIndex = Math.floor(Math.random() * Emojis.length);
        reel.push(Emojis[randomIndex]);
    }
    return reel;
}

// スロットの結果判定とメッセージ作成ヘルパー
function buildSlotMessage(reel) {
    const formattedReel = reel.map(id => formatEmoji(id));
    
    // 判定ロジック（3つ揃ったら当たり、2つなら惜しい、など）
    let resultText = "ざんねん！ハズレです。";
    let color = "#ED4245"; // 赤（ハズレ）

    if (reel[0] === reel[1] && reel[1] === reel[2]) {
        resultText = "🎉 **大当たり (JACKPOT)！！** おめでとうございます！";
        color = "#57F287"; // 緑（大当たり）
    } else if (reel[0] === reel[1] || reel[1] === reel[2] || reel[0] === reel[2]) {
        resultText = "✨ **しい！2つ揃いました！**";
        color = "#FEE75C"; // 黄色（リーチ）
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle("🎰 ースロットゲーム 🎰")
        .setDescription(`### 【 ${formattedReel.join(" | ")} 】\n\n${resultText}`)
        .addFields(
            { name: '遊び方', value: '下の「スピンする」ボタンを押して再挑戦できます。', inline: false }
        )
        .setTimestamp();

    const spinButton = new ButtonBuilder()
        .setCustomId("slot_spin")
        .setLabel("🎰 スピンする！")
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(spinButton);

    return { embeds: [embed], components: [row] };
}

// ボタンのインタラクションを処理するコレクター
function setupCollector(responseMessage, userId) {
    const collector = responseMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000 // 60秒間操作がないとタイムアウト
    });

    collector.on('collect', async i => {
        // 実行者本人のみ操作できるように制限する場合
        if (i.user.id !== userId) {
            await i.reply({ content: '他の人のスロットは操作できません。自分でコマンドを実行してください！', ephemeral: true });
            return;
        }

        // ボタンを一時的に無効化して更新
        const disabledButton = new ButtonBuilder()
            .setCustomId("slot_spin_disabled")
            .setLabel("回転中...")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true);

        await i.update({ components: [new ActionRowBuilder().addComponents(disabledButton)] });

        // 新しいスロット結果を生成して送信
        const newReel = spinSlots();
        const newPayload = buildSlotMessage(newReel);
        const newResponse = await i.followUp({
            ...newPayload,
            fetchReply: true
        });

        // 新しいメッセージに対して再度コレクターを紐付け
        setupCollector(newResponse, userId);
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("slot")
        .setDescription("提供された絵文字でスロットゲームを遊べます！")
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        .setContexts([
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ]),

    async execute(interaction) {
        const initialReel = spinSlots();
        const payload = buildSlotMessage(initialReel);

        const responseMessage = await interaction.reply({
            ...payload,
            fetchReply: true
        });

        setupCollector(responseMessage, interaction.user.id);
    }
};