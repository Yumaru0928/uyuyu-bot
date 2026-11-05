// ai-messages.js
// AI（/chat・返信チャット）まわりの共通処理。
// ・AI が送った回答メッセージの記録
//     - 「AI の回答への返信」だけに反応するための判定
//     - 返信ではなく channel.send で送る「続き」のメッセージを、1つ前のメッセージにつなぐ
// ・/chat でスレッドを作ったときの「AI スレッド」の判定
//
// 記録はメモリ上に持ち、変更があったら index.js が設定した保存処理（GitHub の data ブランチへのコミット）で
// 保存する。起動時は index.js が data ブランチから importRecords() で読み戻す。
// Render は再起動でファイルが消えるので、ファイルには保存しない。

// AI スレッドの元メッセージ（最初の質問）の先頭に付ける見出し。AI スレッドの判定にも使う
const QUESTION_HEADER = '💬 **質問**';

const MAX_ENTRIES = 3000;          // 記録する件数の上限（古いものから消える）
const SAVE_DELAY_MS = 2 * 60 * 1000; // 変更してから保存するまでの待ち時間（コミットが増えすぎないよう、まとめて保存）

// メッセージID -> 1つ前のメッセージID（回答の2通目以降だけ。1通目は null）
const records = new Map();

let saveHandler = null;   // (data: object) => Promise<void>
let saveTimer = null;
let dirty = false;

function trim() {
    while (records.size > MAX_ENTRIES) records.delete(records.keys().next().value);
}

/** 保存用のデータ（{ メッセージID: 1つ前のメッセージID | null }）。古い順 */
function exportRecords() {
    return Object.fromEntries(records);
}

/** 保存済みのデータを読み戻す。すでにある記録（＝読み込み後に増えたもの）は新しい扱いで残す */
function importRecords(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
    const current = [...records];
    records.clear();
    for (const [id, prev] of Object.entries(data)) records.set(id, typeof prev === 'string' ? prev : null);
    for (const [id, prev] of current) {
        records.delete(id);
        records.set(id, prev);
    }
    trim();
    return records.size;
}

/** 保存処理を設定する。変更があると、SAVE_DELAY_MS 後にまとめて呼ばれる */
function setSaveHandler(handler) {
    saveHandler = handler;
}

function scheduleSave() {
    dirty = true;
    if (!saveHandler || saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flush().catch(error => console.warn('[ai-messages] 記録の保存に失敗しました:', error.message));
    }, SAVE_DELAY_MS);
}

/** 保存待ちの変更があれば、今すぐ保存する（終了前に呼ぶ） */
async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty || !saveHandler) return;
    dirty = false;
    await saveHandler(exportRecords());
}

/** AI の回答として送ったメッセージを記録する。2通目以降は prevId に1つ前のメッセージIDを渡す */
function registerAiMessage(id, prevId = null) {
    records.delete(id);
    records.set(id, prevId ?? null);
    trim();
    scheduleSave();
}

function isAiMessage(id) {
    return records.has(id);
}

/** 回答の2通目以降なら、1つ前のメッセージID。それ以外は null */
function getPrevAiMessageId(id) {
    return records.get(id) ?? null;
}

/**
 * channel が「/chat で作られた AI スレッド」なら、その元メッセージ（最初の質問）を返す。違えば null。
 * 判定はスレッド自体の情報だけで行うので、記録が無くても（再起動後でも）有効。
 */
async function getAiThreadStarter(channel, botId) {
    if (!channel?.isThread?.() || channel.ownerId !== botId) return null;
    const starter = await channel.fetchStarterMessage().catch(() => null);
    if (!starter || starter.author.id !== botId || !starter.content.startsWith(QUESTION_HEADER)) return null;
    return starter;
}

module.exports = {
    QUESTION_HEADER,
    registerAiMessage,
    isAiMessage,
    getPrevAiMessageId,
    getAiThreadStarter,
    exportRecords,
    importRecords,
    setSaveHandler,
    flush
};