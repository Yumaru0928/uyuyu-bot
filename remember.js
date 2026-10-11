// remember.js
// Discord のログイン情報(OAuth2 トークン)をブラウザの Cookie に保存し、
// サーバー再起動などでセッションが消えても、自動でログイン状態に戻すためのモジュール。
//
// ・トークンは AES-256-GCM で暗号化し、httpOnly の Cookie に入れる
//   (JavaScript から読めないので、localStorage より盗まれにくい)
// ・Cookie が無い/壊れている/改ざんされている場合は、何もせず未ログインとして扱う
// ・アクセストークンが期限切れなら、リフレッシュトークンで更新して Cookie を差し替える
// ・暗号化の鍵は SESSION_SECRET から作る。未設定のときは機能ごと無効になる
const crypto = require('node:crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const COOKIE_NAME = 'uyuyu_auth';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // 30日
const TIMEOUT_MS = 8000;

function createRemember({ secret, clientId, clientSecret, isProd = false } = {}) {
    // 鍵は SESSION_SECRET から導出する。無ければ無効（既定値は公開されているので使わない）
    const key = secret
        ? crypto.createHash('sha256').update('uyuyu-remember:' + secret).digest()
        : null;
    const enabled = Boolean(key && clientId && clientSecret);

    // ---------- 暗号化 ----------
    function seal(obj) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return [iv, tag, body].map(b => b.toString('base64url')).join('.');
    }

    function unseal(text) {
        try {
            const [iv, tag, body] = String(text).split('.').map(s => Buffer.from(s, 'base64url'));
            if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !body) return null;
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
            const data = JSON.parse(json);
            return data && typeof data.accessToken === 'string' ? data : null;
        } catch {
            return null; // 改ざん・鍵違い・壊れた値
        }
    }

    // ---------- Cookie の読み書き ----------
    function readCookie(req) {
        const header = req.headers && req.headers.cookie;
        if (!header) return null;
        for (const part of header.split(';')) {
            const i = part.indexOf('=');
            if (i < 0 || part.slice(0, i).trim() !== COOKIE_NAME) continue;
            try {
                return decodeURIComponent(part.slice(i + 1).trim());
            } catch {
                return null;
            }
        }
        return null;
    }

    const cookieOptions = () => ({
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        path: '/'
    });

    function set(res, tokens) {
        if (!enabled || !tokens || !tokens.accessToken) return;
        const value = seal({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || null });
        res.cookie(COOKIE_NAME, value, { ...cookieOptions(), maxAge: COOKIE_MAX_AGE });
    }

    function clear(res) {
        res.clearCookie(COOKIE_NAME, cookieOptions());
    }

    function read(req) {
        if (!enabled) return null;
        const raw = readCookie(req);
        return raw ? unseal(raw) : null;
    }

    // ---------- Discord API ----------
    async function loadUser(accessToken) {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const get = p => fetch(DISCORD_API + p, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const [meRes, guildsRes] = await Promise.all([get('/users/@me'), get('/users/@me/guilds')]);
        if (meRes.status === 401 || guildsRes.status === 401) return { invalid: true };
        if (!meRes.ok || !guildsRes.ok) {
            // 一時的な障害など。トークン自体は無効とは限らないので Cookie は消さない
            throw new Error(`Discord API error: ${meRes.status}/${guildsRes.status}`);
        }
        const me = await meRes.json();
        const guilds = await guildsRes.json();
        return { user: { ...me, guilds } };
    }

    async function postToken(path, params) {
        return fetch(DISCORD_API + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    }

    // 更新できなければ null（リフレッシュトークンが無効＝再ログインが必要）
    async function refresh(refreshToken) {
        const res = await postToken('/oauth2/token', {
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        });
        if (res.status === 400 || res.status === 401) return null;
        if (!res.ok) throw new Error(`Discord token error: ${res.status}`);
        const data = await res.json();
        if (!data.access_token) return null;
        return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
    }

    // ログアウト時にDiscord側でも認可を取り消す（失敗してもログアウト自体は続ける）
    async function revoke(tokens) {
        if (!enabled || !tokens) return;
        try {
            const token = tokens.refreshToken || tokens.accessToken;
            const hint = tokens.refreshToken ? 'refresh_token' : 'access_token';
            await postToken('/oauth2/token/revoke', { token, token_type_hint: hint });
        } catch (error) {
            console.error('[Remember] トークンの失効に失敗しました:', error.message);
        }
    }

    // ---------- ミドルウェア ----------
    // セッションが無いときだけ、Cookie のトークンでログイン状態を復元する
    async function restoreLogin(req, res, next) {
        try {
            if (!enabled || req.isAuthenticated()) return next();

            let tokens = read(req);
            if (!tokens) {
                if (readCookie(req)) clear(res); // 壊れた Cookie は片付ける
                return next();
            }

            let loaded = await loadUser(tokens.accessToken);

            if (loaded.invalid && tokens.refreshToken) {
                const fresh = await refresh(tokens.refreshToken);
                if (fresh) {
                    tokens = fresh;
                    loaded = await loadUser(tokens.accessToken);
                }
            }

            if (loaded.invalid || !loaded.user) {
                clear(res); // 認可が取り消されている。再ログインしてもらう
                return next();
            }

            const user = { ...loaded.user, auth: tokens };
            await new Promise((resolve, reject) => req.login(user, e => (e ? reject(e) : resolve())));
            set(res, tokens); // 使うたびに期限を延ばす
            next();
        } catch (error) {
            // Discord 側の一時的な不調など。未ログインとして続行する（次のアクセスで再試行）
            console.error('[Remember] ログインの復元に失敗しました:', error.message);
            next();
        }
    }

    return { enabled, set, clear, read, revoke, restoreLogin, _seal: seal, _unseal: unseal, COOKIE_NAME };
}

module.exports = createRemember;
