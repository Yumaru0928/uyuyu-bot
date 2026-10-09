const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('enable-auto-react-channel')
        .setDescription('実行したチャンネルのAuto-Reactを再有効化します')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const channel = interaction.channel;
        const guildId = interaction.guild.id;

        // 保存先JSONファイルのパス指定
        const filePath = path.join(__dirname, '..', '..', 'config-channels.json');

        // 1. JSONファイルを読み込み
        let channelsData = {};
        if (fs.existsSync(filePath)) {
            try {
                const rawData = fs.readFileSync(filePath, 'utf8');
                channelsData = JSON.parse(rawData);
            } catch (error) {
                console.error('JSON読み込みエラー:', error);
            }
        }

        const disabledChannels = channelsData[guildId]?.disableAutoReact;

        // 2. 無効化リストが存在しない、またはこのチャンネルが登録されていない場合のチェック
        if (!Array.isArray(disabledChannels) || !disabledChannels.includes(channel.id)) {
            return await interaction.reply({
                content: `${channel} は既に有効（無効化リストに含まれていません）です。`,
                flags: MessageFlags.Ephemeral
            });
        }

        // 3. 配列から現在のチャンネルIDを除外
        channelsData[guildId].disableAutoReact = disabledChannels.filter(id => id !== channel.id);

        try {
            // ① ローカルディスク（一時環境）へ保存
            fs.writeFileSync(filePath, JSON.stringify(channelsData, null, 4), 'utf8');

            // ② ユーザーへ返信
            await interaction.reply({
                content: `このチャンネル (${channel}) のAuto-Reactを再有効化しました！`,
                flags: MessageFlags.Ephemeral
            });

            // ③ GitHub APIを使って自動コミット
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