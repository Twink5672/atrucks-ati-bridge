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
  // строки, где реально есть ext_id в колонке A — колонка C (формула
  // подбора логиста) разворачивается на весь лист и из-за этого
  // "выглядит непустой" для Sheets API даже там, где данных нет.
  let lastUsedRow = 1;

  rows.forEach((row, idx) => {
    const extId = row[0];
    if (!extId) return;
    const rowNumber = idx + 2; // +2: 1-based + заголовок
    byExtId.set(String(extId), {
      rowNumber,
      clientName: row[1] || '',
      atiCargoId: row[14] || '', // колонка O, индекс 14
    });
    lastUsedRow = Math.max(lastUsedRow, rowNumber);
  });

  return { byExtId, lastRow: lastUsedRow };
}
