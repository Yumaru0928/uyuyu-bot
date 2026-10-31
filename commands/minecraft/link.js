const crypto = require('node:crypto');
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isConfigured, updateJson, setLinksCache } = require('../../utils/link-db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 総当たり対策：失敗が続いたら一定時間ロック
const fails = new Map(); // discordId -> { count, resetAt }
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60_000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('マイクラのアカウントとDiscordを紐づけます')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('ゲーム内の /link genkey で発行されたキー')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!isConfigured()) {
            return interaction.editReply('連携用のデータベースが未設定です。管理者に連絡してください。');
        }

        const uid = interaction.user.id;
        const f = fails.get(uid);
        if (f && f.count >= MAX_FAILS && Date.now() < f.resetAt) {
            return interaction.editReply('失敗が続いたため、しばらく時間をおいてからもう一度お試しください。');
        }

        // 大文字化し、空白とハイフンを取り除く（「abcd-efgh」でも通す）
        const key = interaction.options.getString('key').trim().toUpperCase().replace(/[\s-]/g, '');
        const hash = sha256(key);

        try {
            // 1) キーを消費（使い捨て）。期限切れのキーもここで掃除する
            let entry = null;
            await updateJson('pending_keys.json', (pending) => {
                entry = null;
                let changed = false;
                const now = Date.now();
                for (const [h, e] of Object.entries(pending)) {
                    if (!e || e.expires < now) { delete pending[h]; changed = true; }
                }
                if (pending[hash]) {
                    entry = pending[hash];
                    delete pending[hash];
                    changed = true;
                }
                return changed ? pending : null;
            }, 'link: consume key');

            if (!entry) {
                const cur = fails.get(uid);
                const count = (cur && Date.now() < cur.resetAt ? cur.count : 0) + 1;
                fails.set(uid, { count, resetAt: Date.now() + LOCK_MS });
                return interaction.editReply('キーが無効か、期限切れです。ゲーム内で `/link genkey` をやり直してください。');
            }
            fails.delete(uid);

            // 2) 紐づけを保存（同じマイクラアカウントの古い紐づけは置き換える）
            const res = await updateJson('links.json', (links) => {
                for (const [id, v] of Object.entries(links)) {
                    if (v.uuid === entry.uuid && id !== uid) delete links[id];
                }
                links[uid] = { uuid: entry.uuid, name: entry.name, linkedAt: new Date().toISOString() };
                return links;
            }, `link: ${entry.name}`);
            setLinksCache(res.data);

            console.log(`[Link] ${entry.name} を Discord ユーザー ${uid} と紐づけました。`);
            return interaction.editReply(`✅ **${entry.name}** と紐づけました。\`/start\` でサーバーを起動できます。`);
        } catch (error) {
            console.error('[Link] エラー:', error);
            return interaction.editReply('内部エラーが発生しました。少し待ってからもう一度お試しください。');
        }
    },
};