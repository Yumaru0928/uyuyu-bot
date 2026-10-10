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

// 提供された絵文字IDのリスト
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

// IDからカスタム絵文字構文を作る関数
function formatEmoji(id) {
    return `<:slot_${id}:${id}>`;
}

// 確率を制御してスロットの結果（リール）を作る関数
function spinSlotsWithBias() {
    // 【確率設定】（調整可能）
    // 例: 100回のうち、大当たりが20%、2つ揃い（リーチ・ニア）が30%、ハズレが50%になるように別で抽選
    const rand = Math.random() * 100; // 0 〜 100 未満の乱数
    
    let reel = [];

    if (rand < 20) {
        // --- ① 大当たり（3つ全て同じ）にする確率: 20% ---
        // まずどの絵文字を揃えるかランダムに1つ選ぶ
        const winningEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        reel = [winningEmoji, winningEmoji, winningEmoji];

    } else if (rand < 50) {
        // --- ② 惜しい（2つ同じ）にする確率: 30% (20%〜50%) ---
        const matchingEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        // 違う絵文字をもう1つ用意
        let otherEmoji;
        do {
            otherEmoji = Emojis[Math.floor(Math.random() * Emojis.length)];
        } while (otherEmoji === matchingEmoji);

        // どこの位置に違う絵文字を挟むかランダムに決定 (例: [A, A, B] や [A, B, A] など)
        const patterns = [
            [matchingEmoji, matchingEmoji, otherEmoji],
            [matchingEmoji, otherEmoji, matchingEmoji],
            [otherEmoji, matchingEmoji, matchingEmoji]
        ];
        reel = patterns[Math.floor(Math.random() * patterns.length)];

    } else {
        // --- ③ 完全ハズレ（3つともバラバラ）にする確率: 50% (50%〜100%) ---
        // 重複しないように3つの絵文字を選ぶ
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
    const formattedReel = reel.map(id => formatEmoji(id));
    
    let resultText = "ざんねん！ハズレです。";
    let color = "#ED4245"; // 赤

    if (reel[0] === reel[1] && reel[1] === reel[2]) {
        resultText = "🎉 **大当たり (JACKPOT)！！** おめでとうございます！";
        color = "#57F287"; // 緑
    } else if (reel[0] === reel[1] || reel[1] === reel[2] || reel[0] === reel[2]) {
        resultText = "✨ **おしい！2つ揃いました！**";
        color = "#FEE75C"; // 黄色
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle("🎰 うゆゆスロット 🎰")
        .setDescription(`### 【 ${formattedReel.join(" | ")} 】\n\n${resultText}`)
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

        await i.update({ components: [new ActionRowBuilder().addComponents(disabledButton)] });

        // 確率制御された新しいリールを生成
        const newReel = spinSlotsWithBias();
        const newPayload = buildSlotMessage(newReel);
        const newResponse = await i.followUp({
            ...newPayload,
            fetchReply: true
        });

        setupCollector(newResponse, userId);
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("slot")
        .setDescription("確率が調整されたカスタム絵文字スロットで遊びます！")
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

        const responseMessage = await interaction.reply({
            ...payload,
            fetchReply: true
        });

        setupCollector(responseMessage, interaction.user.id);
    }
};