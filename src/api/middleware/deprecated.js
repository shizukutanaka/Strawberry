// src/api/middleware/deprecated.js — RFC 9745 Deprecation レスポンスヘッダー。
// 非推奨ルートへ `Deprecation: @<unix秒>`（Item Structured Header、日付必須）と
// `Link: <後継>; rel="successor-version"` を付与し、クライアントが本文やログ警告に
// 頼らず非推奨を機械判別できるようにする。successor-version は IANA 登録済みの
// link relation で「このリソースの後継版」を示す。
// 日付は 2025-06-05（初期 scaffold 以来これらのパススルーが非推奨扱いだった起点）。
const DEPRECATED_SINCE = '@1749072000';

function deprecated(successorPath) {
  return (req, res, next) => {
    res.set('Deprecation', DEPRECATED_SINCE);
    res.set('Link', `<${successorPath}>; rel="successor-version"`);
    next();
  };
}

module.exports = { deprecated, DEPRECATED_SINCE };
