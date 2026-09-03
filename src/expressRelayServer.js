// ============================================================
// Relay-сервер для Express Isource.
//
// Запускается НЕ на Railway, а на домашнем/офисном компьютере с
// обычным (не датацентровым) интернетом — express.isource.ru
// блокирует датацентровые IP, включая Railway и обычные VPS (это
// проверено), но пропускает обычные подключения.
//
// Этот сервер сам обращается к Express Isource (используя те же
// EXPRESS_COOKIE/EXPRESS_CSRF_TOKEN) и отдаёт результат по HTTP —
// Railway достаёт его через туннель (см. README, раздел про
// Tailscale Funnel), вместо обращения к Express напрямую.
//
// Запуск (на домашнем/офисном компьютере, в этой же папке репозитория):
//   EXPRESS_COOKIE=... EXPRESS_CSRF_TOKEN=... EXPRESS_RELAY_SECRET=... \
//     node src/expressRelayServer.js
// (или через .env — config.js уже умеет его подхватывать)
//
// ВАЖНО: на этой машине НЕ нужно задавать EXPRESS_RELAY_URL — иначе
// fetchAllOrders() попытается обратиться сам к себе. Тут нужен именно
// прямой режим (см. expressClient.js: fetchAllOrdersDirect).
// ============================================================

const http = require('http');
const config = require('./config');
const { fetchAllOrders, setTradeBot } = require('./expressClient');

const PORT = Number(process.env.RELAY_PORT || 4000);
const SECRET = process.env.EXPRESS_RELAY_SECRET || config.express.relaySecret;

if (!SECRET) {
  console.error('ОШИБКА: не задан EXPRESS_RELAY_SECRET — relay-сервер не запущен.');
  process.exit(1);
}

if (config.express.relayUrl) {
  console.error(
    'ОШИБКА: на этой машине задан EXPRESS_RELAY_URL — это не нужно для самого ' +
      'relay-сервера (иначе он попробует обратиться сам к себе). Уберите эту переменную здесь.'
  );
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [Relay] ${msg}`);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const isFetchOrders = req.url === '/fetch-orders' && req.method === 'GET';
  const isSetTradeBot = req.url === '/set-tradebot' && req.method === 'POST';

  if (!isFetchOrders && !isSetTradeBot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const providedSecret = req.headers['x-relay-secret'];
  if (providedSecret !== SECRET) {
    log('Отклонён запрос с неверным/отсутствующим X-Relay-Secret');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (isFetchOrders) {
    try {
      log('Запрос данных у Express Isource...');
      const data = await fetchAllOrders();
      log(`Успешно: ${data.length} тендеров`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    } catch (err) {
      log(`ОШИБКА: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // isSetTradeBot
  try {
    const bodyText = await readRequestBody(req);
    const { orderId, minPrice, step } = JSON.parse(bodyText || '{}');
    log(`Настройка автобота: заказ №${orderId}, мин. цена ${minPrice}, шаг ${step}`);
    const result = await setTradeBot(orderId, minPrice, step);
    log(`Автобот настроен для заказа №${orderId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    log(`ОШИБКА настройки автобота: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  log(`Relay-сервер запущен на порту ${PORT}. Не забудьте пробросить его наружу (Tailscale Funnel).`);
});
