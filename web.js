// web.js
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('node:path');
const fs = require('node:fs');

const app = express();

// 1. セッション設定
app.use(session({
    secret: process.env.SESSION_SECRET || 'uyuyu_session_secret',
    resave: false,
    saveUninitialized: false
}));

// 2. Passport の初期化（必ずセッション設定の後に行う）
app.use(passport.initialize());
app.use(passport.session());

// 3. ユーザーのシリアライズ・デザリアライズ
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(obj, null));

// 4. Discord Strategy の設定
passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
    scopes: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ビューエンジンの設定（EJS）
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));

// 5. 認証ルート（ここで明示的に scope を渡すことでエラーを確実に回避します）
app.get('/auth/discord', passport.authenticate('discord', {
    scope: ['identify', 'guilds']
}));

app.get('/auth/discord/callback', 
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
    
    // 管理者権限（Administrator = 0x8）を持つサーバーを抽出
    const guilds = userGuilds.filter(guild => (guild.permissions & 0x8) === 0x8);
    
    // dashboard.ejs を表示
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
    const hasPermission = userGuilds.some(g => g.id === guildId && (g.permissions & 0x8) === 0x8);
    if (!hasPermission) {
        return res.status(403).send('このサーバーを管理する権限がありません。');
    }

    // 設定ファイルから読み込み
    const filePath = path.join(__dirname, 'config-channels.json');
    let configData = {};
    if (fs.existsSync(filePath)) {
        configData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const guildConfig = configData[guildId] || {};
    res.render('dashboard', { guildId, guildConfig }); // もし個別設定画面用テンプレートがあれば適宜変更
});
module.exports = app;