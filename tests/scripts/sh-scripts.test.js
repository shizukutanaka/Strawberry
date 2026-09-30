// scripts/*.sh の構文・振る舞いガード。
// 旧 stub は shebang+コメントのみで exit 0 していて、呼び出し側（CI/手動運用）が
// 「成功したが何も起きなかった」と誤認する構造だった。実装後の回帰を防ぐ。
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const shScripts = ['build.sh', 'setup-production.sh', 'deploy.sh'];

describe('scripts/*.sh', () => {
  for (const name of shScripts) {
    it(`${name} は bash -n の構文検査を通過し set -euo pipefail を使う`, () => {
      const p = path.join(SCRIPTS_DIR, name);
      execFileSync('bash', ['-n', p]);
      const text = fs.readFileSync(p, 'utf8');
      expect(text).toContain('set -euo pipefail');
    });
  }

  it('deploy.sh はデプロイ経路未構成を説明して exit 1 で失敗する（無言成功を防ぐ）', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(SCRIPTS_DIR, 'deploy.sh')], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      stderr = e.stderr;
    }
    expect(code).toBe(1);
    expect(stderr).toContain('未構成');
  });

  it('setup-production.sh --check は必須シークレット未設定で exit 1、設定済みで exit 0', () => {
    const script = path.join(SCRIPTS_DIR, 'setup-production.sh');
    const env = { ...process.env, PATH: process.env.PATH };
    delete env.JWT_SECRET;
    delete env.SESSION_SECRET;
    delete env.ENCRYPTION_KEY;

    let code = 0;
    try {
      execFileSync('bash', [script, '--check'], { env, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = e.status;
    }
    expect(code).toBe(1);

    const ok = execFileSync('bash', [script, '--check'], {
      env: {
        ...env,
        JWT_SECRET: 'a'.repeat(32),
        SESSION_SECRET: 'b'.repeat(16),
        ENCRYPTION_KEY: 'c'.repeat(16),
      },
      encoding: 'utf8',
    });
    expect(ok).toContain('preflight OK');
  });
});
