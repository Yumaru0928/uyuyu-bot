// web.js
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { ChannelType } = require('discord.js');
const createRemember = require('./utils/remember.js');
const { getChannelConfig, updateChannelConfig, ensureGuildConfig } = require('./utils/channel-config.js');
const notify = require('./utils/notify');

const app = express();

// Render などのリバースプロキシ配下で、HTTPS・Cookie を正しく扱うために必要
app.set('trust proxy', 1);

// Discord のイベント通知（アプリの追加・削除。utils/event-webhook.js で署名を検証して処理する）
// 署名の検証には加工前の生の本文が必要なので、セッションなど他のミドルウェアより前に置く
const { processEvent } = require('./utils/event-webhook.js');
app.post('/discord/events', express.raw({ type: 'application/json' }), (req, res) => {
    const client = req.app.get('client');
    if (!client) return res.sendStatus(503);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.sendStatus(processEvent(client, rawBody, req.headers));
});
// ブラウザで開いて「ok」と出れば、このルートがデプロイされている（動作確認用）
app.get('/discord/events', (req, res) => res.type('text/plain').send('ok'));

// YouTube(WebSub) / Twitch(EventSub) からの通知（utils/notify/）。
// 署名の検証には加工前の生の本文が必要なので、こちらもセッションなどより前に置く。
// 署名はそれぞれの共有シークレットで検証するので、ログインは要らない。
const webhookBody = express.raw({ type: () => true, limit: '256kb' });
const rawOf = req => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

// YouTube: 購読の確認（GET）と新着通知（POST）
app.get('/webhook/youtube', (req, res) => {
    const client = req.app.get('client');
    if (!client) return res.sendStatus(503);
    const { status, body } = notify.webhooks.youtubeVerify(client, req.query);
    res.status(status).type('text/plain').send(body);
});
app.post('/webhook/youtube', webhookBody, (req, res) => {
    const client = req.app.get('client');
    if (!client) return res.sendStatus(503);
    res.sendStatus(notify.webhooks.youtubeNotify(client, rawOf(req), req.headers));
});

// Twitch: 購読の確認も通知も POST
app.post('/webhook/twitch', webhookBody, (req, res) => {
    const client = req.app.get('client');
    if (!client) return res.sendStatus(503);
    const { status, body } = notify.webhooks.twitch(client, rawOf(req), req.headers);
    if (body !== undefined) return res.status(status).type('text/plain').send(body);
    res.sendStatus(status);
});

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

// そのサーバーの、通知で @メンションできるロール（everyone と Bot 管理のロールは除く。上位のロールが先）
function rolesOf(client, guildId) {
    const guild = client && client.guilds ? client.guilds.cache.get(guildId) : null;
    if (!guild) return [];
    return Array.from(guild.roles.cache.values())
        .filter(role => role.id !== guild.id && !role.managed)
        .sort((a, b) => b.position - a.position);
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

// 5.5 Web版ババ抜き（/play/babanuki）
//    対局は WebSocket（utils/babanuki-server.js）で進む。WS の upgrade では express-session を
//    そのまま使えないため、ログイン済みセッションから短命の署名付きトークンを発行し、
//    WS 側はそれを検証するだけにする（認証そのものは上の Discord OAuth を流用）。
//    署名鍵はセッションと同じ sessionSecret（未設定時は起動ごとのランダム値なので、
//    再起動でトークンも無効になる。セッションが切れる挙動と揃っている）。
const BABANUKI_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6時間

function issueBabanukiToken(user) {
    const payload = Buffer.from(JSON.stringify({
        id: String(user.id),
        name: user.username || 'プレイヤー',
        avatar: user.avatar || null,
        exp: Date.now() + BABANUKI_TOKEN_TTL_MS
    }), 'utf-8').toString('base64url');
    const sig = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyBabanukiToken(token) {
    try {
        const [payload, sig] = String(token).split('.');
        if (!payload || !sig) return null;
        const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
        if (!data.id || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
        return { id: String(data.id), name: String(data.name || 'プレイヤー'), avatar: data.avatar ? String(data.avatar) : null };
    } catch {
        return null;
    }
}
// index.js が対局サーバーを立てる時に使う
app.set('babanukiVerifyToken', verifyBabanukiToken);

// 対戦ページ本体（静的HTML）。express.static でも /play/babanuki.html で届くが、
// シートの想定どおり拡張子なしのURLで入れるようにする
app.get('/play/babanuki', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play', 'babanuki.html'));
});

// ログイン状態と WS 用トークンを返す（remember Cookie からの復元もここで効かせる）
app.get('/api/babanuki/me', remember.restoreLogin, (req, res) => {
    if (req.isAuthenticated() && req.user) {
        return res.json({ loggedIn: true, name: req.user.username || 'プレイヤー', token: issueBabanukiToken(req.user) });
    }
    res.json({ loggedIn: false });
});

// 5.5b Web版 三人麻雀（/play/mahjong）: 対局は WebSocket（utils/mahjong-server.js）。
// ログイン用トークンはババ抜きと共通のものをそのまま使う
app.get('/play/mahjong', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play', 'mahjong.html'));
});

app.get('/api/mahjong/me', remember.restoreLogin, (req, res) => {
    if (req.isAuthenticated() && req.user) {
        return res.json({ loggedIn: true, name: req.user.username || 'プレイヤー', token: issueBabanukiToken(req.user) });
    }
    res.json({ loggedIn: false });
});

// 5.6 棋譜（/play/kifu）
//    対戦ゲーム（将棋・オセロ・四目並べ）の終局時に utils/kifu-store.js へ保存された棋譜を、
//    Web で一覧・再生できるようにする。一覧とお気に入りは Discord ログイン必須、
//    棋譜コードでの閲覧はログイン不要（コードを知っている人なら誰でも見られる）。
const kifuStore = require('./utils/kifu-store');
const kifuReplay = require('./utils/kifu-replay');
const { GAMES: KIFU_GAMES } = require('./utils/games');

app.get('/play/kifu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play', 'kifu.html'));
});
app.get('/play/kifu/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play', 'kifu.html'));
});

// 一覧用に、見る人から見た形へ整える
function kifuSummary(record, userId) {
    const opponent = record.players.find(p => p.id !== userId) || record.players[1];
    const fav = userId ? kifuStore.getFavorite(userId, record.id) : null;
    return {
        code: record.code,
        game: record.game,
        gameLabel: KIFU_GAMES[record.game]?.label ?? record.game,
        opponentName: opponent?.name ?? '',
        opponentBot: Boolean(opponent?.bot),
        isFirst: record.firstId === userId, // 自分が先手かどうか
        result: record.winnerId === null ? 'draw' : record.winnerId === userId ? 'win' : 'lose',
        reason: record.reason,
        level: record.level,
        plies: record.moves.length,
        createdAt: record.createdAt,
        favorite: Boolean(fav),
        name: fav?.name ?? null
    };
}

// 自分が参加した対局の一覧（新しい順）
app.get('/api/kifu/list', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    const userId = String(req.user.id);
    res.json({ items: kifuStore.listForUser(userId).map(r => kifuSummary(r, userId)) });
});

// 棋譜のメタ情報と着手リスト（ログイン不要。ログイン中なら自分のお気に入り状態も返す）
app.get('/api/kifu/view/:code', remember.restoreLogin, (req, res) => {
    const record = kifuStore.getByCode(req.params.code);
    if (!record) return res.status(404).json({ error: '棋譜が見つかりません（削除された可能性があります）' });
    const userId = req.isAuthenticated() && req.user ? String(req.user.id) : null;
    const fav = userId ? kifuStore.getFavorite(userId, record.id) : null;
    const winner = record.winnerId === null ? null : record.players.find(p => p.id === record.winnerId);
    const first = record.players.find(p => p.id === record.firstId);
    res.json({
        code: record.code,
        game: record.game,
        gameLabel: KIFU_GAMES[record.game]?.label ?? record.game,
        players: record.players.map(p => ({ name: p.name, bot: p.bot })),
        firstName: first?.name ?? '',
        winnerName: winner?.name ?? null,
        draw: record.winnerId === null,
        reason: record.reason,
        level: record.level,
        plies: record.moves.length,
        createdAt: record.createdAt,
        moves: kifuReplay.moveLabels(record),
        loggedIn: Boolean(userId),
        favorite: Boolean(fav),
        name: fav?.name ?? null
    });
});

// n手目の盤面画像（PNG）。再生はサーバー側で行い、既存の盤面描画をそのまま使う
app.get('/api/kifu/view/:code/position', (req, res) => {
    const record = kifuStore.getByCode(req.params.code);
    if (!record) return res.status(404).json({ error: '棋譜が見つかりません（削除された可能性があります）' });
    let buf;
    try {
        buf = kifuReplay.renderPositionPng(record, req.query.ply);
    } catch (error) {
        console.error('[Web] 棋譜の再生に失敗しました:', error);
        return res.status(500).json({ error: '盤面を再生できませんでした' });
    }
    if (!buf) return res.status(503).json({ error: '盤面画像を生成できない環境です' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
    res.send(buf);
});

// お気に入りと名前の更新（自分の分だけ）
app.post('/api/kifu/favorite', express.json({ limit: '16kb' }), remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const record = kifuStore.getByCode(typeof body.code === 'string' ? body.code : '');
    if (!record) return res.status(404).json({ error: '棋譜が見つかりません（削除された可能性があります）' });
    const userId = String(req.user.id);
    const name = typeof body.name === 'string' ? body.name : undefined;
    kifuStore.setFavorite(userId, record.id, Boolean(body.favorite), name);
    const fav = kifuStore.getFavorite(userId, record.id);
    res.json({ ok: true, favorite: Boolean(fav), name: fav?.name ?? null });
});

// 5.7 麻雀の対戦履歴（/play/mahjong/replay/:code）
//    終局時に utils/mahjong-history-store.js へ保存された対局を、卓の上で再生できる。
//    一覧とお気に入りは Discord ログイン必須、コードでの閲覧はログイン不要（棋譜と同じ）。
const mahjongHistoryStore = require('./utils/mahjong-history-store');
const mahjongReplay = require('./utils/mahjong-replay');

app.get('/play/mahjong/replay/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'play', 'mahjong-replay.html'));
});

function mahjongHistorySummary(record, userId) {
    const fav = userId ? mahjongHistoryStore.getFavorite(userId, record.id) : null;
    const mySeat = userId ? record.players.findIndex(p => p.id === userId && !p.bot) : -1;
    return {
        code: record.code,
        length: record.length,
        players: record.players.map(p => ({ name: p.name, bot: p.bot })),
        myPlacement: mySeat >= 0 && record.placements ? record.placements[mySeat] : null,
        placements: record.placements,
        finalScores: record.finalScores,
        scores: record.scores,
        rounds: record.rounds.length,
        createdAt: record.createdAt,
        favorite: Boolean(fav),
        name: fav?.name ?? null
    };
}

// 自分が参加した対局の一覧（新しい順）
app.get('/api/mahjong-history/list', remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    const userId = String(req.user.id);
    res.json({ items: mahjongHistoryStore.listForUser(userId).map(r => mahjongHistorySummary(r, userId)) });
});

// 再生データ（ステップ列）は不変なので、作ったものをメモリにキャッシュする
const mahjongReplayCache = new Map();
app.get('/api/mahjong-history/view/:code', remember.restoreLogin, (req, res) => {
    const record = mahjongHistoryStore.getByCode(req.params.code);
    if (!record) return res.status(404).json({ error: '対戦履歴が見つかりません（削除された可能性があります）' });
    const userId = req.isAuthenticated() && req.user ? String(req.user.id) : null;
    const fav = userId ? mahjongHistoryStore.getFavorite(userId, record.id) : null;
    let built = mahjongReplayCache.get(record.id);
    if (!built) {
        try {
            built = mahjongReplay.buildReplay(record);
        } catch (error) {
            console.error('[Web] 麻雀リプレイの再現に失敗しました:', error);
            return res.status(500).json({ error: '対戦履歴を再生できませんでした' });
        }
        if (mahjongReplayCache.size > 20) mahjongReplayCache.clear();
        mahjongReplayCache.set(record.id, built);
    }
    res.json({
        code: record.code,
        length: record.length,
        players: record.players.map(p => ({ name: p.name, bot: p.bot })),
        mySeat: userId ? record.players.findIndex(p => p.id === userId && !p.bot) : -1,
        createdAt: record.createdAt,
        rounds: built.rounds,
        steps: built.steps,
        loggedIn: Boolean(userId),
        favorite: Boolean(fav),
        name: fav?.name ?? null
    });
});

// お気に入りと名前の更新（自分の分だけ）
app.post('/api/mahjong-history/favorite', express.json({ limit: '16kb' }), remember.restoreLogin, (req, res) => {
    if (!req.isAuthenticated() || !req.user) {
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const record = mahjongHistoryStore.getByCode(typeof body.code === 'string' ? body.code : '');
    if (!record) return res.status(404).json({ error: '対戦履歴が見つかりません（削除された可能性があります）' });
    const userId = String(req.user.id);
    const name = typeof body.name === 'string' ? body.name : undefined;
    mahjongHistoryStore.setFavorite(userId, record.id, Boolean(body.favorite), name);
    const fav = mahjongHistoryStore.getFavorite(userId, record.id);
    res.json({ ok: true, favorite: Boolean(fav), name: fav?.name ?? null });
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

    // 通知の追加・削除の結果（POST のあとに1回だけ表示する）
    const notifyFlash = req.session.notifyFlash || null;
    delete req.session.notifyFlash;

    res.render('guild', {
        user: req.user,
        guilds,
        guild,
        guildId,
        guildConfig: getChannelConfig()[guildId] || {},
        channels: textChannelsOf(req.app.get('client'), guildId),
        roles: rolesOf(req.app.get('client'), guildId),
        notifications: notify.listSubscriptions(guildId),
        notifyPlatforms: notify.platformInfo(),
        notifyLabel: notify.labelOf,
        notifyMax: notify.MAX_PER_GUILD,
        notifyFlash,
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

        // ババ抜きの招待リンク自動投稿先（/babanuki コマンドで人間対戦の待機ルームが作られたときに使う）
        const babanukiChannel = String(req.body.babanukiChannel || '');
        if (babanukiChannel && !channelIds.has(babanukiChannel)) {
            return res.status(400).send('ババ抜きの自動投稿先に指定できないチャンネルです。');
        }

        // 麻雀の自動投稿先（/mahjong コマンドでルームが作られたときに使う）
        const mahjongChannel = String(req.body.mahjongChannel || '');
        if (mahjongChannel && !channelIds.has(mahjongChannel)) {
            return res.status(400).send('麻雀の自動投稿先に指定できないチャンネルです。');
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

                // ババ抜きの自動投稿先（空なら設定を消す）
                if (babanukiChannel) {
                    guildConfig.babanukiChannel = babanukiChannel;
                } else {
                    delete guildConfig.babanukiChannel;
                }

                // 麻雀の自動投稿先（空なら設定を消す）
                if (mahjongChannel) {
                    guildConfig.mahjongChannel = mahjongChannel;
                } else {
                    delete guildConfig.mahjongChannel;
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
        const tab = /^[a-z-]{1,20}$/.test(String(req.body.tab || '')) ? `#${req.body.tab}` : '';
        res.redirect(`/dashboard/${guildId}?saved=true${tab}`);

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

// 通知（YouTube / Twitch / X）の追加・削除。「変更を保存」を待たず、押した時点ですぐ反映する
app.post('/dashboard/:guildId/notifications', remember.restoreLogin, async (req, res, next) => {
    try {
        if (!req.isAuthenticated()) {
            return res.redirect('/auth/discord');
        }
        const guildId = req.params.guildId;
        if (!manageableGuilds(req).some(g => g.id === guildId)) {
            return res.status(403).send('このサーバーを管理する権限がないか、Botが加入していません。');
        }

        const client = req.app.get('client');
        const flash = (type, text) => { req.session.notifyFlash = { type, text }; };

        try {
            if (req.body.action === 'remove') {
                await notify.removeSubscription(client, guildId, String(req.body.id || ''));
                flash('ok', '通知を削除しました。');
            } else {
                // 通知先・ロールは、このサーバーのものだけ受け付ける（フォームを書き換えられても他のIDは通さない）
                const channelId = String(req.body.channelId || '');
                if (!textChannelsOf(client, guildId).some(c => c.id === channelId)) {
                    throw new notify.NotifyError('通知先に指定できないチャンネルです。');
                }
                const roleId = String(req.body.roleId || '');
                if (roleId && roleId !== 'everyone' && !rolesOf(client, guildId).some(r => r.id === roleId)) {
                    throw new notify.NotifyError('メンションに指定できないロールです。');
                }

                const platform = String(req.body.platform || '');
                const entry = await notify.addSubscription(client, guildId, {
                    platform,
                    input: String(req.body.target || ''),
                    channelId,
                    roleId,
                });
                flash('ok', `${notify.labelOf(platform)} の「${entry.targetName}」の通知を追加しました。`);
            }
        } catch (error) {
            if (error instanceof notify.NotifyError) {
                flash('error', error.message);
            } else {
                console.error('[Web] 通知の設定に失敗しました:', error);
                flash('error', '内部エラーが発生しました。しばらくしてからもう一度お試しください。');
            }
        }
        res.redirect(`/dashboard/${guildId}#notifications`);
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