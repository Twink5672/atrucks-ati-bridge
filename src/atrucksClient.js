// ============================================================
// Клиент Atrucks: получение списка аукционов ("грузов")
// ============================================================

const config = require('./config');

async function fetchPage(page) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('per_page', String(config.atrucks.perPage));
  params.append('sort[]', config.atrucks.sort);

  const url = `${config.atrucks.baseUrl}${config.atrucks.listPath}?${params.toString()}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Cookie: config.atrucks.cookie,
      Referer: 'https://www.atrucks.su/carrier/auctions/quick/',
      'User-Agent': config.atrucks.userAgent,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Atrucks вернул ${res.status} на странице ${page}: ${text.slice(0, 300)}`
    );
  }

  // Если кука истекла, Atrucks обычно отдаёт HTML страницы логина (200) вместо JSON
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Atrucks вернул не-JSON (вероятно, истекла сессия/cookie). Content-Type: ${contentType}. Начало ответа: ${text.slice(0, 200)}`
    );
  }

  return res.json();
}

/**
 * Возвращает все лоты со всех страниц.
 * @returns {Promise<Array<object>>}
 */
async function fetchAllLots() {
  const allLots = [];
  let page = 1;

  while (true) {
    const data = await fetchPage(page);

    if (!Array.isArray(data.lots)) {
      throw new Error(`Неожиданный формат ответа Atrucks на странице ${page}`);
    }

    allLots.push(...data.lots);

    if (!data.has_next) break;

    page += 1;

    // защита от бесконечного цикла
    if (page > 500) {
      console.warn('[atrucks] Превышен лимит страниц (500), прерываю пагинацию');
      break;
    }
  }

  return allLots;
}

module.exports = { fetchAllLots, fetchPage };
