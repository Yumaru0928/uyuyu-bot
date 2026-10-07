const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const path = require('node:path');
const fs = require('node:fs');

// JSONデータの読み込み
const jsonPath = path.join(__dirname, 'darts_checkout.json');
let checkoutData = null;

try {
    if (fs.existsSync(jsonPath)) {
        checkoutData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
} catch (error) {
    console.error('darts_checkout.json の読み込みに失敗しました:', error);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('calculate-darts-checkout')
        .setDescription('ダーツのチェックアウト（上がり目）ルートを計算します')
        // オプション1: type (fat/separate)
        .addStringOption(option =>
            option
                .setName('type')
                .setDescription('ブルのタイプを選択')
                .setRequired(true)
                .addChoices(
                    { name: 'ファットブル (Fat Bull)', value: 'fat' },
                    { name: 'セパレートブル (Separate Bull)', value: 'separate' }
                )
        )
        // オプション2: out (master/double/open)
        .addStringOption(option =>
            option
                .setName('out')
                .setDescription('アウトのルールを選択')
                .setRequired(true)
                .addChoices(
                    { name: 'マスターアウト (Master Out)', value: 'master' },
                    { name: 'ダブルアウト (Double Out)', value: 'double' },
                    { name: 'オープンアウト (Open Out)', value: 'open' }
                )
        )
        // オプション3: score (1-180)
        .addIntegerOption(option =>
            option
                .setName('score')
                .setDescription('残りスコアを入力 (1〜180)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(180)
        ),

    async execute(interaction) {
        if (!checkoutData) {
            return await interaction.reply({
                content: 'データファイル (darts_checkout.json) が読み込めていません。管理者にお問い合わせください。',
                flags: MessageFlags.Ephemeral
            });
        }

        const type = interaction.options.getString('type');
        const out = interaction.options.getString('out');
        const score = interaction.options.getInteger('score');

        // キーの変換
        const typeKey = type === 'fat' ? 'fat_bull' : 'separate_bull';
        const outKey = `${out}_out`;

        // ルートの取得
        const routeList = checkoutData.checkout?.[typeKey]?.[outKey]?.[String(score)];

        // 表示用のラベル
        const typeLabel = type === 'fat' ? 'ファットブル' : 'セパレートブル';
        const outLabel = out === 'master' ? 'マスターアウト' : out === 'double' ? 'ダブルアウト' : 'オープンアウト';

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`🎯 ダーツ チェックアウト結果`)
            .addFields(
                { name: '残りスコア', value: `${score}点`, inline: true },
                { name: 'ブル設定', value: typeLabel, inline: true },
                { name: 'アウトルール', value: outLabel, inline: true }
            )
            .setTimestamp();

        if (routeList === undefined) {
            embed.setDescription('指定された条件のデータが見つかりませんでした。');
        } else if (routeList === null) {
            embed.setColor('#ff4b4b')
                .addFields({ name: 'チェックアウト', value: '⚠️ **3投以内でチェックアウト不可能** です' });
        } else {
            embed.setColor('#0000ff')
                .addFields(
                    { name: '推奨ルート', value: `\`${routeList.join(' ➔ ')}\`` },
                    { name: '必要本数', value: `${routeList.length}本`, inline: true }
                );
        }

        await interaction.reply({ embeds: [embed] });
    },
};