// ============================================================
// Цикл синхронизации: Express Isource -> Google Sheets
//
// Зеркалит src/sync.js (Atrucks), пишет в ТЕ ЖЕ вкладки по логистам
// в той же таблице. Изоляция от строк Atrucks — через префикс
// ext_id (config.express.extIdPrefix): эта уборка трогает только
// строки с этим префиксом, никогда — чужие.
//
// Публикация на ATI — вручную, кнопкой в Apps Script, как и для
// Atrucks. Если тендер пропал из списка TRADE на Express (торги
// закрылись — выиграны, проиграны или удалены) и уже был опубликован
// на ATI — карточка снимается автоматически (та же логика уборки
// мусора, что и для Atrucks).
// ============================================================

const express = require('./expressClient');
const ati = require('./atiClient');
const db = require('./db');
const sheets = require('./sheetsClient');
const config = require('./config');
const { mapOrderToAtiBody, EXT_ID_PREFIX } = require('./expressMapper');

const FALLBACK_TAB = process.env.FALLBACK_TAB_NAME || 'Без логиста';

function log(msg) {
  console.log(`[${new Date().toISOString()}] [Express] ${msg}`);
}

async function syncExpressOnce() {
  log('=== Старт цикла синхронизации (Express Isource -> Google Sheets) ===');

  let orders;
  try {
    orders = await express.fetchAllOrders();
  } catch (err) {
    log(`ОШИБКА получения данных из Express Isource: ${err.message}`);
    return { error: err.message };
  }

  log(`Получено тендеров из Express Isource: ${orders.length}`);

  let logistsMap;
  try {
    logistsMap = await sheets.readLogistsMap();
  } catch (err) {
    log(`ОШИБКА чтения листа "Логисты": ${err.message}`);
    return { error: err.message };
  }

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
    total: orders.length,
    written: 0,
    skippedNoChange: 0,
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

  for (const order of orders) {
    const extId = `${EXT_ID_PREFIX}${order.id}`;
    seenExtIds.push(extId);

    // "modified" у Express нет, поэтому используем updatedAt как
    // признак изменения (ставка на аукционе меняется — updatedAt растёт).
    const modifiedMarker = order.updatedAt || order.createdAt || '';

    const existingDb = db.getMapping(extId);
    const existingEntry = lotsIndex.byExtId.get(extId);
    const sameTabAsBefore = Boolean(existingEntry);

    // Дешёвая проверка "не менялось" — но логист мог поменяться в
    // "Логисты" даже если сам тендер не изменился, поэтому всё равно
    // перепроверяем ожидаемую вкладку по уже сохранённому клиенту.
    if (
      existingDb &&
      existingDb.modified === modifiedMarker &&
      existingDb.logic_version === config.mapperLogicVersion &&
      sameTabAsBefore
    ) {
      const logistEntry = logistsMap.get(existingEntry.clientName);
      const expectedTab = logistEntry && logistEntry.logistName ? logistEntry.logistName : FALLBACK_TAB;
      if (expectedTab === existingEntry.tabName) {
        stats.skippedNoChange += 1;
        continue;
      }
    }

    let mapped;
    try {
      mapped = await mapOrderToAtiBody(order);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА маппинга заказа ext_id=${extId} (order_id=${order.id}): ${err.message}`);
      continue;
    }

    const logistEntry = logistsMap.get(mapped.meta.clientName);
    const targetTab = logistEntry && logistEntry.logistName ? logistEntry.logistName : FALLBACK_TAB;
    const sameTabAsTarget = sameTabAsBefore && existingEntry.tabName === targetTab;

    if (existingEntry && !sameTabAsTarget) {
      rowsToDelete.push({ tabName: existingEntry.tabName, rowNumber: existingEntry.rowNumber });
      stats.moved += 1;
    }

    const row = sameTabAsTarget ? existingEntry.rowNumber : nextRowByTab.get(targetTab);
    if (!sameTabAsTarget) {
      nextRowByTab.set(targetTab, row + 1);
    }

    toWrite.push({
      tabName: targetTab,
      row,
      extId,
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
      atrucks_id: order.id,
      ati_cargo_id: null,
      logist_token: null,
      modified: modifiedMarker,
      logic_version: config.mapperLogicVersion,
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

  // --- Уборка тендеров, пропавших из списка TRADE (закрылись/удалены) ---
  // Трогаем только строки с НАШИМ префиксом — чужие (Atrucks) не задеваем.
  const seenSet = new Set(seenExtIds);
  const staleEntries = [...lotsIndex.byExtId.entries()].filter(
    ([extId]) => extId.startsWith(EXT_ID_PREFIX) && !seenSet.has(extId)
  );

  log(`Исчезло тендеров (есть в таблице, нет в выдаче TRADE): ${staleEntries.length}`);

  for (const [extId, entry] of staleEntries) {
    rowsToDelete.push({ tabName: entry.tabName, rowNumber: entry.rowNumber });

    if (entry.atiCargoId) {
      const logistEntry = logistsMap.get(entry.clientName);
      if (!logistEntry || !logistEntry.token) {
        log(
          `ВНИМАНИЕ: тендер ext_id=${extId} был опубликован (ati_cargo_id=${entry.atiCargoId}), ` +
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
      `без изменений=${stats.skippedNoChange}, снято с ATI=${stats.deletedFromAti}, ` +
      `удалено строк (не было опубликовано)=${stats.deletedRowsOnly}, ошибок=${stats.errors} ===`
  );

  return stats;
}

module.exports = { syncExpressOnce };
