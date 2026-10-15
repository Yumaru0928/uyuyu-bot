// web.js
const express = require('express');
const { client } = require('./index.js');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('node:path');
const fs = require('node:fs');
const createRemember = require('./remember.js');

const app = express();

// Render などのリバースプロキシ配下で、HTTPS・Cookie を正しく扱うために必要
app.set('trust proxy', 1);

// 1. セッション設定
app.use(session({
    secret: process.env.SESSION_SECRET || 'uyuyu_session_secret',
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
//    ★修正点: done の引数は (エラー, ユーザー)。以前は done(obj, null) と逆で、
//    ログイン済みセッションを持つリクエストが全て Internal Server Error になっていた。
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// 4. Discord Strategy の設定
//    ★修正点: オプション名は scopes ではなく scope。
//    また CLIENT_ID / CLIENT_SECRET が未設定だと Strategy 生成時に例外で落ちるため、
//    未設定ならログインだけ無効にして Bot とサイトは動かし続ける。
const discordAuthEnabled = Boolean(process.env.CLIENT_ID && process.env.CLIENT_SECRET);

// ログイン状態の保持（トークンを暗号化した httpOnly Cookie に保存）。詳細は remember.js
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
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        // トークンはセッションと保持用 Cookie に使う。画面（テンプレート）には渡さない
        return done(null, { ...profile, auth: { accessToken, refreshToken } });
    }));

    if (!remember.enabled) {
        console.warn('[Web] SESSION_SECRET が未設定のため、ログイン状態の保持（Cookie保存）を無効にしています。');
    }
} else {
    console.warn('[Web] CLIENT_ID または CLIENT_SECRET が未設定のため、Discordログインを無効にしています。');
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ビューエンジンの設定（EJS）
app.set('view engine', 'ejs');
// テンプレートは public の外に置く（public は静的配信されるため、.ejs が生のまま見えてしまう）
app.set('views', path.join(__dirname, 'views'));

// 管理者権限（Administrator = 0x8）かどうか
// permissions は数値・文字列どちらで来ても扱えるよう BigInt で判定する
const ADMINISTRATOR = 0x8n;
function isAdmin(guild) {
    try {
        return (BigInt(guild.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
    } catch {
        return false;
    }
}

// ログインが無効な場合のガード
function requireAuthEnabled(req, res, next) {
    if (!discordAuthEnabled) {
        return res.status(503).send('現在ログイン機能は利用できません。');
    }
    next();
}

// 5. 認証ルート
//    保存済みのログイン情報があれば、Discord の画面を経由せずそのままダッシュボードへ進む。
//    アカウントを切り替えたいとき用に ?force=1 を付けると、毎回 Discord の認証へ進む。
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

// ログアウト。保存した Cookie の削除と、Discord 側の認可の取り消しも行う。
// 外部サイトから勝手に実行されないよう POST のみ受け付ける。
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

    // req.user.guilds が undefined の場合にクラッシュしないよう安全に保護
    const userGuilds = req.user.guilds || [];
    
    // 1. ユーザーが管理者権限（Administrator = 0x8）を持っているサーバーを抽出
    const adminGuilds = userGuilds.filter(isAdmin);

    // 2. Express アプリから client インスタンスを取得
    const client = req.app.get('client');

    // client がまだ準備できていない場合のガード
    if (!client || !client.guilds) {
        return res.render('dashboard', { user: req.user, guilds: [], guildId: null });
    }

    // 3. Botが加入しているサーバーのIDリストを取得
    const botGuildIds = client.guilds.cache.map(guild => guild.id);

    // 4. 「管理者権限がある」かつ「Botが加入している」サーバーに絞り込む
    const guilds = adminGuilds.filter(guild => botGuildIds.includes(guild.id));

    res.render('dashboard', { user: req.user, guilds, guildId: null });
});
// 7. 個別サーバーの設定画面 (GET)
app.get('/dashboard/:guildId', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }
    const guildId = req.params.guildId;
    const userGuilds = req.user.guilds || [];

    // 1. ユーザーが管理者権限を持っているサーバーを抽出
    const adminGuilds = userGuilds.filter(isAdmin);

    // 2. Express アプリから client インスタンスを取得
    const client = req.app.get('client');
    const botGuildIds = client && client.guilds ? client.guilds.cache.map(guild => guild.id) : [];

    // 3. 「管理者権限がある」かつ「Botが加入している」サーバーのみに絞り込む
    const guilds = adminGuilds.filter(guild => botGuildIds.includes(guild.id));

    // 4. 指定された guildId が、絞り込み後のリストに存在するかチェック
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) {
        return res.status(403).send('このサーバーを管理する権限がないか、Botが加入していません。');
    }

    // 設定ファイルから読み込み（壊れていても落ちないようにする）
    const filePath = path.join(__dirname, 'config-channels.json');
    let configData = {};
    try {
        if (fs.existsSync(filePath)) {
            configData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error('[Web] config-channels.json の読み込みに失敗しました:', error);
    }

    const guildConfig = configData[guildId] || {};

    // 5. ボットの client からそのサーバーのテキストチャンネル一覧を取得する（セレクトボックス等で選択させたい場合）
    const targetGuildObj = client ? client.guilds.cache.get(guildId) : null;
    const channels = targetGuildObj ? Array.from(targetGuildObj.channels.cache.values()).filter(c => c.type === 0) : [];

    res.render('guild', { 
        user: req.user, 
        guilds, 
        guild, 
        guildId, 
        guildConfig, 
        channels,
        query: req.query // 保存完了メッセージなどの判定用
    });
});

// ★【新規追加】個別サーバーの設定保存処理 (POST)
app.post('/dashboard/:guildId', remember.restoreLogin, async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }
    const guildId = req.params.guildId;
    const userGuilds = req.user.guilds || [];

    // 権限チェック（GETと同様に安全性を担保）
    const adminGuilds = userGuilds.filter(isAdmin);
    const client = req.app.get('client');
    const botGuildIds = client && client.guilds ? client.guilds.cache.map(guild => guild.id) : [];
    const guilds = adminGuilds.filter(guild => botGuildIds.includes(guild.id));
    const guild = guilds.find(g => g.id === guildId);

    if (!guild) {
        return res.status(403).send('このサーバーを管理する権限がないか、Botが加入していません。');
    }

    // 設定できるのは、このサーバーのテキストチャンネルだけ（フォームを書き換えられても他のIDは受け付けない）
    const targetGuildObj = client.guilds.cache.get(guildId);
    const channelIds = new Set(
        targetGuildObj
            ? Array.from(targetGuildObj.channels.cache.values()).filter(c => c.type === 0).map(c => c.id)
            : []
    );

    // フォームの値を取り出す。チェックボックスは 0件→undefined / 1件→文字列 / 複数→配列 で届く
    const toArray = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(String);
    const deleteLogChannel = String(req.body.deleteLogChannel || '');
    const reactOn = new Set(toArray(req.body.autoReact));

    if (deleteLogChannel && !channelIds.has(deleteLogChannel)) {
        return res.status(400).send('削除ログの送信先に指定できないチャンネルです。');
    }

    const filePath = path.join(__dirname, 'config-channels.json');
    let configData = {};
    try {
        if (fs.existsSync(filePath)) {
            configData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error('[Web] config-channels.json の読み込みに失敗しました:', error);
    }

    // データの更新
    if (!configData[guildId]) {
        configData[guildId] = {};
    }
    const guildConfig = configData[guildId];

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

    // ファイルへ書き込み（コマンド側の保存と同じ字下げ4）
    try {
        fs.writeFileSync(filePath, JSON.stringify(configData, null, 4), 'utf8');
    } catch (error) {
        console.error('[Web] config-channels.json の保存に失敗しました:', error);
        return res.status(500).send('設定の保存に失敗しました。');
    }

    // 保存完了後にクエリ付きでリダイレクト（画面に「保存しました」と表示するため）
    res.redirect(`/dashboard/${guildId}?saved=true`);

    // Render は再起動で設定ファイルが消えるため、コマンド側と同じく GitHub の data ブランチにも反映する
    // （通信に数秒かかるので、画面への応答を先に返してから行う）
    if (client.commitJsonToGitHub) {
        try {
            await client.commitJsonToGitHub(
                'config-channels.json',
                configData,
                `auto: update settings from dashboard in guild ${guildId} [skip render]`
            );
        } catch (error) {
            console.error('[Web] GitHubへの設定の反映に失敗しました:', error);
        }
    }
});

// 8. エラーハンドラ（原因を Render のログに残し、画面には詳細を出さない）
app.use((err, req, res, next) => {
    console.error('[Web Error]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(500).send('Internal Server Error');
});

module.exports = app;
