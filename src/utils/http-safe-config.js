// 外向き axios 呼び出しの共通安全設定。
// `axios.<verb>(url, data, { ...AXIOS_SAFE_CONFIG, headers })` のように
// 展開して使う（渡す config オブジェクト自体は上書きされるため）。
//
// - timeout: 応答・接続の滞留を 10 秒で打ち切る（既定は無制限で、
//   相手の半開きソケットに呼び出し側が永久に張り付く）
// - maxContentLength / maxBodyLength: レスポンス/リクエストボディを 1 MiB に
//   制限（巨大ボディによるメモリ圧迫を遮断）
// - maxRedirects: 0: SSRF ガード（ssrf-guard.js / notifier の URL 検証）を
//   通過した URL が 30x で内部アドレス（127.0.0.1、169.254.169.254 の
//   クラウドメタデータ等）へ誘導する迂回を塞ぐ。Webhook 系の正常系は
//   2xx を直接返すためリダイレクト追従は不要。
const AXIOS_SAFE_CONFIG = Object.freeze({
  timeout: 10_000,
  maxContentLength: 1_048_576,
  maxBodyLength: 1_048_576,
  maxRedirects: 0,
});

module.exports = { AXIOS_SAFE_CONFIG };
