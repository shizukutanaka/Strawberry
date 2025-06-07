// p2p-sync.js - OrbitDBベースのP2P分散同期枠組み（orders/payments/gpus/health）
const IPFS = require('ipfs-core');
const OrbitDB = require('orbit-db');
const fs = require('fs');
const path = require('path');

const DB_NAMES = ['orders', 'payments', 'gpus', 'health'];
const LOCAL_DIR = path.join(__dirname);

const { restoreFromLatestBackup } = require('./utils/backup');
const { logger } = require('./utils/logger');

async function main() {
  const ipfs = await IPFS.create({
    config: { Bootstrap: [] }, // 明示的なピア探索も許可
    EXPERIMENTAL: { pubsub: true }
  });
  const orbitdb = await OrbitDB.createInstance(ipfs);

  for (const name of DB_NAMES) {
    const db = await orbitdb.keyvalue(name);
    await db.load();
    const localFile = path.join(LOCAL_DIR, `${name}.json`);
    // 1. ローカル破損時は自動リストア
    let localData = null;
    try {
      localData = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile)) : null;
    } catch (e) {
      logger.warn(`[SYNC] ${name} ローカルファイル破損: ${e.message}`);
      if (restoreFromLatestBackup(localFile)) {
        logger.info(`[SYNC] ${name} 最新バックアップから自動復元`);
        localData = JSON.parse(fs.readFileSync(localFile));
      } else {
        logger.error(`[SYNC] ${name} バックアップからも復元不可`);
      }
    }
    // 2. 分散DB→ローカル（常に最新を優先）
    db.events.on('replicated', () => {
      const all = db.all ? db.all : db._index;
      fs.writeFileSync(localFile, JSON.stringify(all, null, 2));
      logger.info(`[SYNC] ${name} replicated from OrbitDB`);
    });
    // 3. ローカル→分散DB（初回のみ/変更時）
    if (localData) {
      try {
        Object.keys(localData).forEach(key => db.put(key, localData[key]));
        logger.info(`[SYNC] ${name} loaded from local file`);
      } catch (e) { logger.error(`[SYNC] ${name} local load error: ${e.message}`); }
    }
    fs.watchFile(localFile, { interval: 5000 }, () => {
      try {
        const data = JSON.parse(fs.readFileSync(localFile));
        Object.keys(data).forEach(key => db.put(key, data[key]));
        logger.info(`[SYNC] ${name} updated from local file`);
      } catch (e) { logger.error(`[SYNC] ${name} local update error: ${e.message}`); }
    });
    // 4. ピア再探索・自己修復（定期的にピアリスト取得＆再接続）
    setInterval(async () => {
      try {
        const peers = await ipfs.swarm.peers();
        if (peers.length === 0) {
          logger.warn(`[SYNC] ${name} ピア接続なし、再探索`);
          await ipfs.swarm.connect('/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p-webrtc-star');
        }
      } catch (e) { logger.error(`[SYNC] ${name} ピア再探索失敗: ${e.message}`); }
    }, 60000);
  }

  logger.info('P2P分散同期（OrbitDB）本番耐障害モード起動完了');
}

if (require.main === module) {
  main();
}

module.exports = { main };
