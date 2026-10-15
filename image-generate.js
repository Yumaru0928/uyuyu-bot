// image-generate.js
// /generate と events/reply-generate.js で共有する、Nano Banana（Gemini画像生成）の呼び出し処理。
// レート制限・混雑時は MODELS の順に自動でフォールバックする。
const { GoogleGenAI } = require("@google/genai");
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "config.json");
let apiKey = process.env.GEMINI_API_KEY;

if (fs.existsSync(configPath)) {
    const config = require(configPath);
    apiKey = config.GEMINI_API_KEY || config.apiKey || apiKey;
}

const ai = new GoogleGenAI({ apiKey: apiKey });

// フォールバック順: Pro → 2 → 2 Lite → 2.1
// モデルIDが変わった場合はここだけ直せばOK。
const MODELS = [
    { label: "Nano Banana Pro", id: "gemini-3-pro-image" },
    { label: "Nano Banana 2", id: "gemini-3.1-flash-image" },
    { label: "Nano Banana 2 Lite", id: "gemini-3.1-flash-lite-image" },
    { label: "Nano Banana 2.1", id: "gemini-nano-banana-2.1" }
];

// 生成画像メッセージを見分けるためのファイル名プレフィックス（reply-generate / reply-chat が使用）
const GENERATED_FILE_PREFIX = "uyuyu-generate-";

function isNotFound(error) {
    return error.status === 404 || (error.message && /not found|404/i.test(error.message));
}

function isRateLimitedOrBusy(error) {
    return (
        error.status === 429 ||
        error.status === 503 ||
        (error.message && /429|503|overloaded|quota|rate/i.test(error.message))
    );
}

class NoImageError extends Error {
    constructor(text) {
        super("画像が生成されませんでした");
        this.name = "NoImageError";
        this.modelText = text || "";
    }
}

// URLからファイルをダウンロードして、Geminiが扱えるInlineData形式に変換する
async function urlToGenerativePart(url, mimeType) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ファイルの取得に失敗しました: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(buffer).toString("base64"),
            mimeType
        }
    };
}

// レスポンスから画像(最初の1枚)とテキストを取り出す
function extractResult(response) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    let image = null;
    let text = "";

    for (const part of parts) {
        if (part.inlineData?.data && !image) {
            image = {
                buffer: Buffer.from(part.inlineData.data, "base64"),
                mimeType: part.inlineData.mimeType || "image/png"
            };
        } else if (part.text) {
            text += part.text;
        }
    }

    return { image, text };
}

function mimeToExtension(mimeType) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

/**
 * 画像を生成する。レート制限/混雑/モデル未提供の場合は次のモデルへフォールバック。
 * @param {Array} contents  Gemini の contents（文字列 or parts 配列）
 * @param {(label: string) => Promise<void>} [onFallback] レート制限/混雑でモデルを切り替える際に呼ばれる
 * @returns {{ image: {buffer, mimeType}, text: string, modelLabel: string, modelId: string }}
 */
async function generateImageWithFallback(contents, onFallback) {
    let lastError = null;

    for (const model of MODELS) {
        try {
            const response = await ai.models.generateContent({
                model: model.id,
                contents,
                config: {
                    responseModalities: ["TEXT", "IMAGE"]
                }
            });

            const { image, text } = extractResult(response);
            if (!image) throw new NoImageError(text);

            return { image, text, modelLabel: model.label, modelId: model.id };
        } catch (error) {
            // 安全フィルタ等で画像が返らなかった場合は、別モデルでも同じなのでそのまま投げる
            if (error instanceof NoImageError) throw error;

            lastError = error;

            if (isNotFound(error)) {
                console.warn(`[generate] モデル ${model.id} が見つかりません。次のモデルを試します...`);
                continue;
            }

            if (isRateLimitedOrBusy(error)) {
                console.warn(`[generate] モデル ${model.id} がレート制限か混雑中のため、次のモデルにフォールバックします...`);
                if (onFallback) {
                    try {
                        await onFallback(model.label);
                    } catch (e) { }
                }
                continue;
            }

            throw error;
        }
    }

    throw lastError;
}

module.exports = {
    MODELS,
    GENERATED_FILE_PREFIX,
    NoImageError,
    urlToGenerativePart,
    mimeToExtension,
    generateImageWithFallback
};
