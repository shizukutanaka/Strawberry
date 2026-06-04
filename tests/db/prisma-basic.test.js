// Prisma DB基本動作テスト（@prisma/client + 稼働中DBが必要なため、未導入時はスキップ）
let PrismaClient = null;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (e) {
  // @prisma/client 未導入（generate未実行）の場合はスキップ
}

if (PrismaClient) {
  describe('Prisma DB基本テスト', () => {
    const prisma = new PrismaClient();
    afterAll(async () => { await prisma.$disconnect(); });

    it('Userテーブルにinsert/getできる', async () => {
      const user = await prisma.user.create({ data: { email: 'test@example.com' } });
      const found = await prisma.user.findUnique({ where: { id: user.id } });
      expect(found.email).toBe('test@example.com');
      await prisma.user.delete({ where: { id: user.id } });
    });
  });
} else {
  describe.skip('Prisma DB基本テスト (skipped: @prisma/client 未導入)', () => {
    it('requires `npm run prisma-generate` and a running database', () => {});
  });
}
