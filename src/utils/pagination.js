// ?limit=&offset= の解釈を一元化。limit は 1..maxLimit にクランプ
// （不正値は defaultLimit）、offset は 0 以上・maxOffset 指定時は上限あり。
function parsePagination(query, { maxLimit = 200, defaultLimit = 50, maxOffset = null } = {}) {
  const limitRaw = parseInt(query.limit, 10);
  const offsetRaw = parseInt(query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), maxLimit) : defaultLimit;
  let offset = 0;
  if (Number.isFinite(offsetRaw) && offsetRaw >= 0) {
    offset = maxOffset === null ? offsetRaw : Math.min(offsetRaw, maxOffset);
  }
  return { limit, offset };
}

module.exports = { parsePagination };
