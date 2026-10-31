const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isConfigured, getLinks } = require('../../utils/link-db');
const { getState, requestStart } = require('../../utils/agent-bridge');

const COOLDOWN_MS = 60_000;
const lastUsed = new Map(); // discordId -> 最後に起動を依頼した時刻

module.exports = {
    data: new SlashCommandBuilder()
        .setName('start')
        .setDescription('マイクラサーバーを起動します（アカウント紐づけ済みの人のみ）'),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!isConfigured()) {
            return interaction.editReply('連携用のデータベースが未設定です。管理者に連絡してください。');
        }

        const uid = interaction.user.id;
        try {
            // 1) 紐づけ確認（ここで弾けば、自宅PCには何も送らない）
            const links = await getLinks();
            const me = links[uid];
            if (!me) {
                return interaction.editReply('先にマイクラで一度サーバーに参加し、`/link` でアカウントを紐づけてください。');
            }

            // 2) 任意：特定ロールの人だけに制限（環境変数 START_ROLE_ID）
            const roleId = process.env.START_ROLE_ID;
            if (roleId && !interaction.member?.roles?.cache?.has(roleId)) {
                return interaction.editReply('このコマンドを使う権限がありません。');
            }

            // 3) クールダウン（連打防止）
            const wait = (lastUsed.get(uid) || 0) + COOLDOWN_MS - Date.now();
            if (wait > 0) {
                return interaction.editReply(`連打防止中です。あと ${Math.ceil(wait / 1000)} 秒お待ちください。`);
            }

            // 4) 状態確認
            const state = getState();
            if (state === 'offline') return interaction.editReply('🔌 自宅PCがオフライン（または常駐スクリプトが未起動）です。');
            if (state === 'running') return interaction.editReply('✅ すでに起動しています。');
            if (state === 'starting') return interaction.editReply('⏳ 起動処理中です。しばらくお待ちください。');

            // 5) 起動シグナルを送る
            lastUsed.set(uid, Date.now());
            const r = await requestStart();
            const text = {
                started: '🚀 起動を開始しました。1〜2分ほどお待ちください。',
                already_running: '✅ すでに起動しています。',
                already_starting: '⏳ 起動処理中です。しばらくお待ちください。',
                offline: '🔌 自宅PCがオフラインです。',
                timeout: '⚠️ 自宅PCから応答がありませんでした。',
                error: `⚠️ 起動に失敗しました。${r.message ? `（${r.message}）` : ''}`,
            }[r.result] ?? '⚠️ 想定外の応答でした。';
            await interaction.editReply(text);

            // 6) 起動ログ（任意：環境変数 MC_LOG_CHANNEL_ID のチャンネルへ）
            if (r.result === 'started') {
                console.log(`[Start] ${me.name} (${uid}) がマイクラサーバーを起動しました。`);
                if (process.env.MC_LOG_CHANNEL_ID) {
                    const ch = await interaction.client.channels.fetch(process.env.MC_LOG_CHANNEL_ID).catch(() => null);
                    ch?.send({ content: `🟢 <@${uid}>（${me.name}）がマイクラサーバーを起動しました。`, allowedMentions: { parse: [] } }).catch(() => {});
                }
            }
        } catch (error) {
            console.error('[Start] エラー:', error);
            return interaction.editReply('内部エラーが発生しました。');
        }
    },
};