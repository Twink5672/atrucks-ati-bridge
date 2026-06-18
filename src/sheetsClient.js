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

const LOGISTS_RANGE = (sheet) => `'${sheet}'!A2:D`;

// Индексы в массиве значений строки (0-based), одинаковы на всех вкладках
const IDX = {
  CLIENT: 2, // C
  ATI_CARGO_ID: 17, // R
  EXT_ID: 20, // U
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
 * и что на ней проставлены заголовок (A1:U1) и формула подбора логиста
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
      range: `'${title}'!A1:U1`,
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
          `=ARRAYFORMULA(IF(C2:C="", "", IFERROR(VLOOKUP(C2:C, '${logistsSheetName}'!A:D, 2, FALSE), "не найден")))`,
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

  const ranges = tabNames.map((name) => `'${name}'!A2:U`);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });

  const byExtId = new Map();
  const lastRowByTab = new Map(tabNames.map((name) => [name, 1]));

  (res.data.valueRanges || []).forEach((valueRange, tabIdx) => {
    const tabName = tabNames[tabIdx];
    const rows = valueRange.values || [];

    rows.forEach((row, idx) => {
      const extId = row[IDX.EXT_ID];
      if (!extId) return;
      const rowNumber = idx + 2;
      byExtId.set(String(extId), {
        tabName,
        rowNumber,
        clientName: row[IDX.CLIENT] || '',
        atiCargoId: row[IDX.ATI_CARGO_ID] || '',
      });
      lastRowByTab.set(tabName, Math.max(lastRowByTab.get(tabName), rowNumber));
    });
  });

  return { byExtId, lastRowByTab };
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
    map.set(clientName, {
      logistName: (row[1] || '').trim(),
      token: row[2] || '',
      contactId: row[3] || '',
    });
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
      range: `'${sheet}'!E${row}:L${row}`,
      values: [
        [
          lot.from,
          lot.loadDate ?? '',
          lot.to,
          lot.unloadDate ?? '',
          lot.cargoName,
          lot.weight ?? '',
          lot.volume ?? '',
          lot.bodyTypeText,
        ],
      ],
    });
    data.push({
      range: `'${sheet}'!M${row}:Q${row}`,
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
      range: `'${sheet}'!S${row}:U${row}`,
      values: [[lot.bodyJson, updatedAt, lot.extId]],
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
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

module.exports = {
  ensureTabs,
  readAllLotsIndex,
  readLogistsMap,
  writeLots,
  deleteLotRows,
};
