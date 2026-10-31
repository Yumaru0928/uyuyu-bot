// utils/link-db.js
// マイクラ連携用のDB（GitHubリポジトリ上の links.json / pending_keys.json）を読み書きする。
//
// ★ 個人情報（マイクラUUID と Discord ID の対応）を含むため、必ず「Private」リポジトリを指定すること。
//    このBotのリポジトリは Public なので、同じリポジトリの data ブランチには置かないでください。
//
// 環境変数
//   LINK_DB_REPO    … 例: "Yumaru0928/uyuyu-link-db"（必須・Private推奨）
//   LINK_DB_BRANCH  … 省略時 "main"
//   LINK_DB_TOKEN   … 省略時は GITHUB_TOKEN を使う（対象リポジトリの Contents 読み書き権限が必要）

const GITHUB_TIMEOUT_MS = 15000;

function settings() {
    const repo = process.env.LINK_DB_REPO;
    const token = process.env.LINK_DB_TOKEN || process.env.GITHUB_TOKEN;
    if (!repo || !token) return null;
    return {
        repo,
        branch: process.env.LINK_DB_BRANCH || 'main',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'uyuyu-bot',
        },
    };
}

const isConfigured = () => settings() !== null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path) {
    const s = settings();
    if (!s) throw new Error('LINK_DB_REPO / LINK_DB_TOKEN が未設定です');
    const res = await fetch(`https://api.github.com/repos/${s.repo}/contents/${path}?ref=${s.branch}`, {
        headers: s.headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (res.status === 404) return { data: {}, sha: null };
    if (!res.ok) throw new Error(`GitHub read ${path}: HTTP ${res.status}`);
    const file = await res.json();
    const text = Buffer.from(file.content || '', 'base64').toString('utf-8');
    return { data: text.trim() ? JSON.parse(text) : {}, sha: file.sha };
}

/**
 * 読み込み → mutate → 書き込み。SHA競合(409/422)のときは読み直してやり直す。
 * mutate(data) は data を書き換えて返す。書き込み不要なら null を返す。
 * ※ 再試行で mutate が複数回呼ばれるので、外側の変数は mutate の先頭で初期化すること。
 */
async function updateJson(path, mutate, message, retries = 6) {
    const s = settings();
    if (!s) throw new Error('LINK_DB_REPO / LINK_DB_TOKEN が未設定です');

    for (let i = 0; i < retries; i++) {
        const { data, sha } = await readJson(path);
        const next = await mutate(data);
        if (next === null) return { changed: false, data };

        const body = {
            message: `${message} [skip render]`,
            branch: s.branch,
            content: Buffer.from(JSON.stringify(next, null, 2), 'utf-8').toString('base64'),
            ...(sha && { sha }),
        };
        const res = await fetch(`https://api.github.com/repos/${s.repo}/contents/${path}`, {
            method: 'PUT',
            headers: { ...s.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (res.ok) return { changed: true, data: next };
        if (res.status === 409 || res.status === 422) {
            await sleep(300 * (i + 1) + Math.random() * 300);
            continue;
        }
        throw new Error(`GitHub write ${path}: HTTP ${res.status}`);
    }
    throw new Error(`GitHub write ${path}: 競合が解消せず中断しました`);
}

// links.json を60秒キャッシュ（/start のたびにGitHub APIを叩かない）
let linksCache = { data: null, at: 0 };

async function getLinks() {
    if (linksCache.data && Date.now() - linksCache.at < 60_000) return linksCache.data;
    const { data } = await readJson('links.json');
    linksCache = { data, at: Date.now() };
    return data;
}

function setLinksCache(data) {
    linksCache = { data, at: Date.now() };
}

module.exports = { isConfigured, readJson, updateJson, getLinks, setLinksCache };