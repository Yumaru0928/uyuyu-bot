const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('フォルダ（カテゴリ）ごとに分類されたコマンド一覧を表示します'),
    async execute(interaction) {
        const commands = interaction.client.commands;

        // フォルダ（カテゴリ）ごとにコマンドをグループ化するマップ
        const categories = new Map();

        commands.forEach(cmd => {
            // フォルダ名を取得（設定されていない場合は 'uncategorized'）
            const categoryName = cmd.category || 'その他';

            if (!categories.has(categoryName)) {
                categories.set(categoryName, []);
            }
            categories.get(categoryName).push(cmd);
        });

        // Embed の作成
        const helpEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('📖 コマンド一覧')
            .setDescription('利用可能なコマンドをカテゴリごとに一覧表示しています。')
            .setTimestamp();

        // フォルダ（カテゴリ）ごとに Embed フィールドを作成して追加
        categories.forEach((cmdList, category) => {

            // 見出しの日本語マッピング（例）
            const categoryNames = {
                utility: '⚙️ ユーティリティ',
                moderation: '🛡️ サーバー管理',
                games: '🎮 ゲーム',
            };

            // Embed作成時のタイトル取得部分
            const categoryTitle = categoryNames[category] || `📁 ${category}`;

            // コマンド一覧を文字列として整形
            const descriptionList = cmdList
                .map(cmd => `• **/${cmd.data.name}**: ${cmd.data.description || '説明なし'}`)
                .join('\n');

            helpEmbed.addFields({
                name: categoryTitle,
                value: descriptionList || 'コマンドはありません',
                inline: false, // 見出しごとに改行
            });
        });

        await interaction.reply({ embeds: [helpEmbed] });
    },
};