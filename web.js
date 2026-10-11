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
// 7. 個別サーバーの設定画面
app.get('/dashboard/:guildId', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }
    const guildId = req.params.guildId;
    const userGuilds = req.user.guilds || [];

    // ユーザーが本当にそのサーバーの管理者かチェック
    const guilds = userGuilds.filter(isAdmin);
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) {
        return res.status(403).send('このサーバーを管理する権限がありません。');
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

    // ★修正点: 以前は dashboard.ejs（guilds 変数が必須）を流用していたため、
    //   guilds が未定義で ReferenceError → 500 になっていた。専用テンプレート guild.ejs を使う。
    res.render('guild', { user: req.user, guilds, guild, guildId, guildConfig });
});

// 8. エラーハンドラ（原因を Render のログに残し、画面には詳細を出さない）
app.use((err, req, res, next) => {
    console.error('[Web Error]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(500).send('Internal Server Error');
});

module.exports = app;
