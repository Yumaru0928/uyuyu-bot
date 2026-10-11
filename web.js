// web.js
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('node:path');
const fs = require('node:fs');

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

if (discordAuthEnabled) {
    passport.use(new DiscordStrategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
    }));
} else {
    console.warn('[Web] CLIENT_ID または CLIENT_SECRET が未設定のため、Discordログインを無効にしています。');
}

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ビューエンジンの設定（EJS）
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));

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
app.get('/auth/discord', requireAuthEnabled, passport.authenticate('discord', {
    scope: ['identify', 'guilds']
}));

app.get('/auth/discord/callback',
    requireAuthEnabled,
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

// 6. ダッシュボード（管理できるサーバー一覧画面）
app.get('/dashboard', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }

    // req.user.guilds が undefined の場合にクラッシュしないよう安全に保護
    const userGuilds = req.user.guilds || [];
    const guilds = userGuilds.filter(isAdmin);

    res.render('dashboard', { user: req.user, guilds });
});

// 7. 個別サーバーの設定画面
app.get('/dashboard/:guildId', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/auth/discord');
    }
    const guildId = req.params.guildId;
    const userGuilds = req.user.guilds || [];

    // ユーザーが本当にそのサーバーの管理者かチェック
    const guild = userGuilds.find(g => g.id === guildId && isAdmin(g));
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
    res.render('guild', { user: req.user, guild, guildId, guildConfig });
});

// 8. エラーハンドラ（原因を Render のログに残し、画面には詳細を出さない）
app.use((err, req, res, next) => {
    console.error('[Web Error]', req.method, req.originalUrl, err);
    if (res.headersSent) return next(err);
    res.status(500).send('Internal Server Error');
});

module.exports = app;
