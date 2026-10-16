// gemini.js
// Gemini を使う機能（/chat, events/reply-chat.js）の共通処理。
// ・API キーの読み込み（未設定でも Bot 全体は落とさず、AI 機能だけ無効にする）
// ・フォールバックするモデルの順番（チャット用）
// ・エラーの判定と、ユーザーに見せる文言
// ・Discord 用のメッセージ分割 / 長いコードのファイル化 / クールダウン
const { GoogleGenAI } = require('@google/genai');
const { AttachmentBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

// ローディング表示用の絵文字。Bot がいないサーバーの絵文字は表示されないので、環境変数で差し替えられるようにしてある
const LOADING = process.env.LOADING_EMOJI || '<a:load:1559811422261747783>';

// AI の出力やユーザー入力の @everyone / @role / @user で誰かに通知が飛ばないようにする
const NO_MENTIONS = Object.freeze({ parse: [] });

// チャットのフォールバック順（/chat と reply-chat で共通）。モデルIDが変わったらここだけ直せばOK
const CHAT_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-4-argon'
];

const CHAT_SYSTEM_INSTRUCTION = `あなた（AI）は、Discordのbot「うゆゆ」です。
以下の【キャラクター設定】と【動作ルール】に厳格に従ってユーザーと会話してください。

【基本設定】
- 名称：うゆゆ
- 一人称：ボク
- 語尾・口調：少し砕けたフランクで親しみやすい話し方（「〜だよ」「〜かな？」「〜してみてね！」など）

【動作ルール】
1. 回答言語：必ず日本語で回答してください。
2. 画像生成に関する対応：
    - ユーザーから「画像を描いて」「画像を生成して」など、画像作成を明示的に依頼された場合のみ対応してください。
    - 画像生成の話題を自分から頻繁に出さないでください。（画像と無関係な会話の際に/generateに言及するのは禁止です）
    - 画像生成を頼まれた際は、/generateコマンドを使用するようユーザーに促してください。
    - 同時に、ユーザーが求める画像に合わせて「flux 1 schnell」向けの英語プロンプトを考案し、以下のフォーマットで出力してください。
      \`\`\`/generate prompt:[考案したプロンプト]\`\`\`
3. 自然な会話：画像生成の話が出ていないときは、画像生成に関する注記やヒントは一切出力せず、通常の会話に集中してください。`;

// ---------- API キー / クライアント ----------
function loadApiKey() {
    let key = process.env.GEMINI_API_KEY;
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            key = config.GEMINI_API_KEY || config.apiKey || key;
        } catch (error) {
            console.error('[Gemini] config.json の読み込みに失敗しました:', error.message);
        }
    }
    return key || null;
}

let client = null;
const apiKey = loadApiKey();
if (!apiKey) {
    console.warn('[Gemini] GEMINI_API_KEY が設定されていません。AI 機能（/chat, 返信チャット）は無効になります。');
} else {
    try {
        client = new GoogleGenAI({ apiKey });
    } catch (error) {
        console.error('[Gemini] クライアントの初期化に失敗しました。AI 機能は無効になります:', error);
    }
}

class GeminiConfigError extends Error {
    constructor() {
        super('Gemini の API キーが設定されていません');
        this.name = 'GeminiConfigError';
    }
}

class FileFetchError extends Error {
    constructor(detail) {
        super(`ファイルの取得に失敗しました: ${detail}`);
        this.name = 'FileFetchError';
    }
}

// 使う直前に呼ぶ。キーが無ければ GeminiConfigError を投げる
function getAI() {
    if (!client) throw new GeminiConfigError();
    return client;
}

// ---------- エラー判定 ----------
function isNotFound(error) {
    return error?.status === 404 || /not found|\b404\b/i.test(error?.message || '');
}

function isRateLimitedOrBusy(error) {
    return (
        error?.status === 429 ||
        error?.status === 503 ||
        /\b429\b|\b503\b|overloaded|unavailable|quota|resource.?exhausted|rate.?limit/i.test(error?.message || '')
    );
}

// 別のモデルを試す価値があるエラーか
function isFallbackable(error) {
    return isNotFound(error) || isRateLimitedOrBusy(error);
}

// ユーザーに見せるエラー文言（原因ごとに出し分ける）
function describeError(error, what = 'AI') {
    if (error instanceof GeminiConfigError) {
        return `Gemini の API キーが設定されていないため、${what}は今は使えません。管理者に連絡してください。`;
    }
    if (error instanceof FileFetchError) {
        return '添付ファイルを取得できませんでした。もう一度添付し直してみてください。';
    }
    if (error?.status === 401 || error?.status === 403 || /api.?key/i.test(error?.message || '')) {
        return `Gemini の API キーが無効か、権限がないため${what}を使えません。管理者に連絡してください。`;
    }
    if (isFallbackable(error)) {
        return `現在、すべての${what}モデルがAPI/レート制限のため一時的に利用できません。少し時間をおいてから再度お試しください。`;
    }
    if (error?.status === 400) {
        return `リクエストの内容を${what}が受け付けませんでした。対応していないファイル形式や、内容の制限に当たった可能性があります。`;
    }
    return `${what}の応答中にエラーが発生しました。少し時間をおいてから再度お試しください。`;
}

/**
 * models を順に試す。レート制限/混雑/モデル未提供なら次のモデルへ、それ以外のエラーはそのまま投げる。
 * @param {string[]} models
 * @param {(model: string) => Promise<any>} attempt
 * @param {(model: string) => Promise<void>} [onFallback] 次のモデルへ切り替えるときに呼ばれる
 * @param {string} [tag] ログ用
 */
async function withModelFallback(models, attempt, onFallback, tag = 'gemini') {
    let lastError = null;
    for (const model of models) {
        try {
            return await attempt(model);
        } catch (error) {
            lastError = error;
            if (!isFallbackable(error)) throw error;
            console.warn(`[${tag}] モデル ${model} が利用できないか混雑中のため、次のモデルにフォールバックします...`);
            if (onFallback) {
                try {
                    await onFallback(model);
                } catch (e) { /* 表示の更新に失敗しても続行 */ }
            }
        }
    }
    throw lastError;
}

// ---------- ファイル ----------
// URL からファイルをダウンロードして、Gemini が扱える InlineData 形式に変換する
async function urlToGenerativePart(url, mimeType) {
    let response;
    try {
        response = await fetch(url);
    } catch (error) {
        throw new FileFetchError(error.message);
    }
    if (!response.ok) throw new FileFetchError(response.statusText || response.status);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString('base64'),
            mimeType
        }
    };
}

// ---------- メッセージ整形 ----------
// Discord の 2000 文字制限に収まるよう分割する。
// ・できるだけ改行で区切る / 絵文字（サロゲートペア）の途中では切らない
// ・コードブロックの途中で切れたら、前の分で閉じて次の分で開き直す
function splitMessage(text, maxLength = 1900) {
    const limit = maxLength - 30; // 開き直し・閉じ用の ``` と (続き) の分の余裕
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let rest = text;
    let fence = null; // コードブロックの中にいるとき、その言語名（無指定は ''）

    while (rest.length > maxLength) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit * 0.5) cut = limit;
        const prev = rest.charCodeAt(cut - 1);
        if (prev >= 0xD800 && prev <= 0xDBFF) cut--; // サロゲートペアの前半で切らない

        let chunk = rest.slice(0, cut);
        rest = rest.slice(cut).replace(/^\n/, '');

        if (fence !== null) chunk = '```' + fence + '\n' + chunk;
        for (const m of chunk.matchAll(/```([^\n`]*)/g)) {
            fence = fence === null ? m[1].trim() : null;
        }
        if (fence !== null) chunk += '\n```';

        chunks.push(chunk);
    }

    chunks.push(fence !== null ? '```' + fence + '\n' + rest : rest);
    return chunks;
}

// 言語名から適切な拡張子をマッピングする
function getExtension(lang) {
    if (!lang) return 'txt';
    const lowerLang = lang.toLowerCase().trim();
    const map = {
        javascript: 'js', js: 'js',
        typescript: 'ts', ts: 'ts',
        python: 'py', py: 'py',
        html: 'html', css: 'css',
        c: 'c', cpp: 'cpp', java: 'java',
        json: 'json',
        markdown: 'md', md: 'md',
        txt: 'txt'
    };
    return map[lowerLang] || lowerLang;
}

// 長いコードブロックを検出し、ファイル化する
function processLongCodeBlocks(replyText) {
    const attachments = [];
    let processedText = replyText;
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let match;
    let fileCount = 0;

    while ((match = codeBlockRegex.exec(replyText)) !== null) {
        const language = match[1] || '';
        const codeContent = match[2];

        if (codeContent.length > 1000) {
            fileCount++;
            const fileName = `code_${fileCount}.${getExtension(language)}`;
            attachments.push(new AttachmentBuilder(Buffer.from(codeContent, 'utf-8'), { name: fileName }));

            const replacement = `\n*(※ 長いコードのため、ファイル \`${fileName}\` として添付しました)*\n`;
            processedText = processedText.replace(match[0], () => replacement);
        }
    }

    return { processedText, attachments };
}

// ---------- クールダウン ----------
// ユーザーごとの連打を防ぐ。isCoolingDown(userId) が true なら今回は処理しない
function createCooldown(ms) {
    const last = new Map();
    return function isCoolingDown(id) {
        const now = Date.now();
        if (now - (last.get(id) ?? 0) < ms) return true;
        last.set(id, now);
        if (last.size > 1000) {
            for (const [key, time] of last) {
                if (now - time >= ms) last.delete(key);
            }
        }
        return false;
    };
}

module.exports = {
    LOADING,
    NO_MENTIONS,
    CHAT_MODELS,
    CHAT_SYSTEM_INSTRUCTION,
    GeminiConfigError,
    FileFetchError,
    getAI,
    isNotFound,
    isRateLimitedOrBusy,
    isFallbackable,
    describeError,
    withModelFallback,
    urlToGenerativePart,
    splitMessage,
    processLongCodeBlocks,
    createCooldown
};
