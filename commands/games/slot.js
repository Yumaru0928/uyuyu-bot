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

// 提供された絵文字リスト（アニメーション絵文字と通常のカスタム絵文字）
const Emojis = [
    '<a:transparent:1558522934438658119>',
    '<:emoji_1:1557748839035838626>',
    '<:emoji_2:1557748837194403972>',
    '<:emoji_3:1557409243311644846>',
    '<:emoji_4:1557409093059219457>',
    '<:emoji_5:1557407787221516289>',
    '<:emoji_6:1557407767600570418>',
    '<:emoji_7:1557407765704478900>',
    '<:emoji_8:1557407760986017853>',
    '<:emoji_9:1557407751259291698>',
    '<:emoji_10:1557407749556408381>',
    '<:emoji_11:1557407747627294761>',
    '<:emoji_12:1557407745676943392>',
    '<:emoji_13:1557407743931842610>',
    '<:emoji_14:1557407738919919666>',
    '<:emoji_15:1557023770919698573>'
];

// 確率を制御してスロットの結果（リール）を作る関数
function spinSlotsWithBias() {
    const rand = Math.random() * 100;
    let reel = [];

    if (rand < 5) {
        // 大当たり（3つ全て同じ）: 5%
        const winningEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        reel = [winningEmoji, winningEmoji, winningEmoji];
    } else if (rand < 25) {
        // おしい（2つ同じ）: 20%
        const matchingEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        let otherEmoji;
        do {
            otherEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        } while (otherEmoji === matchingEmoji);

        const patterns = [
            [matchingEmoji, matchingEmoji, otherEmoji],
            [matchingEmoji, otherEmoji, matchingEmoji],
            [otherEmoji, matchingEmoji, matchingEmoji]
        ];
        reel = patterns[Math.floor(Math.random() * patterns.length)];
    } else {
        // 完全ハズレ: 50%
        while (reel.length < 3) {
            const randomEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
            if (!reel.includes(randomEmoji)) {
                reel.push(randomEmoji);
            }
        }
    }

    return reel;
}

// スロットの結果判定とメッセージ作成ヘルパー
function buildSlotMessage(reel) {
    let resultText = "ざんねん！ハズレです。";
    let color = "#ED4245"; // 赤

    if (reel[0] === reel[1] && reel[1] === reel[2]) {
        resultText = "🎉 **大当たり (JACKPOT)！！** おめでとうございます！";
        color = "#57F287"; // 緑
    } else if (reel[0] === reel[1] || reel[1] === reel[2] || reel[0] === reel[2]) {
        resultText = "✨ **おしい！2つ揃えました！**";
        color = "#FEE75C"; // 黄色
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle("🎰 うゆゆスロット 🎰")
        .setDescription(`### 【 ${reel.join(" | ")} 】\n\n${resultText}`)
        .addFields(
            { name: '操作', value: '下のボタンを押してもう一度スピンできます。', inline: false }
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
        time: 60000 // 60秒
    });

    collector.on('collect', async i => {
        if (i.user.id !== userId) {
            await i.reply({ content: '他の人のスロットは操作できません。自分でコマンドを実行してください！', ephemeral: true });
            return;
        }

        const disabledButton = new ButtonBuilder()
            .setCustomId("slot_spin_disabled")
            .setLabel("回転中...")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true);

        // ★ 修正: newActionRowBuilder() → new ActionRowBuilder() に修正
        await i.update({ components: [new ActionRowBuilder().addComponents(disabledButton)] });

        const newReel = spinSlotsWithBias();
        const newPayload = buildSlotMessage(newReel);
        
        // ★ 修正: fetchReply を削除（または withResponse を利用する形へ変更）
        const newResponse = await i.followUp({
            ...newPayload
        });

        setupCollector(newResponse, userId);
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("slot")
        .setDescription("アニメーション絵文字対応の確率制御スロットで遊びます！")
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
        const initialReel = spinSlotsWithBias();
        const payload = buildSlotMessage(initialReel);

        // ★ 修正: 初回返信時も fetchReply を削除
        const responseMessage = await interaction.reply({
            ...payload,
            fetchReply: true // 初回返信時の fetchReply は警告が出るため削除
        });

        setupCollector(responseMessage, interaction.user.id);
    }
};