// ============================================================
// Основной цикл синхронизации: Atrucks -> Google Sheets
//
// Каждый клиент попадает на вкладку своего логиста (название
// вкладки = "ФИО логиста" из листа "Логисты"). Клиенты без
// привязки к логисту попадают на вкладку-корзину FALLBACK_TAB.
// Если привязка клиента к логисту меняется — строка переезжает
// со старой вкладки на новую при следующей синхронизации.
//
// Публикация на ATI больше НЕ происходит автоматически здесь.
// Этот цикл только поддерживает вкладки в актуальном состоянии
// (новые лоты, обновлённые цены/маршруты, исчезнувшие лоты —
// удаляются). Реальная публикация на ATI — вручную, кнопкой в
// Apps Script внутри самой таблицы.
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
const { resolveCompanyName } = require('./companyNames');

const PILOT_LOGIST_NAME = process.env.PILOT_LOGIST_NAME || null;
const FALLBACK_TAB = process.env.FALLBACK_TAB_NAME || 'Без логиста';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function syncOnce() {
  log('=== Старт цикла синхронизации (Atrucks -> Google Sheets) ===');
  if (PILOT_LOGIST_NAME) {
    log(`!!! РЕЖИМ ПИЛОТА: попадают только лоты на вкладку логиста "${PILOT_LOGIST_NAME}" !!!`);
  }

  let lots;
  try {
    lots = await atrucks.fetchAllLots();
  } catch (err) {
    log(`ОШИБКА получения данных из Atrucks: ${err.message}`);
    return { error: err.message };
  }

  log(`Получено лотов из Atrucks: ${lots.length}`);

  let logistsMap;
  try {
    logistsMap = await sheets.readLogistsMap();
  } catch (err) {
    log(`ОШИБКА чтения листа "Логисты": ${err.message}`);
    return { error: err.message };
  }

  // Набор нужных вкладок: уникальные логисты из справочника + корзина
  const requiredTabs = new Set([FALLBACK_TAB]);
  for (const entry of logistsMap.values()) {
    if (entry.logistName) requiredTabs.add(entry.logistName);
  }
  const requiredTabsList = [...requiredTabs];

  try {
    await sheets.ensureTabs(requiredTabsList);
  } catch (err) {
    log(`ОШИБКА создания/проверки вкладок: ${err.message}`);
    return { error: err.message };
  }

  let lotsIndex;
  try {
    lotsIndex = await sheets.readAllLotsIndex(requiredTabsList);
  } catch (err) {
    log(`ОШИБКА чтения вкладок Google Sheets: ${err.message}`);
    return { error: err.message };
  }

  const stats = {
    total: lots.length,
    written: 0,
    skippedNoChange: 0,
    skippedNotPilot: 0,
    moved: 0,
    deletedFromAti: 0,
    deletedRowsOnly: 0,
    errors: 0,
  };

  const seenExtIds = [];
  const toWrite = [];
  const rowsToDelete = [];
  const nextRowByTab = new Map(
    requiredTabsList.map((t) => [t, (lotsIndex.lastRowByTab.get(t) || 1) + 1])
  );

  for (const lot of lots) {
    const extId = lot.ext_id;
    if (!extId) {
      log(`Пропуск лота без ext_id: id=${lot.id}`);
      continue;
    }
    seenExtIds.push(String(extId));

    const clientName = resolveCompanyName(lot.company_id);
    const logistEntry = logistsMap.get(clientName);
    const targetTab = logistEntry && logistEntry.logistName ? logistEntry.logistName : FALLBACK_TAB;

    if (PILOT_LOGIST_NAME && targetTab !== PILOT_LOGIST_NAME) {
      stats.skippedNotPilot += 1;
      continue;
    }

    const existingDb = db.getMapping(extId);
    const existingEntry = lotsIndex.byExtId.get(String(extId));
    const sameTabAsBefore = Boolean(existingEntry) && existingEntry.tabName === targetTab;

    if (existingDb && existingDb.modified === lot.modified && sameTabAsBefore) {
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

    // Логист сменился — старую строку на прежней вкладке убираем
    if (existingEntry && !sameTabAsBefore) {
      rowsToDelete.push({ tabName: existingEntry.tabName, rowNumber: existingEntry.rowNumber });
      stats.moved += 1;
    }

    const row = sameTabAsBefore ? existingEntry.rowNumber : nextRowByTab.get(targetTab);
    if (!sameTabAsBefore) {
      nextRowByTab.set(targetTab, row + 1);
    }

    toWrite.push({
      tabName: targetTab,
      row,
      extId: String(extId),
      internalNumber: mapped.meta.display.internalNumber,
      clientName: mapped.meta.clientName,
      from: mapped.meta.display.from,
      to: mapped.meta.display.to,
      cargoName: mapped.meta.display.cargoName,
      weight: mapped.meta.display.weight,
      volume: mapped.meta.display.volume,
      bodyTypeText: mapped.meta.display.bodyTypeText,
      clientRateNoVat: mapped.meta.display.clientRateNoVat,
      clientRateWithVat: mapped.meta.display.clientRateWithVat,
      carrierRateNoVat: mapped.meta.display.carrierRateNoVat,
      carrierRateWithVat: mapped.meta.display.carrierRateWithVat,
      margin: mapped.meta.display.margin,
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
      await sheets.writeLots(toWrite);
      stats.written = toWrite.length;
      log(`Записано/обновлено строк: ${toWrite.length} (из них переехало на другую вкладку: ${stats.moved})`);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА записи в Google Sheets: ${err.message}`);
    }
  }

  // --- Уборка лотов, пропавших с Atrucks ---
  const seenSet = new Set(seenExtIds);
  const staleEntries = [...lotsIndex.byExtId.entries()].filter(([extId]) => !seenSet.has(extId));

  log(`Исчезло с Atrucks лотов (есть в таблице, нет в выдаче): ${staleEntries.length}`);

  for (const [extId, entry] of staleEntries) {
    rowsToDelete.push({ tabName: entry.tabName, rowNumber: entry.rowNumber });

    if (entry.atiCargoId) {
      const logistEntry = logistsMap.get(entry.clientName);
      if (!logistEntry || !logistEntry.token) {
        log(
          `ВНИМАНИЕ: лот ext_id=${extId} был опубликован (ati_cargo_id=${entry.atiCargoId}), ` +
            `но логист для клиента "${entry.clientName}" не найден в листе "Логисты" — карточку на ATI ` +
            `придётся снять вручную.`
        );
        stats.errors += 1;
      } else {
        try {
          await ati.deleteCargo(entry.atiCargoId, logistEntry.token);
          stats.deletedFromAti += 1;
          log(`Снята с ATI карточка ext_id=${extId} -> ati_cargo_id=${entry.atiCargoId}`);
        } catch (err) {
          stats.errors += 1;
          log(`ОШИБКА снятия карточки ext_id=${extId} (ati_cargo_id=${entry.atiCargoId}): ${err.message}`);
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
    `=== Итоги: всего=${stats.total}, записано=${stats.written}, переехало=${stats.moved}, ` +
      `без изменений=${stats.skippedNoChange}, пропущено(не пилот)=${stats.skippedNotPilot}, ` +
      `снято с ATI=${stats.deletedFromAti}, удалено строк (не было опубликовано)=${stats.deletedRowsOnly}, ` +
      `ошибок=${stats.errors} ===`
  );

  return stats;
}

module.exports = { syncOnce };
