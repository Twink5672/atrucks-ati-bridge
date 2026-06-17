// ============================================================
// Клиент Express Isource: получение списка открытых тендеров
// (статус TRADE — аукцион ещё идёт, ставка снижается).
//
// Авторизация — cookie + csrf-токен, скопированные вручную из
// DevTools (см. README). Сессия со временем истекает, токен нужно
// обновлять руками так же, как ATRUCKS_COOKIE.
//
// express.isource.ru блокирует подключения с датацентровых IP (любых,
// не только зарубежных — проверено: не пропускает и российский VPS),
// пропускает только обычные подключения через провайдеров домашнего/
// мобильного интернета. Поэтому два режима получения данных:
//
//  1. RELAY (config.express.relayUrl задан) — реальный запрос к Express
//     выполняет отдельный маленький сервер (src/expressRelayServer.js),
//     запущенный на домашнем/офисном компьютере с обычным интернетом;
//     Railway просто запрашивает у него готовые данные через туннель
//     (например, Tailscale Funnel). Это основной рабочий режим.
//
//  2. PROXY (config.express.proxyUrl задан) — прямой запрос к Express
//     через HTTP(S)-прокси (ProxyAgent/undici). Оставлено на случай,
//     если в будущем появится резидентный прокси-сервис.
//
// Если ничего не задано — обычный прямой fetch (подходит для запуска
// этого же кода НА домашнем/офисном компьютере, см. expressRelayServer.js,
// где он используется как раз в этом режиме).
// ============================================================

const config = require('./config');
const { ProxyAgent } = require('undici');

let proxyAgent = null;
if (config.express.proxyUrl) {
  proxyAgent = new ProxyAgent(config.express.proxyUrl);
}

async function fetchAllOrders() {
  if (config.express.relayUrl) {
    return fetchAllOrdersViaRelay();
  }
  return fetchAllOrdersDirect();
}

/**
 * Запрашивает готовые данные у relay-сервера (см. expressRelayServer.js),
 * запущенного на машине с "нормальным" (не датацентровым) интернетом.
 */
async function fetchAllOrdersViaRelay() {
  const { relayUrl, relaySecret } = config.express;

  const res = await fetch(`${relayUrl.replace(/\/$/, '')}/fetch-orders`, {
    method: 'GET',
    headers: { 'X-Relay-Secret': relaySecret },
  }).catch((err) => {
    throw new Error(
      `Сетевая ошибка запроса к relay-серверу (${relayUrl}): ${err.message}${err.cause ? ` (cause: ${err.cause})` : ''}`
    );
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Relay-сервер вернул HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Ошибка на стороне relay-сервера: ${json.error}`);
  }

  return json.data || [];
}

/**
 * Прямой запрос к Express Isource (опционально через ProxyAgent, если
 * задан config.express.proxyUrl). Используется, когда этот код
 * запускается на машине с "нормальным" интернетом (relay-сервер), либо
 * если задан резидентный прокси.
 */
async function fetchAllOrdersDirect() {
  const { baseUrl, cookie, csrfToken, proxyUrl } = config.express;

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
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'max-age=0',
        Cookie: cookie,
        Referer: `${baseUrl}/order/list/offers`,
        'Sec-Ch-Ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'X-Auth-Token': csrfToken,
      },
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    }).catch((err) => {
      const proxyNote = proxyUrl ? ' (через прокси)' : ' (без прокси)';
      throw new Error(
        `Сетевая ошибка запроса к Express Isource${proxyNote}: ${err.message}${err.cause ? ` (cause: ${err.cause})` : ''}`
      );
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
