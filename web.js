// web.js
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { ChannelType } = require('discord.js');
const createRemember = require('./remember.js');
const { getChannelConfig, updateChannelConfig, ensureGuildConfig } = require('./channel-config.js');

const app = express();

// Render などのリバースプロキシ配下で、HTTPS・Cookie を正しく扱うために必要
app.set('trust proxy', 1);

// 1. セッション設定
//    SESSION_SECRET が無いときに、ソースに書かれた固定値（誰でも知っている値）で署名しないよう、
//    起動ごとのランダム値を使う（再起動でログイン中のセッションは無効になる）。
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('[Web] SESSION_SECRET が未設定です。起動ごとのランダムな値を使います（再起動でログインが解除されます）。');
}

app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7日
    }
}));

// 2. Passport の初期化（必ずセッション設定の後に行う）
app.use(passport.initialize());
app.use(passport.session());

// 3. ユーザーのシリアライズ・デシリアライズ
//    done の引数は (エラー, ユーザー)。
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// 4. Discord Strategy の設定
//    オプション名は scopes ではなく scope。
//    CLIENT_ID / CLIENT_SECRET が未設定だと Strategy 生成時に例外で落ちるため、
//    未設定ならログインだけ無効にして Bot とサイトは動かし続ける。
const discordAuthEnabled = Boolean(process.env.CLIENT_ID && process.env.CLIENT_SECRET);

// ログイン状態の保持（トークンを暗号化した httpOnly Cookie に保存）
const remember = createRemember({
    secret: process.env.SESSION_SECRET,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    isProd: process.env.NODE_ENV === 'production'
});

if (discordAuthEnabled) {
    passport.use(new DiscordStrategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
        scope: ['identify', 'guilds'],
        state: true // 他人が用意した認可コードでログインさせられる攻撃（ログインCSRF）の対策
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, { ...profile, auth: { accessToken, refreshToken } });
    }));

    if (!remember.enabled) {
        console.warn('[Web] SESSION_SECRET が未設定のため、ログイン状態の保持（Cookie保存）を無効にしています。');
    }
} else {
    console.warn('[Web] CLIENT_ID または CLIENT_SECRET が未設定のため、Discordログインを無効にしています。');
}

app.use(express.urlencoded({ extended: true }));

// 他のサイトから送られた POST（フォームの自動送信など）は受け付けない。
// ブラウザが付ける Sec-Fetch-Site で判定する（付かない古いブラウザは、SameSite=Lax の Cookie が守る）
app.use((req, res, next) => {
    if (req.method === 'POST' && req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).send('不正なリクエストです。');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ビューエンジンの設定（EJS）
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 設定を変えられる権限: 管理者（Administrator）または「チャンネルの管理」。
// Bot の設定コマンド（/set-delete-log-channel など）の必要権限（チャンネルの管理）と揃えてある。
// permissions は数値・文字列どちらで来ても扱えるよう BigInt で判定する
const ADMINISTRATOR = 0x8n;
const MANAGE_CHANNELS = 0x10n;
function canManage(guild) {
    try {
        const permissions = BigInt(guild.permissions);
        return (permissions & (ADMINISTRATOR | MANAGE_CHANNELS)) !== 0n;
    } catch {
        return false;
    }
}

// 「設定を変えられる権限がある」かつ「Botが加入している」サーバーの一覧
function manageableGuilds(req) {
    const client = req.app.get('client');
    if (!client || !client.guilds) return [];
    const userGuilds = (req.user && req.user.guilds) || [];
    return userGuilds.filter(guild => canManage(guild) && client.guilds.cache.has(guild.id));
}

// そのサーバーのテキストチャンネルを、Discord での並び順（カテゴリ → 位置）で返す
function textChannelsOf(client, guildId) {
    const guild = client && client.guilds ? client.guilds.cache.get(guildId) : null;
    if (!guild) return [];
    const order = channel => [channel.parent ? channel.parent.rawPosition : -1, channel.rawPosition];
    return Array.from(guild.channels.cache.values())
        .filter(channel => channel.type === ChannelType.GuildText)
        .sort((a, b) => {
            const [ap, ac] = order(a);
            const [bp, bc] = order(b);
            return ap - bp || ac - bc;
        });
}

// ハニーポットで選べる処罰（/honeypot コマンド・honeypotEvent.js と揃える）
const HONEYPOT_PUNISHMENTS = ['kick', 'ban', 'timeout'];

// ログインが無効な場合のガード
function requireAuthEnabled(req, res, next) {
    if (!discordAuthEnabled) {
        return res.status(503).send('現在ログイン機能は利用できません。');
    }
    next();
}

// 5. 認証ルート
const isForced = req => req.query.force === '1';

app.get('/auth/discord',
    requireAuthEnabled,
    (req, res, next) => (isForced(req) ? next() : remember.restoreLogin(req, res, next)),
    (req, res, next) => (!isForced(req) && req.isAuthenticated() ? res.redirect('/dashboard') : next()),
    passport.authenticate('discord', { scope: ['identify', 'guilds'] })
);

app.get('/auth/discord/callback',
    requireAuthEnabled,
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        remember.set(res, req.user && req.user.auth);
        res.redirect('/dashboard');
    }
);

// ログアウト
app.post('/logout', async (req, res, next) => {
    const tokens = (req.user && req.user.auth) || remember.read(req);
    remember.clear(res);
    await remember.revoke(tokens);

    req.logout(err => {
        if (err) return next(err);
        req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.redirect('/');
        });
    });
});

// 6. ダッシュボード（管理できるサーバー一覧画面）
app.get('/dashboard', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
        return res.redirect('/auth/discord');
    }
    res.render('dashboard', { user: req.user, guilds: manageableGuilds(req), guildId: null });
});

// 7. 個別サーバーの設定画面 (GET)
app.get('/dashboard/:guildId', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }
    const guildId = req.params.guildId;
    const guilds = manageableGuilds(req);

    // 指定された guildId が、権限のあるサーバーの中に存在するかチェック
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) {
        return res.status(403).send('このサーバーを管理する権限がないか、Botが加入していません。');
    }

    res.render('guild', {
        user: req.user,
        guilds,
        guild,
        guildId,
        guildConfig: getChannelConfig()[guildId] || {},
        channels: textChannelsOf(req.app.get('client'), guildId),
        query: req.query // 保存完了メッセージなどの判定用
    });
});

// 個別サーバーの設定保存処理 (POST)
app.post('/dashboard/:guildId', remember.restoreLogin, async (req, res, next) => {
    try {
        if (!req.isAuthenticated()) {
            return res.redirect('/auth/discord');
        }
        const guildId = req.params.guildId;

        // 権限チェック（GETと同様に安全性を担保）
        if (!manageableGuilds(req).some(g => g.id === guildId)) {
            return res.status(403).send('このサーバーを管理する権限がないか、Botが加入していません。');
        }

        // 設定できるのは、このサーバーのテキストチャンネルだけ（フォームを書き換えられても他のIDは受け付けない）
        const client = req.app.get('client');
        const channelIds = new Set(textChannelsOf(client, guildId).map(c => c.id));

        // フォームの値を取り出す。チェックボックスは 0件→undefined / 1件→文字列 / 複数→配列 で届く
        const toArray = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String);
        const deleteLogChannel = String(req.body.deleteLogChannel || '');
        const reactOn = new Set(toArray(req.body.autoReact));

        if (deleteLogChannel && !channelIds.has(deleteLogChannel)) {
            return res.status(400).send('削除ログの送信先に指定できないチャンネルです。');
        }

        // ハニーポット設定。チェックボックスは未チェックだと項目ごと届かないので「'1' かどうか」で判定する
        const honeypotChannel = String(req.body.honeypotChannel || '');
        const honeypotLogChannel = String(req.body.honeypotLogChannel || '');
        const honeypotPunishment = String(req.body.honeypotPunishment || 'kick');
        const honeypotAutoDelete = req.body.honeypotAutoDelete === '1';

        if (honeypotChannel && !channelIds.has(honeypotChannel)) {
            return res.status(400).send('ハニーポットに指定できないチャンネルです。');
        }
        if (honeypotLogChannel && !channelIds.has(honeypotLogChannel)) {
            return res.status(400).send('ハニーポットのログの送信先に指定できないチャンネルです。');
        }
        if (!HONEYPOT_PUNISHMENTS.includes(honeypotPunishment)) {
            return res.status(400).send('ハニーポットの処罰が正しくありません。');
        }
        let honeypotSettings = null;

        let configData;
        try {
            configData = updateChannelConfig(data => {
                const guildConfig = ensureGuildConfig(data, guildId);

                // 削除ログの送信先（空なら設定を消す）
                if (deleteLogChannel) {
                    guildConfig.deleteLogChannel = deleteLogChannel;
                } else {
                    delete guildConfig.deleteLogChannel;
                }

                // Auto-React を無効にするチャンネル = 「画面に出ていてオフにされたもの」
                // 画面に出ていない（削除済みなど）既存のIDは、そのまま残す
                const previouslyDisabled = Array.isArray(guildConfig.disableAutoReact) ? guildConfig.disableAutoReact : [];
                const keptHidden = previouslyDisabled.filter(id => !channelIds.has(id));
                const nowDisabled = Array.from(channelIds).filter(id => !reactOn.has(id));
                guildConfig.disableAutoReact = [...keptHidden, ...nowDisabled];

                // ハニーポット（/honeypot コマンドと同じ guildConfig.honeypot に保存する）
                guildConfig.honeypot = {
                    ...guildConfig.honeypot,
                    honeypotChannel: honeypotChannel || null,
                    punishment: honeypotPunishment,
                    autoDelete: honeypotAutoDelete,
                    logChannel: honeypotLogChannel || null,
                };
                honeypotSettings = { ...guildConfig.honeypot };
            });
        } catch (error) {
            console.error('[Web] config-channels.json の保存に失敗しました:', error);
            return res.status(500).send('設定の保存に失敗しました。');
        }

        // ハニーポットのイベント側が持っているキャッシュを、保存した内容で即座に更新する
        if (client && honeypotSettings) {
            client.honeypotCache ??= new Map();
            client.honeypotCache.set(guildId, honeypotSettings);
        }

        // 保存完了後にクエリ付きでリダイレクト（画面に「保存しました」と表示するため）
        res.redirect(`/dashboard/${guildId}?saved=true`);

        // Render は再起動で設定ファイルが消えるため、コマンド側と同じく GitHub の data ブランチにも反映する
        // （通信に数秒かかるので、画面への応答を先に返してから行う）
        if (client && client.commitJsonToGitHub) {
            await client.commitJsonToGitHub(
                'config-channels.json',
                configData,
                `auto: update settings from dashboard in guild ${guildId} [skip render]`
            );
        }
    } catch (error) {
        next(error);
    }
});

// 8. エラーハンドラ
app.use((err, req, res, next) => {
    console.error('[Web Error]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(500).send('Internal Server Error');
});

module.exports = app;