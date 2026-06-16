// ============================================================
// Основной цикл синхронизации: Atrucks -> Google Sheets
//
// Публикация на ATI больше НЕ происходит автоматически здесь.
// Этот цикл только поддерживает лист "Лоты Atrucks" в актуальном
// состоянии (новые лоты, обновлённые цены/маршруты, исчезнувшие
// лоты — удаляются из таблицы). Реальная публикация на ATI —
// вручную, кнопкой в Apps Script внутри самой таблицы.
//
// Исключение: если лот пропал с Atrucks, а в таблице у него уже
// стоит ATI_cargo_id (то есть он был опубликован) — карточка на ATI
// снимается автоматически. Это уборка мусора по уже принятому ранее
// решению о публикации, а не новая публикация, поэтому ручного
// подтверждения здесь не требуется.
// ============================================================

const atrucks = require('./atrucksClient');
const ati = require('./atiClient');
const db = require('./db');
const sheets = require('./sheetsClient');
const { mapLotToAtiBody } = require('./mapper');

const PILOT_LOGIST_NAME = process.env.PILOT_LOGIST_NAME || null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function syncOnce() {
  log('=== Старт цикла синхронизации (Atrucks -> Google Sheets) ===');
  if (PILOT_LOGIST_NAME) {
    log(`!!! РЕЖИМ ПИЛОТА: в таблицу попадают только лоты логиста "${PILOT_LOGIST_NAME}" !!!`);
  }

  let lots;
  try {
    lots = await atrucks.fetchAllLots();
  } catch (err) {
    log(`ОШИБКА получения данных из Atrucks: ${err.message}`);
    return { error: err.message };
  }

  log(`Получено лотов из Atrucks: ${lots.length}`);

  let sheetIndex;
  let logistsMap;
  try {
    [sheetIndex, logistsMap] = await Promise.all([
      sheets.readLotsIndex(),
      sheets.readLogistsMap(),
    ]);
  } catch (err) {
    log(`ОШИБКА чтения Google Sheets: ${err.message}`);
    return { error: err.message };
  }

  const stats = {
    total: lots.length,
    written: 0,
    skippedNoChange: 0,
    skippedNotPilot: 0,
    deletedFromAti: 0,
    deletedRowsOnly: 0,
    errors: 0,
  };

  const seenExtIds = [];
  const toWrite = [];

  for (const lot of lots) {
    const extId = lot.ext_id;
    if (!extId) {
      log(`Пропуск лота без ext_id: id=${lot.id}`);
      continue;
    }

    seenExtIds.push(String(extId));

    const existingDb = db.getMapping(extId);
    const existingSheetRow = sheetIndex.byExtId.get(String(extId));

    // Пропускаем пересчёт, только если лот не менялся на Atrucks
    // И уже есть строка в таблице (иначе её нужно создать заново).
    if (existingDb && existingDb.modified === lot.modified && existingSheetRow) {
      stats.skippedNoChange += 1;
      continue;
    }

    let mapped;
    try {
      mapped = await mapLotToAtiBody(lot);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА маппинга лота ext_id=${extId} (atrucks_id=${lot.id}): ${err.message}`);
      continue;
    }

    if (PILOT_LOGIST_NAME) {
      const logistEntry = logistsMap.get(mapped.meta.clientName);
      if (!logistEntry || logistEntry.logistName !== PILOT_LOGIST_NAME) {
        stats.skippedNotPilot += 1;
        continue;
      }
    }

    toWrite.push({
      extId: String(extId),
      rowNumber: existingSheetRow ? existingSheetRow.rowNumber : null,
      clientName: mapped.meta.clientName,
      from: mapped.meta.display.from,
      to: mapped.meta.display.to,
      cargoName: mapped.meta.display.cargoName,
      weight: mapped.meta.display.weight,
      volume: mapped.meta.display.volume,
      bodyTypeText: mapped.meta.display.bodyTypeText,
      rateNoVat: mapped.meta.display.rateNoVat,
      rateWithVat: mapped.meta.display.rateWithVat,
      loadDate: mapped.meta.display.loadDate,
      unloadDate: mapped.meta.display.unloadDate,
      bodyJson: JSON.stringify(mapped.body),
    });

    db.upsertMapping({
      ext_id: extId,
      atrucks_id: lot.id,
      ati_cargo_id: null,
      logist_token: null,
      modified: lot.modified,
    });
  }

  if (toWrite.length > 0) {
    try {
      await sheets.writeLots(toWrite, sheetIndex.lastRow + 1);
      stats.written = toWrite.length;
      log(`Записано/обновлено строк в таблице: ${toWrite.length}`);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА записи в Google Sheets: ${err.message}`);
    }
  }

  // --- Уборка лотов, пропавших с Atrucks ---
  const seenSet = new Set(seenExtIds);
  const staleExtIds = [...sheetIndex.byExtId.keys()].filter((extId) => !seenSet.has(extId));

  log(`Исчезло с Atrucks лотов (есть в таблице, нет в выдаче): ${staleExtIds.length}`);

  const rowsToDelete = [];

  for (const extId of staleExtIds) {
    const row = sheetIndex.byExtId.get(extId);
    rowsToDelete.push(row.rowNumber);

    if (row.atiCargoId) {
      const logistEntry = logistsMap.get(row.clientName);
      if (!logistEntry || !logistEntry.token) {
        log(
          `ВНИМАНИЕ: лот ext_id=${extId} был опубликован (ati_cargo_id=${row.atiCargoId}), ` +
            `но логист для клиента "${row.clientName}" не найден в листе "Логисты" — карточку на ATI ` +
            `придётся снять вручную.`
        );
        stats.errors += 1;
      } else {
        try {
          await ati.deleteCargo(row.atiCargoId, logistEntry.token);
          stats.deletedFromAti += 1;
          log(`Снята с ATI карточка ext_id=${extId} -> ati_cargo_id=${row.atiCargoId}`);
        } catch (err) {
          stats.errors += 1;
          log(`ОШИБКА снятия карточки ext_id=${extId} (ati_cargo_id=${row.atiCargoId}): ${err.message}`);
        }
      }
    } else {
      stats.deletedRowsOnly += 1;
    }

    db.deleteMapping(extId);
  }

  if (rowsToDelete.length > 0) {
    try {
      await sheets.deleteLotRows(rowsToDelete);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА удаления строк из Google Sheets: ${err.message}`);
    }
  }

  log(
    `=== Итоги: всего=${stats.total}, записано=${stats.written}, без изменений=${stats.skippedNoChange}, ` +
      `пропущено(не пилот)=${stats.skippedNotPilot}, снято с ATI=${stats.deletedFromAti}, ` +
      `удалено строк (не было опубликовано)=${stats.deletedRowsOnly}, ошибок=${stats.errors} ===`
  );

  return stats;
}

module.exports = { syncOnce };
