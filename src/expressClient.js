// ============================================================
// Клиент Express Isource: получение списка открытых тендеров
// (статус TRADE — аукцион ещё идёт, ставка снижается).
//
// Авторизация — cookie + csrf-токен, скопированные вручную из
// DevTools (см. README). Сессия со временем истекает, токен нужно
// обновлять руками так же, как ATRUCKS_COOKIE.
// ============================================================

const config = require('./config');

async function fetchAllOrders() {
  const { baseUrl, cookie, csrfToken } = config.express;

  if (!cookie || !csrfToken) {
    throw new Error('Не заданы EXPRESS_COOKIE / EXPRESS_CSRF_TOKEN');
  }

  const limit = 50;
  let offset = 0;
  let totalCount = Infinity;
  const all = [];

  while (offset < totalCount) {
    const url =
      `${baseUrl}/api/v1/orderRequest/items?filter%5BcreateDateLimit%5D=PERIOD&limit=${limit}` +
      `&offset=${offset}&filter%5BtabStatus%5D%5B%5D=TRADE`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Auth-Token': csrfToken,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Express Isource API HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    totalCount = json.totalCount || 0;
    all.push(...(json.data || []));
    offset += limit;
  }

  return all;
}

module.exports = { fetchAllOrders };
