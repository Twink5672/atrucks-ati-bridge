// ============================================================
// Клиент Google Sheets: чтение справочника "Логисты" и
// запись/чтение листа "Лоты Atrucks".
//
// Использует сервис-аккаунт Google (JWT). Таблицу нужно расшарить
// на e-mail сервис-аккаунта с правами Редактор.
//
// Структура листа "Лоты Atrucks" (columns A..U):
//   A Статус             — пишет Apps Script после попытки публикации
//   B Внутренний номер    — номер лота на Atrucks (lot.id)
//   C Клиент
//   D Логист             — ARRAYFORMULA в таблице, Node не пишет
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
//   A Клиент, B ФИО логиста, C Токен ATI, D Contact ID ATI
// ============================================================

const { google } = require('googleapis');
const config = require('./config');

const LOTS_RANGE_FULL = (sheet) => `'${sheet}'!A2:U`;
const LOGISTS_RANGE = (sheet) => `'${sheet}'!A2:D`;

// Индексы в массиве значений строки (0-based)
const IDX = {
  CLIENT: 2, // C
  ATI_CARGO_ID: 17, // R
  EXT_ID: 20, // U
};

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
 * Читает лист "Лоты Atrucks" целиком.
 * @returns {Promise<{ byExtId: Map<string, {rowNumber:number, clientName:string, atiCargoId:string}>, lastRow: number }>}
 */
async function readLotsIndex() {
  const sheets = getSheetsApi();
  const { spreadsheetId, lotsSheetName } = config.googleSheets;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: LOTS_RANGE_FULL(lotsSheetName),
  });

  const rows = res.data.values || [];
  const byExtId = new Map();
  // Строка 1 — заголовок, она всегда "занята". Дальше считаем только
  // строки, где реально есть ext_id (колонка U) — колонка D (формула
  // подбора логиста) разворачивается на весь лист и из-за этого
  // "выглядит непустой" для Sheets API даже там, где данных нет.
  let lastUsedRow = 1;

  rows.forEach((row, idx) => {
    const extId = row[IDX.EXT_ID];
    if (!extId) return;
    const rowNumber = idx + 2; // +2: 1-based + заголовок
    byExtId.set(String(extId), {
      rowNumber,
      clientName: row[IDX.CLIENT] || '',
      atiCargoId: row[IDX.ATI_CARGO_ID] || '',
    });
    lastUsedRow = Math.max(lastUsedRow, rowNumber);
  });

  return { byExtId, lastRow: lastUsedRow };
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
      logistName: row[1] || '',
      token: row[2] || '',
      contactId: row[3] || '',
    });
  });

  return map;
}

/**
 * Записывает/обновляет пачку лотов одним запросом batchUpdate.
 * Никогда не трогает колонки A (Статус), D (Логист), R (ATI_cargo_id) —
 * это зона Apps Script / результата публикации.
 *
 * @param {Array<{
 *   extId: string,
 *   rowNumber: number, // уже известная строка (из readLotsIndex) или null для новых
 *   internalNumber: string|number,
 *   clientName: string,
 *   from: string, to: string, cargoName: string,
 *   weight: string|number, volume: string|number, bodyTypeText: string,
 *   clientRateNoVat: string|number, clientRateWithVat: string|number,
 *   carrierRateNoVat: string|number, carrierRateWithVat: string|number,
 *   margin: string|number,
 *   loadDate: string, unloadDate: string,
 *   bodyJson: string,
 * }>} lots
 * @param {number} nextFreeRow — первая свободная строка для новых лотов
 */
async function writeLots(lots, nextFreeRow) {
  if (lots.length === 0) return;

  const sheets = getSheetsApi();
  const { spreadsheetId, lotsSheetName } = config.googleSheets;
  const updatedAt = new Date().toISOString();

  const data = [];
  let nextRow = nextFreeRow;

  for (const lot of lots) {
    const row = lot.rowNumber || nextRow++;
    const sheet = lotsSheetName;

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
 * Удаляет указанные строки листа "Лоты Atrucks" (лоты, пропавшие с Atrucks).
 * @param {number[]} rowNumbers — 1-based номера строк листа
 */
async function deleteLotRows(rowNumbers) {
  if (rowNumbers.length === 0) return;

  const sheets = getSheetsApi();
  const { spreadsheetId, lotsSheetName } = config.googleSheets;

  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetInfo = sheetMeta.data.sheets.find(
    (s) => s.properties.title === lotsSheetName
  );
  if (!sheetInfo) throw new Error(`Лист "${lotsSheetName}" не найден`);
  const sheetId = sheetInfo.properties.sheetId;

  // Удаляем от последней строки к первой, чтобы индексы не сдвигались
  const sorted = [...rowNumbers].sort((a, b) => b - a);

  const requests = sorted.map((rowNumber) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: rowNumber - 1, // 0-based
        endIndex: rowNumber,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

module.exports = {
  readLotsIndex,
  readLogistsMap,
  writeLots,
  deleteLotRows,
};
