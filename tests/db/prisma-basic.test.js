// Prisma DB基本動作テスト雛形（Jest）
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

describe('Prisma DB基本テスト', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('Userテーブルにinsert/getできる', async () => {
    const user = await prisma.user.create({ data: { email: 'test@example.com' } });
    const found = await prisma.user.findUnique({ where: { id: user.id } });
    expect(found.email).toBe('test@example.com');
    await prisma.user.delete({ where: { id: user.id } });
  });
});
