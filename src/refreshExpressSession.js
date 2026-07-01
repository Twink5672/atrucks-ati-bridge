// ============================================================
// Быстрое обновление сессии Express Isource без похода в DevTools.
//
// Открывает настоящий Chromium (через Playwright), вы входите в
// express.isource.ru как обычно (включая капчу — это защита именно
// от автоматизации логина, обходить её скрипт не пытается). После
// входа скрипт перехватывает РЕАЛЬНЫЕ заголовки Cookie и X-Auth-Token
// из настоящего запроса браузера к /orderRequest/items и сам
// записывает их в .env — взамен ручного копирования из DevTools.
//
// Разовая подготовка (один раз на этом компьютере):
//   npm install --save-dev playwright
//   npx playwright install chromium
//
// Запуск при истечении сессии (когда relay-сервер начинает
// получать HTTP 403 от Express Isource):
//   node src/refreshExpressSession.js
//
// После завершения — перезапустите relay-сервер (Ctrl+C, затем
// снова node src/expressRelayServer.js), чтобы он подхватил .env.
// ============================================================

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const LOGIN_URL = 'https://express.isource.ru/order/list/offers';
const TARGET_URL_PART = 'orderRequest/items';

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.error(
      'Не найден пакет "playwright". Установите его один раз:\n' +
        '  npm install --save-dev playwright\n' +
        '  npx playwright install chromium'
    );
    process.exit(1);
  }

  console.log('Открываю браузер...');
  console.log('Войдите в свой аккаунт Express Isource как обычно (логин, пароль, капча).');
  console.log(
    'После входа откройте раздел "Заказы" -> вкладку "Сбор предложений" (или просто ' +
      'дождитесь загрузки списка) — скрипт сам поймает нужный запрос, ничего больше нажимать не нужно.'
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const captured = new Promise((resolve) => {
    page.on('request', (req) => {
      if (!req.url().includes(TARGET_URL_PART)) return;
      const headers = req.headers();
      const cookie = headers['cookie'];
      const token = headers['x-auth-token'];
      if (cookie && token && cookie.includes('session-cookie=')) {
        resolve({ cookie, token });
      }
    });
  });

  await page.goto(LOGIN_URL);

  const result = await captured;
  console.log('Поймал свежие cookie и токен из настоящего запроса браузера.');

  await browser.close();

  updateEnvFile(result.cookie, result.token);
  console.log(`Готово: .env обновлён (${ENV_PATH}).`);
  console.log(
    'Перезапустите relay-сервер: Ctrl+C в его окне, затем снова node src/expressRelayServer.js'
  );
}

function updateEnvFile(cookie, token) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  content = setEnvVar(content, 'EXPRESS_COOKIE', cookie);
  content = setEnvVar(content, 'EXPRESS_CSRF_TOKEN', token);
  fs.writeFileSync(ENV_PATH, content);
}

function setEnvVar(content, key, value) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  const withTrailingNewline = content === '' || content.endsWith('\n') ? content : `${content}\n`;
  return `${withTrailingNewline}${line}\n`;
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
