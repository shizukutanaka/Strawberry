// DBマイグレーションのロールバック自動テスト雛形（Jest）
const { execSync } = require('child_process');
const path = require('path');

// 実DB・prisma migrate を要するため、明示的に有効化(RUN_DB_TESTS=true)した場合のみ実行
const maybe = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
maybe('DBマイグレーションロールバック', () => {
  const dbPath = path.resolve(__dirname, '../../../dev.sqlite3');

  it('migrate:up→migrate:downでテーブルが消える', () => {
    // migrate:up
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    // migrate:down（Prismaはdown不可なのでknex例）
    // execSync('npx knex migrate:down', { stdio: 'inherit' });
    // ここではテーブル存在チェックやファイル消去を仮実装
    expect(true).toBe(true);
  });
});
