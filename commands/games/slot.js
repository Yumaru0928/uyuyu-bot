const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} = require("discord.js");
const { UYUYU_EMOJIS, SLOT_TRANSPARENT, SLOT_EXTRA, asText } = require("../../emojis.js");

// スロットに使う絵文字（透明のアニメーション絵文字と、通常のカスタム絵文字）
// ※ uyuyu_1 は元からスロットには入っていない
const Emojis = [
    SLOT_TRANSPARENT,
    ...UYUYU_EMOJIS.filter(emoji => emoji.name !== 'uyuyu').map(asText),
    SLOT_EXTRA
];

const COLLECTOR_TIME_MS = 60000; // 60秒

const randomEmoji = () => Emojis[Math.floor(Math.random() * Emojis.length)];

// 確率を制御してスロットの結果（リール）を作る関数
function spinSlotsWithBias() {
    const rand = Math.random() * 100;
    let reel = [];

    if (rand < 5) {
        // 大当たり（3つ全て同じ）: 5%
        const winningEmoji = randomEmoji();
        reel = [winningEmoji, winningEmoji, winningEmoji];
    } else if (rand < 25) {
        // おしい（2つ同じ）: 20%
        const matchingEmoji = randomEmoji();
        let otherEmoji;
        do {
            otherEmoji = randomEmoji();
        } while (otherEmoji === matchingEmoji);

        const patterns = [
            [matchingEmoji, matchingEmoji, otherEmoji],
            [matchingEmoji, otherEmoji, matchingEmoji],
            [otherEmoji, matchingEmoji, matchingEmoji]
        ];
        reel = patterns[Math.floor(Math.random() * patterns.length)];
    } else {
        // 完全ハズレ（3つとも別々）: 75%
        while (reel.length < 3) {
            const emoji = randomEmoji();
            if (!reel.includes(emoji)) {
                reel.push(emoji);
            }
        }
    }

    return reel;
}

// スピンボタンの行（無効化した状態も作れる）
function spinRow(label = "🎰 スピンする！", disabled = false) {
    const spinButton = new ButtonBuilder()
        .setCustomId(disabled ? "slot_spin_disabled" : "slot_spin")
        .setLabel(label)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled);

    return new ActionRowBuilder().addComponents(spinButton);
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

    return { embeds: [embed], components: [spinRow()] };
}

// ボタンのインタラクションを処理するコレクター
// webhook: コマンドのインタラクションの Webhook（時間切れでボタンを無効にするときに使う）
function setupCollector(responseMessage, userId, webhook) {
    const collector = responseMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: COLLECTOR_TIME_MS
    });

    collector.on('collect', async i => {
        if (i.user.id !== userId) {
            await i.reply({ content: '他の人のスロットは操作できません。自分でコマンドを実行してください！', flags: MessageFlags.Ephemeral });
            return;
        }

        // このメッセージはここで役目を終える（次の結果は新しいメッセージで出す）
        collector.stop('spun');

        await i.update({ components: [spinRow("回転中...", true)] });

        const newPayload = buildSlotMessage(spinSlotsWithBias());
        const newResponse = await i.followUp(newPayload);

        setupCollector(newResponse, userId, webhook);
    });

    // 60秒操作がなかったら、反応しなくなったボタンを無効にしておく
    collector.on('end', (collected, reason) => {
        if (reason !== 'time') return;
        webhook
            .editMessage(responseMessage, { components: [spinRow("時間切れ", true)] })
            .catch(() => { }); // 15分を過ぎたインタラクションなどは編集できないので、失敗しても気にしない
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("slot")
        .setDescription("スロットを回す")
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
        const payload = buildSlotMessage(spinSlotsWithBias());

        // 返信したメッセージを受け取る（fetchReply は非推奨なので withResponse を使う）
        const response = await interaction.reply({ ...payload, withResponse: true });

        setupCollector(response.resource.message, interaction.user.id, interaction.webhook);
    }
};
