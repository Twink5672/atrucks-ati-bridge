// ============================================================
// Конфигурация сервиса Atrucks -> ATI.SU
// Все секреты берутся из переменных окружения (Railway)
// ============================================================

// Локальный запуск: подхватываем .env без внешних зависимостей
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
} catch (_) {
  // игнорируем — на Railway переменные приходят напрямую
}

module.exports = {
  // --- Atrucks ---
  atrucks: {
    baseUrl: 'https://www.atrucks.su',
    listPath: '/carrier/auctions/lots/general/quick/',
    perPage: 100,
    sort: '-destinations',
    // Кука авторизации копируется из DevTools (см. инструкцию в README)
    cookie: process.env.ATRUCKS_COOKIE || '',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  },

  // --- ATI.SU ---
  ati: {
    apiBase: 'https://api.ati.su',
    loadsBase: 'https://loads.ati.su',
    token: process.env.ATI_TOKEN || '2be9c4b812e045e6a7e6b117e88fb8ee',
    firmId: process.env.ATI_FIRM_ID || '701329',
    contactId: Number(process.env.ATI_CONTACT_ID || 148),
    currencyType: 1,
    // UUID "доски" публикации (как в существующей системе)
    boardId: process.env.ATI_BOARD_ID || 'a0a0a0a0a0a0a0a0a0a0a0a0',
    // Дефолтный тип кузова, если не удалось распознать (200 = тент)
    defaultBodyType: 200,
  },

  // --- Бизнес-логика ---
  pricing: {
    // start_price на Atrucks — сумма с НДС 22%.
    // rate (без НДС) = (start_price / vatDivider) * factor
    // rate_with_vat = rate * vatDivider
    factor: 0.85, // скидка 15% от суммы без НДС
    vatDivider: 1.22,
  },

  // --- Расписание / прочее ---
  schedule: {
    // Интервал опроса, в минутах
    intervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES || 10),
  },

  // --- БД ---
  db: {
    // Путь к файлу SQLite на volume Railway
    path: process.env.DB_PATH || '/data/atrucks-ati.sqlite',
  },

  // --- Google Sheets ---
  // Лоты теперь не публикуются на ATI автоматически — сервис только
  // пишет их в Google-таблицу. Публикация на ATI — вручную, кнопкой
  // в Apps Script внутри самой таблицы (см. AtrucksSheetPublish.gs).
  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID || '',
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    // Приватный ключ из JSON сервис-аккаунта. На Railway удобнее хранить
    // в одну строку с буквальными "\n" — ниже они разворачиваются обратно.
    serviceAccountPrivateKey: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(
      /\\n/g,
      '\n'
    ),
    lotsSheetName: process.env.GOOGLE_SHEET_LOTS_TAB || 'Лоты Atrucks',
    logistsSheetName: process.env.GOOGLE_SHEET_LOGISTS_TAB || 'Логисты',
  },
};
