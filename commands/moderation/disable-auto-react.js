const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disable-auto-react-channel')
        .setDescription('実行したチャンネルのAuto-Reactを無効化します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const channel = interaction.channel;
        const guildId = interaction.guild.id;
        const filePath = path.join(__dirname, '..', '..', 'config-channels.json');

        let channelsData = {};

        // 1. まずローカルの JSON ファイルを確認して読み込み
        if (fs.existsSync(filePath)) {
            try {
                const rawData = fs.readFileSync(filePath, 'utf8');
                channelsData = JSON.parse(rawData);
            } catch (error) {
                console.error('JSON読み込みエラー (ローカル):', error);
            }
        }

        // 2. サーバー用のオブジェクト・配列の初期化
        if (!channelsData[guildId]) {
            channelsData[guildId] = {};
        }
        if (!Array.isArray(channelsData[guildId].disableAutoReact)) {
            channelsData[guildId].disableAutoReact = [];
        }

        // 3. 重複チェック
        if (channelsData[guildId].disableAutoReact.includes(channel.id)) {
            return await interaction.reply({
                content: `${channel} は既に無効化リストに追加されています。`,
                flags: MessageFlags.Ephemeral
            });
        }

        // 4. 配列へIDを追加
        channelsData[guildId].disableAutoReact.push(channel.id);

        try {
            // ① メモリ/一時ディスク用にローカルファイルへ書き込み
            fs.writeFileSync(filePath, JSON.stringify(channelsData, null, 4), 'utf8');

            // ② ユーザーへ返信
            await interaction.reply({
                content: `このチャンネル (${channel}) をAuto-React無効化リストに追加しました！`,
                flags: MessageFlags.Ephemeral
            });

            // ③ GitHub APIへ自動コミット（dataブランチ対応 & [skip render] 追加）
            if (interaction.client.commitJsonToGitHub) {
                await interaction.client.commitJsonToGitHub(
                    'config-channels.json',
                    channelsData,
                    `auto: disable auto-react for channel ${channel.id} in guild ${guildId} [skip render]`
                );
            }
        } catch (error) {
            console.error('JSON保存エラー:', error);
            if (!interaction.replied) {
                await interaction.reply({
                    content: 'データの保存処理中にエラーが発生しました。',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
    },
};