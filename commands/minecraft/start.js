const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isConfigured, getLinks } = require('../../utils/link-db');
const { getState, requestStart } = require('../../utils/agent-bridge');
const { pingJava } = require('../../utils/mc-ping');

const COOLDOWN_MS = 60_000;
const lastUsed = new Map(); // discordId -> 最後に起動を依頼した時刻

// 接続先（環境変数で上書きも可能）
const JAVA_ADDRESS = process.env.MC_JAVA_ADDRESS || 'domination-env.tun.ply.gg';
const JAVA_PORT = Number(process.env.MC_JAVA_PORT || 25565); // アドレスにポートが付く場合は MC_JAVA_PORT で指定
const BE_ADDRESS = process.env.MC_BE_ADDRESS || 'indigooriole.wdn.gg';
const BE_PORT = process.env.MC_BE_PORT || '443';

// 起動完了の待機設定
const WAIT_TIMEOUT_MS = 8 * 60_000; // 最大8分待つ（インタラクションの有効期限15分以内）
const POLL_MS = 5_000;
const STOPPED_GRACE_MS = 20_000; // 起動直後は状態の反映が遅れるので、この間の「stopped」は無視する
const OFFLINE_GRACE_MS = 30_000; // 再接続による一瞬の切断は、この時間までは失敗扱いにしない

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const addressText = () =>
    [
        `**Java版**: \`${JAVA_ADDRESS}\``,
        `**統合版 (BE)**: \`${BE_ADDRESS}\` / ポート: \`${BE_PORT}\``,
    ].join('\n');

/**
 * エラーは本人にだけ見せる。
 * 最初の応答は全員に見える形で defer 済みなので、それを消してから Ephemeral で送り直す。
 */
async function replyError(interaction, content) {
    await interaction.deleteReply().catch(() => {});
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}

/**
 * 起動完了を待つ。
 *  1) 自宅PCが「running」（ローカルのポートが開いた）と報告するのを待つ
 *  2) Java版の公開アドレスに ping を送り、応答が返るのを待つ（= 外から入れる状態）
 * 'ready' | 'offline' | 'stopped' | 'tunnel_timeout' | 'timeout' を返す。
 */
async function waitUntilReady() {
    const startedAt = Date.now();
    let localRunning = false;
    let offlineSince = null;
    let stoppedPolls = 0;
    while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
        const s = getState();
        if (s === 'offline') {
            offlineSince ??= Date.now();
            if (Date.now() - offlineSince > OFFLINE_GRACE_MS) return 'offline';
            await sleep(POLL_MS);
            continue;
        }
        offlineSince = null;
        if (s === 'stopped' && Date.now() - startedAt > STOPPED_GRACE_MS) {
            if (++stoppedPolls >= 2) return 'stopped'; // 再接続直後の一瞬の「stopped」で誤判定しない（2回連続で確認）
        } else {
            stoppedPolls = 0;
        }
        if (s === 'running') {
            localRunning = true;
            const res = await pingJava(JAVA_ADDRESS, JAVA_PORT).catch(() => null);
            if (res) return 'ready';
        }
        await sleep(POLL_MS);
    }
    return localRunning ? 'tunnel_timeout' : 'timeout';
}

/** 起動完了を待って、Java版アドレスへのpingが返ったら接続先を（全員に見える形で）投稿する。 */
async function announceWhenReady(interaction) {
    const r = await waitUntilReady();
    const messages = {
        ready: `🟢 **サーバーが起動しました！**\n${addressText()}`,
        tunnel_timeout: `⚠️ サーバーは起動しましたが、\`${JAVA_ADDRESS}\` からの応答がありませんでした。トンネル（playit.gg）の状態を確認してください。`,
        timeout: '⚠️ 起動の完了を確認できませんでした。しばらくしてからもう一度お試しください。',
        offline: '🔌 起動中に自宅PCとの接続が切れました。',
        stopped: '⚠️ サーバーが起動せずに停止しました。管理者に連絡してください。',
    };
    await interaction.followUp({ content: messages[r] });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('start')
        .setDescription('マイクラサーバーを起動します（アカウント紐づけ済みの人のみ）'),

    async execute(interaction) {
        // 最初は全員に見える形で応答を予約する（エラー時だけ replyError で本人限定に切り替える）
        await interaction.deferReply();

        if (!isConfigured()) {
            return replyError(interaction, '連携用のデータベースが未設定です。管理者に連絡してください。');
        }

        const uid = interaction.user.id;
        try {
            // 1) 実行者本人の紐づけ確認（ロール等は見ない。ここで弾けば、自宅PCには何も送らない）
            const links = await getLinks();
            const me = links[uid];
            if (!me) {
                return replyError(interaction, '先にマイクラで一度サーバーに参加し、`/link` でアカウントを紐づけてください。');
            }

            // 2) クールダウン（連打防止）
            const wait = (lastUsed.get(uid) || 0) + COOLDOWN_MS - Date.now();
            if (wait > 0) {
                return replyError(interaction, `連打防止中です。あと ${Math.ceil(wait / 1000)} 秒お待ちください。`);
            }

            // 3) 状態確認
            const state = getState();
            if (state === 'offline') return replyError(interaction, '🔌 自宅PCがオフライン（または常駐スクリプトが未起動）です。');
            if (state === 'running') return interaction.editReply(`✅ すでに起動しています。\n${addressText()}`);
            if (state === 'starting') {
                await interaction.editReply('⏳ 起動処理中です。完了したらお知らせします。');
                announceWhenReady(interaction).catch((e) => console.error('[Start] 通知エラー:', e));
                return;
            }

            // 4) 起動シグナルを送る
            lastUsed.set(uid, Date.now());
            const r = await requestStart();

            if (r.result === 'already_running') {
                return interaction.editReply(`✅ すでに起動しています。\n${addressText()}`);
            }

            const errors = {
                offline: '🔌 自宅PCがオフラインです。',
                timeout: '⚠️ 自宅PCから応答がありませんでした。',
                error: `⚠️ 起動に失敗しました。${r.message ? `（${r.message}）` : ''}`,
            };
            if (errors[r.result]) return replyError(interaction, errors[r.result]);
            if (r.result !== 'started' && r.result !== 'already_starting') {
                return replyError(interaction, '⚠️ 想定外の応答でした。');
            }

            await interaction.editReply(
                r.result === 'started'
                    ? '🚀 起動を開始しました。完了したらお知らせします（1〜2分ほどかかります）。'
                    : '⏳ 起動処理中です。完了したらお知らせします。'
            );

            // 5) 起動完了を待って、接続先を投稿する（待っている間もBotは他の処理を続けられる）
            announceWhenReady(interaction).catch((e) => console.error('[Start] 通知エラー:', e));

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
            return replyError(interaction, '内部エラーが発生しました。').catch(() => {});
        }
    },
};