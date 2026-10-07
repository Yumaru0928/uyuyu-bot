const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const path = require('node:path');
const fs = require('node:fs');

// JSONデータの読み込み（3通り対応版のJSONを指定）
const jsonPath = path.join(__dirname, 'darts_checkout_3.json');
let checkoutData = null;

try {
    if (fs.existsSync(jsonPath)) {
        checkoutData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
} catch (error) {
    console.error('darts_checkout_3.json の読み込みに失敗しました:', error);
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
                content: 'データファイル (darts_checkout_3.json) が読み込めていません。管理者にお問い合わせください。',
                flags: MessageFlags.Ephemeral
            });
        }

        const type = interaction.options.getString('type');
        const out = interaction.options.getString('out');
        const score = interaction.options.getInteger('score');

        // キーの変換
        const typeKey = type === 'fat' ? 'fat_bull' : 'separate_bull';
        const outKey = `${out}_out`;

        // ルートのリストを取得 (例: [["T20", "D20"], ["BULL", "BULL"]])
        const routes = checkoutData.checkout?.[typeKey]?.[outKey]?.[String(score)];

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

        if (routes === undefined) {
            embed.setDescription('指定された条件のデータが見つかりませんでした。');
        } else if (routes === null) {
            embed.setColor('#ff4b4b')
                .addFields({ name: 'チェックアウト', value: '⚠️ **3投以内でチェックアウト不可能** です' });
        } else {
            // 第1推奨ルート（最優先）
            const mainRoute = routes[0];
            
            embed.setColor('#00ff00')
                .addFields(
                    { name: '推奨ルート (第1候補)', value: `\`${mainRoute.join(' ➔ ')}\`` },
                    { name: '必要本数', value: `${mainRoute.length}本`, inline: true }
                );

            // 代替ルート（2通り目以降）が存在する場合に追加表示
            if (routes.length > 1) {
                const subRoutesFormatted = routes.slice(1)
                    .map((r, index) => `候補${index + 2}: \`${r.join(' ➔ ')}\``)
                    .join('\n');

                embed.addFields({ name: 'その他のアレンジ候補', value: subRoutesFormatted });
            }
        }

        await interaction.reply({ embeds: [embed] });
    },
};