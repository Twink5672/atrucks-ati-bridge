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

  const headers = {
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
      };

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
      headers,
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

  return enrichOrdersWithCompetitors(all, headers, proxyAgent);
}

/**
 * Получает детали одного тендера по ID — там contractor виден полностью,
 * в отличие от списочного эндпоинта /items где contractor скрыт.
 */
async function fetchOrderDetail(orderId, headers, proxyAgent) {
  const { baseUrl } = config.express;
  const res = await fetch(`${baseUrl}/api/v1/orderRequest/${orderId}`, {
    method: 'GET',
    headers,
    ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
  }).catch(() => null);

  if (!res || !res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Для тендеров у которых есть lastOffer но скрыт contractor —
 * запрашивает детальный эндпоинт и подставляет имя конкурента.
 * Запросы идут параллельно пачками по 5 чтобы не перегружать сервер.
 */
async function enrichOrdersWithCompetitors(orders, headers, proxyAgent) {
  const needDetail = orders.filter(
    (o) => o.lastOffer && (!o.lastOffer.contractor || !o.lastOffer.contractor.name)
  );

  if (needDetail.length === 0) return orders;

  const CHUNK = 5;
  for (let i = 0; i < needDetail.length; i += CHUNK) {
    const chunk = needDetail.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (order) => {
        const detail = await fetchOrderDetail(order.id, headers, proxyAgent);
        if (detail && detail.lastOffer && detail.lastOffer.contractor) {
          order.lastOffer.contractor = detail.lastOffer.contractor;
        }
      })
    );
  }

  return orders;
}

/**
 * Настраивает автоторги (tradeBot) Express для конкретного тендера —
 * "Предельно мин. цена" и "Шаг снижения". Официальный встроенный
 * инструмент площадки (Express сам подаёт ставки в рамках заданных
 * границ), а не обход правил торгов. Тот же принцип двух режимов
 * (relay / напрямую), что и у fetchAllOrders.
 * @param {number} orderId — внутренний номер тендера (== order.id)
 * @param {number} minPrice — noVatMinPrice, предельная минимальная цена без НДС
 * @param {number|null} step — noVatPriceStep, шаг снижения без НДС; если не
 *   задан — берётся config.express.defaultTradeBotStep
 */
async function setTradeBot(orderId, minPrice, step) {
  if (config.express.relayUrl) {
    return setTradeBotViaRelay(orderId, minPrice, step);
  }
  return setTradeBotDirect(orderId, minPrice, step);
}

async function setTradeBotViaRelay(orderId, minPrice, step) {
  const { relayUrl, relaySecret } = config.express;

  const res = await fetch(`${relayUrl.replace(/\/$/, '')}/set-tradebot`, {
    method: 'POST',
    headers: {
      'X-Relay-Secret': relaySecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ orderId, minPrice, step }),
  }).catch((err) => {
    throw new Error(
      `Сетевая ошибка запроса к relay-серверу (${relayUrl}) при настройке автобота: ${err.message}${err.cause ? ` (cause: ${err.cause})` : ''}`
    );
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Relay-сервер вернул HTTP ${res.status} при настройке автобота: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Ошибка на стороне relay-сервера при настройке автобота: ${json.error}`);
  }

  return json;
}

async function setTradeBotDirect(orderId, minPrice, step) {
  const { baseUrl, cookie, csrfToken, proxyUrl, defaultTradeBotStep } = config.express;

  if (!cookie || !csrfToken) {
    throw new Error('Не заданы EXPRESS_COOKIE / EXPRESS_CSRF_TOKEN');
  }

  const url = `${baseUrl}/api/v1/orderRequest/${orderId}/tradeBot`;
  const body = {
    noVatMinPrice: minPrice,
    noVatPriceStep: step != null ? step : defaultTradeBotStep,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Cookie: cookie,
      Referer: `${baseUrl}/order/${orderId}/offers`,
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
    body: JSON.stringify(body),
    ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
  }).catch((err) => {
    const proxyNote = proxyUrl ? ' (через прокси)' : ' (без прокси)';
    throw new Error(
      `Сетевая ошибка настройки автобота Express${proxyNote}: ${err.message}${err.cause ? ` (cause: ${err.cause})` : ''}`
    );
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Express Isource API HTTP ${res.status} (tradeBot): ${text.slice(0, 300)}`);
  }

  return res.json().catch(() => ({}));
}

module.exports = { fetchAllOrders, setTradeBot };
