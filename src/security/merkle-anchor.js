// src/security/merkle-anchor.js
// 監査ログの Merkle アンカリング（docs/SPECIFICATION.md §6 / カテゴリ10・§18）。
// 監査ログ(audit.js は HMAC 連鎖で tamper-evident だが外部アンカー無し)のエントリ集合を
// Merkle 木に集約し、root を OpenTimestamps 等の公開タイムスタンプへアンカーすることで
// 運営自身による改ざん・遡及も第三者が否認できる「非否認性」を確立する。
// 純関数・依存は crypto のみ。second-preimage 対策にドメイン分離プレフィクスを付与。
const crypto = require('crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// 0x00 = 葉, 0x01 = 内部ノード（ドメイン分離）
function leafHash(data) {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(s, 'utf8')]));
}
function nodeHash(a, b) {
  return sha256(Buffer.concat([Buffer.from([0x01]), a, b]));
}

function buildLevels(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array');
  }
  let level = entries.map(leafHash);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // 奇数なら末尾を複製
      next.push(nodeHash(left, right));
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

/** エントリ集合の Merkle root（hex）。 */
function merkleRoot(entries) {
  const levels = buildLevels(entries);
  return levels[levels.length - 1][0].toString('hex');
}

/**
 * index 番目のエントリの包含証明。
 * @returns {Array<{hash:string, position:'left'|'right'}>} position は兄弟ノードの側
 */
function merkleProof(entries, index) {
  const levels = buildLevels(entries);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error('index out of range');
  }
  const proof = [];
  let idx = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const level = levels[lvl];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = sibIdx < level.length ? level[sibIdx] : level[idx]; // 兄弟が無ければ自分を複製
    proof.push({ hash: sibling.toString('hex'), position: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** 葉データ＋包含証明から root を再計算し、与えられた root と一致するか検証。 */
function verifyProof(leafData, proof, rootHex) {
  if (!Array.isArray(proof)) throw new Error('proof must be an array');
  let h = leafHash(leafData);
  for (const step of proof) {
    const sib = Buffer.from(step.hash, 'hex');
    h = step.position === 'left' ? nodeHash(sib, h) : nodeHash(h, sib);
  }
  return h.toString('hex') === rootHex;
}

/**
 * 公開タイムスタンプ(OpenTimestamps 等)へ提出するアンカー・ダイジェストを生成。
 * @returns {{algorithm:string, root:string, count:number, createdAt:string}}
 */
function buildAnchor(entries, { now = () => new Date().toISOString() } = {}) {
  return {
    algorithm: 'sha256-merkle-v1',
    root: merkleRoot(entries),
    count: entries.length,
    createdAt: now(),
  };
}

module.exports = { merkleRoot, merkleProof, verifyProof, buildAnchor, leafHash };
