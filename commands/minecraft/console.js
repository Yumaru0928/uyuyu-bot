const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getState, requestCommand } = require('../../utils/agent-bridge');

// 使える人：環境変数 CONSOLE_ADMIN_IDS に、DiscordユーザーIDをカンマ区切りで指定
//   例) CONSOLE_ADMIN_IDS=123456789012345678,234567890123456789
const adminIds = () =>
    (process.env.CONSOLE_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const MAX_OUTPUT = 1800; // Discordの1メッセージ上限（2000文字）に収める

module.exports = {
    data: new SlashCommandBuilder()
        .setName('console')
        .setDescription('マイクラサーバーのコンソールにコマンドを送ります（管理者のみ）')
        .addStringOption((option) =>
            option.setName('command')
                .setDescription('実行するコマンド（先頭の / は不要）')
                .setMaxLength(1000)
                .setRequired(true)),

    async execute(interaction) {
        const uid = interaction.user.id;

        // 管理者本人かどうかだけを見る（サーバーのロール等は使わない）
        if (!adminIds().includes(uid)) {
            return interaction.reply({ content: 'このコマンドを使う権限がありません。', flags: MessageFlags.Ephemeral });
        }

        // 出力にはプレイヤー情報などが含まれうるので、本人にだけ見せる
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const command = interaction.options.getString('command').trim().replace(/^\/+/, '');
        if (!command) return interaction.editReply('コマンドが空です。');

        const state = getState();
        if (state === 'offline') return interaction.editReply('🔌 自宅PCがオフライン（または常駐スクリプトが未起動）です。');
        if (state !== 'running') return interaction.editReply('サーバーが起動していません。先に `/start` で起動してください。');

        try {
            console.log(`[Console] ${interaction.user.tag} (${uid}) が実行: ${command}`);
            const r = await requestCommand(command);
            if (!r.ok) return interaction.editReply(`⚠️ ${r.message || '実行に失敗しました。'}`);

            let out = r.output || '（出力なし）';
            if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '\n…（省略）';
            // コードブロックを壊さないよう、``` は無害化する
            out = out.replace(/```/g, "'''");
            return interaction.editReply(`✅ \`${command}\`\n\`\`\`\n${out}\n\`\`\``);
        } catch (error) {
            console.error('[Console] エラー:', error);
            return interaction.editReply('内部エラーが発生しました。');
        }
    },
};