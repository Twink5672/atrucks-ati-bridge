// ============================================================
// Клиент Google Sheets: чтение справочника "Логисты" и
// запись/чтение вкладок с лотами — теперь одна вкладка на каждого
// логиста (название вкладки = "ФИО логиста" из листа "Логисты"),
// плюс вкладка-корзина "Без логиста" для клиентов без привязки.
//
// Использует сервис-аккаунт Google (JWT). Таблицу нужно расшарить
// на e-mail сервис-аккаунта с правами Редактор.
//
// Структура каждой вкладки с лотами (columns A..U) — одинаковая
// на всех вкладках:
//   A Статус             — пишет Apps Script после попытки публикации
//   B Внутренний номер    — номер лота на Atrucks (lot.id)
//   C Клиент
//   D Логист             — ARRAYFORMULA, Node не пишет
//   E Откуда
//   F Дата погрузки
//   G Куда
//   H Дата выгрузки
//   I Груз
//   J Вес
//   K Объём
//   L Тип кузова
//   M Ставка клиента без НДС   (как есть на Atrucks, без скидки)
//   N Ставка клиента с НДС
//   O Ставка перевозчика без НДС (со скидкой — то, что идёт на ATI)
//   P Ставка перевозчика с НДС
//   Q Маржа              = M - O
//   R ATI_cargo_id        — пишет Apps Script после публикации
//   S ATI_Body_JSON       — технический, для кнопки публикации
//   T Обновлено
//   U ext_id              — технический ключ, в самом конце
//
// Структура листа "Логисты" (columns A..D):
//   A Клиент, B ФИО логиста (= название вкладки), C Токен ATI, D Contact ID ATI
// ============================================================

const { google } = require('googleapis');
const config = require('./config');

const LOGISTS_RANGE = (sheet) => `'${sheet}'!A2:E`;

// Индексы в массиве значений строки (0-based), одинаковы на всех вкладках
const IDX = {
  CLIENT: 2, // C
  ATI_CARGO_ID: 20, // U
  EXT_ID: 23, // X
};

const HEADER_ROW = [
  'Статус',
  'Внутренний номер',
  'Клиент',
  'Логист',
  'Откуда',
  'Дата погрузки',
  'Куда',
  'Дата выгрузки',
  'Торги до',
  'Конкурент',
  'Ставка конкурента',
  'Груз',
  'Вес',
  'Объём',
  'Тип кузова',
  'Ставка клиента без НДС',
  'Ставка клиента с НДС',
  'Ставка перевозчика без НДС',
  'Ставка перевозчика с НДС',
  'Маржа',
  'ATI_cargo_id',
  'ATI_Body_JSON',
  'Обновлено',
  'ext_id',
];

let sheetsApiPromise = null;

function getSheetsApi() {
  if (!sheetsApiPromise) {
    const { serviceAccountEmail, serviceAccountPrivateKey } = config.googleSheets;
    if (!serviceAccountEmail || !serviceAccountPrivateKey) {
      throw new Error(
        'Не заданы GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
      );
    }
    const auth = new google.auth.JWT({
      email: serviceAccountEmail,
      key: serviceAccountPrivateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsApiPromise = google.sheets({ version: 'v4', auth });
  }
  return sheetsApiPromise;
}

/**
 * Убеждается, что для каждого имени из tabNames есть вкладка в таблице,
 * и что на ней проставлены заголовок (A1:X1) и формула подбора логиста
 * (D2). Чинит это не только для новых вкладок, но и для уже
 * существующих, если там вдруг пусто (например, вкладка была создана
 * вручную или осталась от старой версии).
 * @param {string[]} tabNames
 * @returns {Promise<Map<string, number>>} название вкладки -> sheetId
 */
async function ensureTabs(tabNames) {
  const sheets = getSheetsApi();
  const { spreadsheetId, logistsSheetName } = config.googleSheets;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const existing = new Map(
    meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId])
  );

  const missing = tabNames.filter((name) => !existing.has(name));

  if (missing.length > 0) {
    const addRequests = missing.map((title) => ({ addSheet: { properties: { title } } }));
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: addRequests },
    });
    addRes.data.replies.forEach((reply, i) => {
      existing.set(missing[i], reply.addSheet.properties.sheetId);
    });
  }

  // Проверяем шапку (A1) и формулу (D2) на ВСЕХ нужных вкладках, не
  // только на только что созданных — чинит вкладки, оставшиеся пустыми
  // по любой другой причине.
  const checkRanges = tabNames.map((title) => `'${title}'!A1:D2`);
  const checkRes = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: checkRanges,
  });

  const needsHeader = [];
  const needsFormula = [];
  (checkRes.data.valueRanges || []).forEach((valueRange, idx) => {
    const title = tabNames[idx];
    const values = valueRange.values || [];
    const a1 = values[0] && values[0][0];
    const d2 = values[1] && values[1][3];
    const d2IsBroken = !d2 || String(d2).trim().startsWith('#');
    if (!a1) needsHeader.push(title);
    if (d2IsBroken) needsFormula.push(title);
  });

  if (needsHeader.length > 0) {
    const headerData = needsHeader.map((title) => ({
      range: `'${title}'!A1:X1`,
      values: [HEADER_ROW],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: headerData },
    });
  }

  if (needsFormula.length > 0) {
    const formulaData = needsFormula.map((title) => ({
      range: `'${title}'!D2`,
      values: [
        [
          `=ARRAYFORMULA(IF(C2:C="";"";IFERROR(VLOOKUP(C2:C;'${logistsSheetName}'!A:D;2;FALSE);"не найден")))`,
        ],
      ],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: formulaData },
    });
  }

  return existing;
}

/**
 * Читает все указанные вкладки одним запросом (batchGet).
 * @param {string[]} tabNames
 * @returns {Promise<{
 *   byExtId: Map<string, {tabName:string, rowNumber:number, clientName:string, atiCargoId:string}>,
 *   lastRowByTab: Map<string, number>
 * }>}
 */
async function readAllLotsIndex(tabNames) {
  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  const ranges = tabNames.map((name) => `'${name}'!A2:X`);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });

  const byExtId = new Map();
  const lastRowByTab = new Map(tabNames.map((name) => [name, 1]));
  // Защита от дублей: если один и тот же ext_id встречается в
  // нескольких строках (обычно след старого сбоя синхронизации),
  // вторую и последующие копии собираем сюда — их данные не участвуют
  // в индексе (последняя встреченная копия побеждает, как и раньше),
  // а сами строки затем безопасно очищаются вызывающим кодом.
  const duplicateRows = [];

  (res.data.valueRanges || []).forEach((valueRange, tabIdx) => {
    const tabName = tabNames[tabIdx];
    const rows = valueRange.values || [];

    rows.forEach((row, idx) => {
      const extId = row[IDX.EXT_ID];
      if (!extId) return;
      const rowNumber = idx + 2;
      const key = String(extId);
      if (byExtId.has(key)) {
        const previous = byExtId.get(key);
        duplicateRows.push({ tabName: previous.tabName, rowNumber: previous.rowNumber });
      }
      byExtId.set(key, {
        tabName,
        rowNumber,
        clientName: row[IDX.CLIENT] || '',
        atiCargoId: row[IDX.ATI_CARGO_ID] || '',
      });
      lastRowByTab.set(tabName, Math.max(lastRowByTab.get(tabName), rowNumber));
    });
  });

  return { byExtId, lastRowByTab, duplicateRows };
}

/**
 * Парсит коэффициент ставки перевозчика из ячейки (например "0,65"
 * или "0.65" = маржа 35%). Возвращает null, если ячейка пустая или
 * значение вне допустимого диапазона (0; 1].
 */
function parsePricingCoefficient(raw) {
  const rawCoeff = raw ? String(raw).trim().replace(',', '.') : '';
  const parsed = rawCoeff ? parseFloat(rawCoeff) : NaN;
  return !Number.isNaN(parsed) && parsed > 0 && parsed <= 1 ? parsed : null;
}

/**
 * Читает справочник "Логисты".
 * @returns {Promise<Map<string, {logistName:string, token:string, contactId:string}>>}
 */
async function readLogistsMap() {
  const sheets = getSheetsApi();
  const { spreadsheetId, logistsSheetName } = config.googleSheets;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: LOGISTS_RANGE(logistsSheetName),
  });

  const rows = res.data.values || [];
  const map = new Map();

  rows.forEach((row) => {
    const clientName = (row[0] || '').trim();
    if (!clientName) return;
    // Колонка E — индивидуальный коэффициент ставки перевозчика по
    // клиенту (например, 0.95 = скидка 5%, 0.85 = скидка 15%). Если не
    // задана или не число — используется дефолт из config. Имейте в
    // виду: лист "Маржа по листам" (readTabMarginsMap) имеет приоритет
    // над этим значением, если для целевой вкладки задан свой коэффициент.
    const pricingFactor = parsePricingCoefficient(row[4]) ?? config.pricing.factor;
    map.set(clientName, {
      logistName: (row[1] || '').trim(),
      token: row[2] || '',
      contactId: row[3] || '',
      pricingFactor,
    });
  });

  return map;
}

const TAB_MARGINS_SHEET_NAME = 'Маржа по листам';
const TAB_MARGINS_RANGE = (sheet) => `'${sheet}'!A2:B`;

/**
 * Читает лист "Маржа по листам" — коэффициент ставки перевозчика,
 * заданный НЕ по клиенту, а по конкретной целевой вкладке (название
 * вкладки логиста или спецвкладки вроде "Газпромнефть-Снабжение Трал").
 * Имеет приоритет над колонкой E листа "Логисты" (per-client), когда
 * для этой вкладки явно задано значение.
 *
 * Формат листа: колонка A — точное название вкладки, колонка B —
 * коэффициент (0.65 = маржа 35%), одна строка на вкладку.
 *
 * Если лист ещё не создан — это нормально, просто нет спецнастроек по
 * вкладкам, возвращается пустая карта (без ошибки).
 * @returns {Promise<Map<string, number>>} название вкладки -> коэффициент
 */
async function readTabMarginsMap() {
  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: TAB_MARGINS_RANGE(TAB_MARGINS_SHEET_NAME),
    });
  } catch (err) {
    return new Map();
  }

  const rows = res.data.values || [];
  const map = new Map();

  rows.forEach((row) => {
    const tabName = (row[0] || '').trim();
    if (!tabName) return;
    const factor = parsePricingCoefficient(row[1]);
    if (factor != null) map.set(tabName, factor);
  });

  return map;
}

/**
 * Записывает/обновляет пачку лотов одним запросом batchUpdate.
 * Каждый лот уже несёт своё целевое tabName и конкретный row (вызывающий
 * код сам решает, новая это строка или существующая).
 * Никогда не трогает колонки A (Статус), D (Логист), R (ATI_cargo_id).
 *
 * @param {Array<{
 *   tabName: string, row: number,
 *   extId: string, internalNumber: string|number, clientName: string,
 *   from: string, to: string, cargoName: string,
 *   weight: string|number, volume: string|number, bodyTypeText: string,
 *   clientRateNoVat: string|number, clientRateWithVat: string|number,
 *   carrierRateNoVat: string|number, carrierRateWithVat: string|number,
 *   margin: string|number,
 *   loadDate: string, unloadDate: string,
 *   bodyJson: string,
 * }>} lots
 */
async function writeLots(lots) {
  if (lots.length === 0) return;

  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;
  const updatedAt = new Date().toISOString();

  const data = [];

  for (const lot of lots) {
    const sheet = lot.tabName;
    const row = lot.row;

    data.push({
      range: `'${sheet}'!B${row}:C${row}`,
      values: [[lot.internalNumber ?? '', lot.clientName]],
    });
    data.push({
      range: `'${sheet}'!E${row}:O${row}`,
      values: [
        [
          lot.from,
          lot.loadDate ?? '',
          lot.to,
          lot.unloadDate ?? '',
          lot.tradeCloseAt ?? '',
          lot.competitor ?? '',
          lot.competitorRate ?? '',
          lot.cargoName,
          lot.weight ?? '',
          lot.volume ?? '',
          lot.bodyTypeText,
        ],
      ],
    });
    data.push({
      range: `'${sheet}'!P${row}:T${row}`,
      values: [
        [
          lot.clientRateNoVat ?? '',
          lot.clientRateWithVat ?? '',
          lot.carrierRateNoVat ?? '',
          lot.carrierRateWithVat ?? '',
          lot.margin ?? '',
        ],
      ],
    });
    data.push({
      range: `'${sheet}'!V${row}:X${row}`,
      values: [[lot.bodyJson, updatedAt, lot.extId]],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

/**
 * Безопасно очищает содержимое указанных строк, НЕ удаляя сами строки
 * (то есть без сдвига номеров строк ниже) — используется для дублей
 * ext_id (см. readAllLotsIndex), чтобы не пересчитывать номера строк
 * в середине уже идущего цикла. Колонку D не трогает — там формула
 * ARRAYFORMULA подбора логиста, растянутая с D2 на весь столбец;
 * попытка очистить отдельную "вылившуюся" ячейку сломала бы её.
 * @param {Array<{tabName: string, rowNumber: number}>} rows
 */
async function clearRows(rows) {
  if (rows.length === 0) return;

  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  const ranges = rows.flatMap(({ tabName, rowNumber }) => [
    `'${tabName}'!A${rowNumber}:C${rowNumber}`,
    `'${tabName}'!E${rowNumber}:X${rowNumber}`,
  ]);

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges },
  });
}

/**
 * Удаляет указанные строки (лоты, пропавшие с Atrucks, либо переехавшие
 * на другую вкладку логиста — старая строка тоже удаляется).
 * @param {Array<{tabName: string, rowNumber: number}>} deletions
 */
async function deleteLotRows(deletions) {
  if (deletions.length === 0) return;

  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const sheetIdByTitle = new Map(
    meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId])
  );

  const rowsByTab = new Map();
  deletions.forEach(({ tabName, rowNumber }) => {
    if (!rowsByTab.has(tabName)) rowsByTab.set(tabName, []);
    rowsByTab.get(tabName).push(rowNumber);
  });

  const requests = [];
  rowsByTab.forEach((rows, tabName) => {
    const sheetId = sheetIdByTitle.get(tabName);
    if (sheetId == null) return; // вкладку, видимо, удалили руками — пропускаем

    // Удаляем от последней строки к первой (в рамках вкладки), чтобы
    // индексы не сдвигались.
    [...rows]
      .sort((a, b) => b - a)
      .forEach((rowNumber) => {
        requests.push({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        });
      });
  });

  if (requests.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// ============================================================
// Архив закрытых тендеров (append-only лог — используется для
// статистики: конкуренты, их ставки, направления по правилу
// "Газпромнефть-Снабжение + Трал", см. syncExpress.js).
// ============================================================

const ARCHIVE_HEADER_ROW = [
  'Дата архивации',
  'Итог',
  'Внутренний номер',
  'Откуда',
  'Куда',
  'Дата погрузки',
  'Дата выгрузки',
  'Конкурент',
  'Ставка конкурента',
  'Груз',
  'Вес',
  'Объём',
  'Тип кузова',
  'Ставка клиента без НДС',
  'Ставка клиента с НДС',
  'Ставка перевозчика без НДС',
  'Ставка перевозчика с НДС',
  'Маржа',
  'ATI_cargo_id',
  'ext_id',
];

/**
 * Создаёт лист-архив с заголовком, если его ещё нет. Ничего не делает,
 * если лист уже существует (в т.ч. если заголовок кто-то поменял руками —
 * архив не трогает уже существующие данные).
 */
async function ensureArchiveSheet(sheetName) {
  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const exists = meta.data.sheets.some((s) => s.properties.title === sheetName);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A1:T1`,
    valueInputOption: 'RAW',
    requestBody: { values: [ARCHIVE_HEADER_ROW] },
  });
}

/**
 * Дописывает строки в конец листа-архива (создаёт лист при
 * необходимости). Использует Sheets API values.append — сам находит
 * первую свободную строку, накопление идёт бесконечно вниз.
 * @param {string} sheetName
 * @param {Array<Array<string|number>>} rows — строки в порядке ARCHIVE_HEADER_ROW
 */
async function appendArchiveRows(sheetName, rows) {
  if (rows.length === 0) return;

  await ensureArchiveSheet(sheetName);

  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * Читает все значения одной строки (A..X) с рабочей вкладки — нужно
 * для снятия "снимка" данных лота перед архивацией и удалением строки.
 */
async function readRowValues(tabName, rowNumber) {
  const sheets = getSheetsApi();
  const { spreadsheetId } = config.googleSheets;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A${rowNumber}:X${rowNumber}`,
  });

  return (res.data.values && res.data.values[0]) || [];
}

module.exports = {
  ensureTabs,
  readAllLotsIndex,
  readLogistsMap,
  readTabMarginsMap,
  writeLots,
  deleteLotRows,
  clearRows,
  appendArchiveRows,
  readRowValues,
};
