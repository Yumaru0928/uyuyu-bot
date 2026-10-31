// utils/mc-ping.js
// Minecraft Java版の「サーバー一覧用ping（Server List Ping）」を送り、応答（JSON）を返す。
// 返ってくれば、そのアドレスで実際にサーバーに接続できる状態と判断できる。
const net = require('node:net');

function writeVarInt(value) {
    const bytes = [];
    let n = value >>> 0;
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n !== 0) b |= 0x80;
        bytes.push(b);
    } while (n !== 0);
    return Buffer.from(bytes);
}

/** buf の offset から VarInt を読む。足りなければ null。 */
function readVarInt(buf, offset = 0) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    for (;;) {
        if (pos >= buf.length) return null;
        const b = buf[pos++];
        result |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 35) throw new Error('VarIntが長すぎます');
    }
    return { value: result, size: pos - offset };
}

const withLength = (payload) => Buffer.concat([writeVarInt(payload.length), payload]);

/**
 * @returns {Promise<object>} サーバーのステータス（players / version など）。失敗時は reject。
 */
function pingJava(host, port = 25565, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        let done = false;
        const sock = net.connect({ host, port });

        const finish = (err, val) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sock.destroy();
            if (err) reject(err); else resolve(val);
        };
        const timer = setTimeout(() => finish(new Error('pingがタイムアウトしました')), timeoutMs);

        sock.once('connect', () => {
            const hostBytes = Buffer.from(host, 'utf8');
            const portBytes = Buffer.alloc(2);
            portBytes.writeUInt16BE(port);
            const handshake = Buffer.concat([
                writeVarInt(0x00),            // パケットID: Handshake
                writeVarInt(765),             // プロトコル番号（状態確認では何でもよい）
                writeVarInt(hostBytes.length), hostBytes,
                portBytes,
                writeVarInt(1),               // 次の状態: Status
            ]);
            sock.write(Buffer.concat([withLength(handshake), withLength(writeVarInt(0x00))])); // + Status Request
        });

        sock.on('error', (e) => finish(new Error(`接続できません: ${e.message}`)));
        sock.on('close', () => finish(new Error('応答なしで接続が閉じられました')));

        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            try {
                const len = readVarInt(buf, 0);
                if (!len || buf.length < len.size + len.value) return; // まだ全部届いていない
                let pos = len.size;
                const id = readVarInt(buf, pos); pos += id.size;
                if (id.value !== 0x00) return finish(new Error('想定外の応答です'));
                const strLen = readVarInt(buf, pos); pos += strLen.size;
                const json = buf.toString('utf8', pos, pos + strLen.value);
                finish(null, JSON.parse(json));
            } catch (e) {
                finish(new Error(`応答を解釈できません: ${e.message}`));
            }
        });
    });
}

module.exports = { pingJava };