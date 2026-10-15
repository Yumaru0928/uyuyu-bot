// console-forward.js
// console.log / console.warn / console.error の出力を、通常のコンソール(Renderのログ)に出したまま、
// Discordの指定チャンネルにも送るためのモジュール。
//
// 使い方(index.js):
//   const consoleForward = require('./console-forward.js');
//   consoleForward.install();                 // できるだけ最初に呼ぶ。以降は全ファイルの console が対象になる
//   consoleForward.attach(client, channelId); // client を作ったあとに呼ぶ
//
// 送るログには、次の情報を付ける(IDはDiscordのURLに変換する)。
//   📄 console を呼んだファイルと行(GitHubの該当行へのリンク)
//   🏠 💬 👤 🔗 そのとき処理していたイベントのサーバー・チャンネル・ユーザー・メッセージ
//   ⚙️ 実行中のコマンド名とイベント名
//   ログの文章に含まれていたID(キャッシュで見つかったサーバー・チャンネル・ユーザー)
//
// 仕組み
// ・console はグローバルなので、events / commands など、どのファイルから呼ばれたログも対象になる
// ・呼び出し元は、console が呼ばれた時点のスタックトレースから特定する
// ・どのサーバー・チャンネルの処理中かは、client.emit を包んで、イベントごとに AsyncLocalStorage へ記録して知る。
//   await をはさんだ後や、タイマー・コレクターのコールバックの中のログにも引き継がれる
// ・Bot がログインするまでの出力は溜めておき、ログイン後にまとめて送る
// ・連投で Discord のレート制限に当たらないよう、2秒ごとにまとめて送る(1メッセージに最大10件の埋め込み)
// ・トークンなどの秘密情報は *** に置き換える
// ・転送の失敗でBot本来の処理は止めない。失敗は元の console.error に出すだけで、再び転送はしない(無限ループ防止)
const util = require('node:util');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { AsyncLocalStorage } = require('node:async_hooks');

const FLUSH_INTERVAL_MS = 2000;   // まとめて送る間隔
const MAX_QUEUE = 200;            // 送信待ちの上限。超えたら古いものから捨てる
const MAX_ENTRY_LENGTH = 1500;    // 1回の console 出力で送る最大文字数
const MAX_EMBEDS_PER_MESSAGE = 10;   // Discordの上限
const MAX_EMBED_CHARS_PER_MESSAGE = 5500; // Discordの上限(6000文字)から余裕を引いた値
const MAX_LINKED_IDS = 6;         // ログの文章から拾ってリンクにするIDの最大数

const STYLES = {
    log: { title: 'ℹ️ LOG', color: 0x99aab5 },
    warn: { title: '⚠️ WARN', color: 0xfee75c },
    error: { title: '🚨 ERROR', color: 0xed4245 }
};

// 値を伏せる環境変数
const SECRET_ENV_NAMES = ['DISCORD_TOKEN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'CLIENT_SECRET', 'SESSION_SECRET'];
// 値が環境変数に無くても、形で見分けて伏せるもの
const SECRET_PATTERNS = [
    /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,}/g, // Discord Bot トークン
    /gh[pousr]_[A-Za-z0-9]{20,}/g,           // GitHub トークン
    /AIza[0-9A-Za-z_-]{30,}/g,               // Google API キー
    /Bearer\s+[\w.~+\/-]+=*/gi               // Authorization ヘッダー
];

const originals = {};   // 差し替える前の console.log / warn / error
const queue = [];       // 送信待ち
const contextStorage = new AsyncLocalStorage(); // いま処理しているイベントの情報
let dropped = 0;        // 上限を超えて捨てた件数
let installed = false;
let client = null;
let channelId = null;
let channel = null;
let timer = null;
let flushing = false;
let channelErrorShown = false;
let settings = {
    rootDir: __dirname,
    repo: process.env.GITHUB_REPO || 'Yumaru0928/uyuyu-bot',
    ref: process.env.RENDER_GIT_COMMIT || 'main' // Renderが入れるデプロイ中のコミット。あればその時点のコードの行を指せる
};

// ---------- 文字の整形 ----------
function redact(text) {
    let result = text;
    for (const name of SECRET_ENV_NAMES) {
        const value = process.env[name];
        if (value && value.length >= 8) result = result.split(value).join('***');
    }
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, '***');
    }
    return result;
}

function toText(args) {
    let text;
    try {
        text = util.format(...args); // Error はスタックトレースつきの文字になる。循環参照があっても落ちない
    } catch {
        text = '(表示できない値)';
    }
    text = redact(text).replace(/```/g, '`​``'); // コードブロックを壊さないようにする
    if (text.length > MAX_ENTRY_LENGTH) {
        text = `${text.slice(0, MAX_ENTRY_LENGTH)}…(あと${text.length - MAX_ENTRY_LENGTH}文字省略)`;
    }
    return text;
}

// リンクの文字に使えるよう、Markdownの記号を取り除く。
// サーバー名などは誰でも決められるので、本物のURLに見える文字(http://)も取り除いておく
function safeName(name) {
    const cleaned = String(name ?? '').replace(/https?:\/\//gi, '').replace(/[\[\]()<>`*_~|\\]/g, '').trim();
    return cleaned.slice(0, 40) || '名前なし';
}

// ---------- 呼び出し元の特定 ----------
// いま実行中のスタックから、このモジュールとNode内部を除いた最初の行を探す
function findCallSite() {
    const lines = String(new Error().stack).split('\n').slice(1);
    for (const line of lines) {
        const match = line.trim().match(/\(?([^()\s]+):(\d+):\d+\)?$/);
        if (!match) continue;
        let file = match[1];
        if (file.startsWith('node:') || file.includes('node:internal')) continue;
        if (file.startsWith('file://')) {
            try { file = fileURLToPath(file); } catch { continue; }
        }
        if (file === __filename) continue;
        return describeSite(file, Number(match[2]));
    }
    return null;
}

function describeSite(file, line) {
    const relative = path.relative(settings.rootDir, file).split(path.sep).join('/');
    const outside = relative.startsWith('..') || path.isAbsolute(relative);
    const label = `${outside ? file : relative}:${line}`;
    // GitHubに無いファイル(ライブラリの中や、プロジェクトの外)はリンクにしない
    const linkable = !outside && !relative.startsWith('node_modules/');
    const url = linkable
        ? `https://github.com/${settings.repo}/blob/${settings.ref}/${relative}#L${line}`
        : null;
    return { label, url };
}

// ---------- 処理中のイベントの特定 ----------
// イベントの最初の引数(Message / Interaction / GuildMember など)から、サーバー・チャンネル・ユーザーなどを取り出す
function contextFrom(eventName, args) {
    const a = args[0];
    if (!a || typeof a !== 'object') return null;

    const ctx = { event: eventName };
    ctx.guildId = a.guildId ?? a.guild?.id ?? null;
    ctx.channelId = a.channelId ?? a.channel?.id ?? null;
    ctx.userId = a.user?.id ?? a.author?.id ?? null;

    if (a.constructor && a.constructor.name === 'Guild') ctx.guildId = a.id;               // guildCreate など
    if (!ctx.channelId && typeof a.isTextBased === 'function') ctx.channelId = a.id;        // channelCreate など
    if (typeof a.commandName === 'string') ctx.command = a.commandName;                    // スラッシュコマンド
    if ('author' in a && a.id) ctx.messageId = a.id;                                        // メッセージ(Interactionのidと区別する)

    const hasInfo = ctx.guildId || ctx.channelId || ctx.userId || ctx.command;
    return hasInfo ? ctx : null;
}

// client.emit を包み、イベントを処理している間じゅう(await のあとも)その情報を引き継げるようにする
function wrapEmit(target) {
    if (target.__consoleForwardWrapped) return;
    target.__consoleForwardWrapped = true;

    const originalEmit = target.emit.bind(target);
    target.emit = (eventName, ...args) => {
        // 聞いている人がいないイベント(debug や raw など)は、何もせずそのまま流す
        if (typeof eventName !== 'string' || args.length === 0 || target.listenerCount(eventName) === 0) {
            return originalEmit(eventName, ...args);
        }
        let ctx = null;
        try {
            ctx = contextFrom(eventName, args);
        } catch {
            // 取り出せなくても、イベントの処理自体は通常どおり行う
        }
        return ctx
            ? contextStorage.run(ctx, () => originalEmit(eventName, ...args))
            : originalEmit(eventName, ...args);
    };
}

// ---------- IDをURLに変換 ----------
const guildItem = (id) => {
    const guild = client.guilds?.cache?.get(id);
    return { icon: '🏠', label: 'サーバー', name: guild ? safeName(guild.name) : id, url: `https://discord.com/channels/${id}` };
};

const channelItem = (id, guildId) => {
    const ch = client.channels?.cache?.get(id);
    const where = ch?.guildId ?? guildId ?? '@me'; // DMのチャンネルは @me
    const name = ch ? (ch.name ? `#${safeName(ch.name)}` : 'DM') : id;
    return { icon: '💬', label: 'チャンネル', name, url: `https://discord.com/channels/${where}/${id}` };
};

const userItem = (id) => {
    const user = client.users?.cache?.get(id);
    return { icon: '👤', label: 'ユーザー', name: user ? safeName(user.globalName || user.username) : id, url: `https://discord.com/users/${id}` };
};

// 1件のログに付ける説明(場所・サーバー・チャンネル・ユーザーなど)を、Markdownの行にする
function detailLines(entry) {
    const lines = [];
    if (entry.site) {
        lines.push(entry.site.url ? `📄 [${entry.site.label}](${entry.site.url})` : `📄 \`${entry.site.label}\``);
    }

    const items = new Map();
    const add = (key, item) => { if (!items.has(key)) items.set(key, item); };
    const ctx = entry.ctx;
    if (ctx) {
        if (ctx.guildId) add(`guild:${ctx.guildId}`, guildItem(ctx.guildId));
        if (ctx.channelId) add(`channel:${ctx.channelId}`, channelItem(ctx.channelId, ctx.guildId));
        if (ctx.userId) add(`user:${ctx.userId}`, userItem(ctx.userId));
        if (ctx.messageId && ctx.channelId) {
            add(`message:${ctx.messageId}`, {
                icon: '🔗', label: 'メッセージ', name: '開く',
                url: `https://discord.com/channels/${ctx.guildId ?? '@me'}/${ctx.channelId}/${ctx.messageId}`
            });
        }
    }
    // ログの文章に含まれていたID。サーバー・チャンネル・ユーザーとして見つかったものだけをリンクにする
    for (const id of entry.ids) {
        if (client.guilds?.cache?.has(id)) add(`guild:${id}`, guildItem(id));
        else if (client.channels?.cache?.has(id)) add(`channel:${id}`, channelItem(id, null));
        else if (client.users?.cache?.has(id)) add(`user:${id}`, userItem(id));
    }
    for (const item of items.values()) {
        lines.push(`${item.icon} ${item.label}: [${item.name}](${item.url})`);
    }

    if (ctx && (ctx.command || ctx.event)) {
        const parts = [];
        if (ctx.command) parts.push(`コマンド: \`/${ctx.command}\``);
        if (ctx.event) parts.push(`イベント: \`${ctx.event}\``);
        lines.push(`⚙️ ${parts.join(' ・ ')}`);
    }
    return lines;
}

function buildEmbed(entry) {
    const style = STYLES[entry.level];
    let description = `\`\`\`\n${entry.text}\n\`\`\``;
    const lines = detailLines(entry);
    if (lines.length > 0) description += `\n${lines.join('\n')}`;
    return {
        title: style.title,
        description: description.slice(0, 4000),
        color: style.color,
        timestamp: new Date(entry.time).toISOString()
    };
}

// ---------- 溜める・送る ----------
function enqueue(level, args, site) {
    // 転送先がまだ決まっていなくても(attach より前の起動直後のログ)溜めておく。上限があるので溜まりすぎない
    const text = toText(args);
    if (!text.trim()) return;
    if (queue.length >= MAX_QUEUE) {
        queue.shift();
        dropped++;
    }
    const ids = [...new Set(text.match(/\b\d{17,20}\b/g) || [])].slice(0, MAX_LINKED_IDS);
    queue.push({ level, text, time: Date.now(), site, ctx: contextStorage.getStore() || null, ids });
}

// 埋め込みを、1メッセージに収まる数と大きさごとにまとめる
function groupEmbeds(embeds) {
    const groups = [];
    let current = [];
    let size = 0;
    for (const embed of embeds) {
        const length = embed.title.length + embed.description.length;
        if (current.length > 0 && (current.length >= MAX_EMBEDS_PER_MESSAGE || size + length > MAX_EMBED_CHARS_PER_MESSAGE)) {
            groups.push(current);
            current = [];
            size = 0;
        }
        current.push(embed);
        size += length;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

async function getChannel() {
    if (channel) return channel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched && typeof fetched.send === 'function') {
            channel = fetched;
            return channel;
        }
        throw new Error('テキストチャンネルではありません');
    } catch (error) {
        if (!channelErrorShown) {
            channelErrorShown = true;
            originals.error('[console-forward] ログ用チャンネルを取得できません。次回また試します:', error.message);
        }
        return null;
    }
}

async function flush() {
    if (flushing || !client || !client.isReady() || queue.length === 0) return;
    flushing = true;
    try {
        const target = await getChannel();
        if (!target) return; // 取得できない間は溜めておく(上限を超えたら古いものから捨てる)

        const entries = queue.splice(0);
        const note = dropped > 0 ? `(… ${dropped}件のログは多すぎたため省略しました)` : null;
        dropped = 0;

        const embeds = [];
        for (const entry of entries) {
            try {
                embeds.push(buildEmbed(entry));
            } catch (error) {
                originals.error('[console-forward] 埋め込みを作れませんでした:', error.message);
            }
        }

        const groups = groupEmbeds(embeds);
        for (let i = 0; i < groups.length; i++) {
            try {
                await target.send({
                    ...(i === 0 && note ? { content: note } : {}),
                    embeds: groups[i],
                    allowedMentions: { parse: [] } // ログに含まれる @ で誰かに通知が飛ばないようにする
                });
            } catch (error) {
                // 転送側のエラーを console.error に出すと自分自身に戻ってくるため、元の関数に出す
                originals.error('[console-forward] ログの送信に失敗しました:', error.message);
            }
        }
    } finally {
        flushing = false;
    }
}

// ---------- 公開する関数 ----------
// console.log / warn / error を差し替える。何度呼んでも1回だけ
function install() {
    if (installed) return;
    installed = true;
    for (const level of Object.keys(STYLES)) {
        const original = console[level].bind(console);
        originals[level] = original;
        console[level] = (...args) => {
            original(...args); // いつもどおりコンソールにも出す
            try {
                enqueue(level, args, findCallSite());
            } catch {
                // 転送の準備で失敗しても、呼び出し元には影響させない
            }
        };
    }
}

// 転送先を設定し、定期的な送信を始める。Botがログインするまでの出力は、ログイン後に送られる
// options: { rootDir: プロジェクトの場所, repo: 'ユーザー名/リポジトリ名', ref: ブランチ名またはコミット }
function attach(discordClient, targetChannelId, options = {}) {
    install();
    settings = { ...settings, ...options };
    client = discordClient;
    channelId = targetChannelId;
    channel = null;
    channelErrorShown = false;
    wrapEmit(client);
    if (timer) clearInterval(timer);
    timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { install, attach, _flush: flush, _queue: queue };
