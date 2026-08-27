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
// Спецправило: рейсы клиента ООО "Газпромнефть-Снабжение" с типом
// кузова "Трал" всегда идут на этот отдельный лист — вместо обычной
// вкладки логиста (не по справочнику "Логисты").
const GPNS_TRAL_TAB = 'Газпромнефть-Снабжение Трал';
const GPNS_PLOSHADKA_BORT_TAB = 'Газпромнефть-Снабжение Площадки/Борта';
const GPNS_MELKOTONNAZHKA_TAB = 'Газпромнефть-Снабжение мелкотоннажка';
const GPNS_TRAL_ARCHIVE_SHEET = 'Архив ГПН Трал';
const GPNS_CLIENT_MARKER = 'Газпромнефть-Снабжение';
// Порог для правила "мелкотоннажка" — объём меньше этого числа (м³).
const GPNS_MELKOTONNAZHKA_VOLUME_THRESHOLD = 75;

/**
 * Спецмаршрутизация для клиента ООО "Газпромнефть-Снабжение" — вместо
 * обычной вкладки логиста. Приоритет правил (первое совпавшее и
 * побеждает): Трал > Площадка/Борта > Мелкотоннажка (объём < 80) >
 * обычная вкладка логиста.
 */
function resolveTargetTab(clientName, bodyTypeText, volume, logistEntry) {
  if (clientName.includes(GPNS_CLIENT_MARKER)) {
    const bt = bodyTypeText || '';
    if (/трал/i.test(bt)) return GPNS_TRAL_TAB;
    if (/площадка|бортовой/i.test(bt)) return GPNS_PLOSHADKA_BORT_TAB;

    const numericVolume =
      typeof volume === 'number' ? volume : parseFloat(String(volume ?? '').replace(',', '.'));
    if (Number.isFinite(numericVolume) && numericVolume < GPNS_MELKOTONNAZHKA_VOLUME_THRESHOLD) {
      return GPNS_MELKOTONNAZHKA_TAB;
    }
  }
  return logistEntry && logistEntry.logistName ? logistEntry.logistName : FALLBACK_TAB;
}

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

  const requiredTabs = new Set([
    FALLBACK_TAB,
    GPNS_TRAL_TAB,
    GPNS_PLOSHADKA_BORT_TAB,
    GPNS_MELKOTONNAZHKA_TAB,
  ]);
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
    // Для клиентов Газпромнефть-Снабжение шорткат пропускаем — тип
    // кузова (для правила GPNS+Трал) в индексе не хранится, известен
    // только после повторного маппинга.
    if (
      existingDb &&
      existingDb.modified === modifiedMarker &&
      existingDb.logic_version === config.mapperLogicVersion &&
      sameTabAsBefore &&
      !existingEntry.clientName.includes(GPNS_CLIENT_MARKER)
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
    const targetTab = resolveTargetTab(
      mapped.meta.clientName,
      mapped.meta.display.bodyTypeText,
      mapped.meta.display.volume,
      logistEntry
    );
    const sameTabAsTarget = sameTabAsBefore && existingEntry.tabName === targetTab;

    if (existingEntry && !sameTabAsTarget) {
      rowsToDelete.push({ tabName: existingEntry.tabName, rowNumber: existingEntry.rowNumber });
      stats.moved += 1;
    }

    const row = sameTabAsTarget ? existingEntry.rowNumber : nextRowByTab.get(targetTab);
    if (!sameTabAsTarget) {
      nextRowByTab.set(targetTab, row + 1);
    }

    // Пересчёт ставки перевозчика и маржи с учётом индивидуального
    // коэффициента логиста (колонка E листа "Логисты").
    const pricingFactor = logistEntry ? logistEntry.pricingFactor : config.pricing.factor;
    const clientRateNoVat = mapped.meta.display.clientRateNoVat;
    const vatRate = config.pricing.vatDivider;
    let { carrierRateNoVat, carrierRateWithVat, margin } = mapped.meta.display;
    if (clientRateNoVat != null && pricingFactor !== config.pricing.factor) {
      carrierRateNoVat = Math.round(clientRateNoVat * pricingFactor);
      carrierRateWithVat = Math.round(carrierRateNoVat * vatRate);
      margin = clientRateNoVat - carrierRateNoVat;
      const payment = mapped.body.cargo_application.payment;
      if (payment && payment.type === 'with-bargaining') {
        payment.rate_without_vat = carrierRateNoVat;
        payment.rate_with_vat = carrierRateWithVat;
      }
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
      carrierRateNoVat,
      carrierRateWithVat,
      margin,
      loadDate: mapped.meta.display.loadDate,
      unloadDate: mapped.meta.display.unloadDate,
      tradeCloseAt: mapped.meta.display.tradeCloseAt ?? '',
      competitor: mapped.meta.display.competitor ?? '',
      competitorRate: mapped.meta.display.competitorRate ?? '',
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

  const archiveRows = [];

  for (const [extId, entry] of staleEntries) {
    rowsToDelete.push({ tabName: entry.tabName, rowNumber: entry.rowNumber });

    // Статистика: перед удалением строки с вкладки "Газпромнефть-
    // Снабжение Трал" сохраняем её снимок в лист-архив навсегда —
    // направление, конкурент, его ставка, наша ставка, итог.
    if (entry.tabName === GPNS_TRAL_TAB) {
      try {
        const row = await sheets.readRowValues(entry.tabName, entry.rowNumber);
        // Индексы по раскладке A..X (0-based):
        // 0 статус, 1 внутр.номер, 2 клиент, 3 логист, 4 откуда, 5 дата погрузки,
        // 6 куда, 7 дата выгрузки, 8 торги до, 9 конкурент, 10 ставка конкурента,
        // 11 груз, 12 вес, 13 объём, 14 тип кузова, 15 ставка клиента без НДС,
        // 16 ставка клиента с НДС, 17 ставка перевозчика без НДС,
        // 18 ставка перевозчика с НДС, 19 маржа, 20 ATI_cargo_id, 21 body_json,
        // 22 обновлено, 23 ext_id
        const outcome = entry.atiCargoId ? 'Опубликовано на ATI' : 'Торги закрыты (не публиковали)';
        archiveRows.push([
          new Date().toISOString(),
          outcome,
          row[1] || '',
          row[4] || '',
          row[6] || '',
          row[5] || '',
          row[7] || '',
          row[9] || '',
          row[10] || '',
          row[11] || '',
          row[12] || '',
          row[13] || '',
          row[14] || '',
          row[15] || '',
          row[16] || '',
          row[17] || '',
          row[18] || '',
          row[19] || '',
          row[20] || '',
          extId,
        ]);
      } catch (err) {
        log(`ОШИБКА чтения строки для архивации ext_id=${extId}: ${err.message}`);
      }
    }

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

  if (archiveRows.length > 0) {
    try {
      await sheets.appendArchiveRows(GPNS_TRAL_ARCHIVE_SHEET, archiveRows);
      log(`Заархивировано закрытых тендеров (Газпромнефть-Снабжение + Трал): ${archiveRows.length}`);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА записи в архив "${GPNS_TRAL_ARCHIVE_SHEET}": ${err.message}`);
    }
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
