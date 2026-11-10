const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

// 必要な権限だけを求める（public/invite.html の招待リンクと同じ値にしておく）
// リアクション追加 / 監査ログ表示 / チャンネル表示 / メッセージ送信 / 埋め込み / ファイル添付 / 履歴閲覧 / 外部絵文字
const INVITE_LINK = 'https://discord.com/oauth2/authorize?client_id=1556620719494930562&permissions=1127261277645974&integration_type=0&scope=bot';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Botをサーバーに招待するためのリンクを表示します。'),
    async execute(interaction) {
        const inviteButton = new ButtonBuilder()
            .setLabel('Botを招待する')
            .setURL(INVITE_LINK)
            .setStyle(ButtonStyle.Link);

        const row = new ActionRowBuilder().addComponents(inviteButton);

        // 本文なし（ボタンだけ）の返信は「空のメッセージ」として拒否されることがあるため、一言添える
        await interaction.reply({ content: '下のボタンからうゆゆBotを招待できます！', components: [row] });
    }
};
