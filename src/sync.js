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
const config = require('./config');
const { mapLotToAtiBody } = require('./mapper');
const { resolveCompanyName } = require('./companyNames');
const maxNotifier = require('./maxNotifier');

const PILOT_LOGIST_NAME = process.env.PILOT_LOGIST_NAME || null;
const FALLBACK_TAB = process.env.FALLBACK_TAB_NAME || 'Без логиста';
// Спецправило: рейсы клиента ООО "Газпромнефть-Снабжение" с типом
// кузова "Трал" всегда идут на этот отдельный лист — вместо обычной
// вкладки логиста (не по справочнику "Логисты").
const GPNS_TRAL_TAB = 'Газпромнефть-Снабжение Трал';
const GPNS_PLOSHADKA_BORT_TAB = 'Газпромнефть-Снабжение Площадки/Борта';
const GPNS_MELKOTONNAZHKA_TAB = 'Газпромнефть-Снабжение мелкотоннажка';
const GPNS_CLIENT_MARKER = 'Газпромнефть-Снабжение';
const GPNS_MELKOTONNAZHKA_VOLUME_THRESHOLD = 80;

/**
 * Спецмаршрутизация для клиента ООО "Газпромнефть-Снабжение" — вместо
 * обычной вкладки логиста. Приоритет правил: Трал > Площадка/Борта >
 * Мелкотоннажка (объём < 80) > обычная вкладка логиста.
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
  const mappingErrors = [];
  const newGpnsTralLots = [];
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
    const isGpnsCandidate = clientName.includes(GPNS_CLIENT_MARKER);
    // Предварительная вкладка (без учёта правила "Трал" — тип кузова
    // известен только после маппинга) — нужна для фильтра пилота и
    // дешёвой проверки "не менялось".
    const preliminaryTab = logistEntry && logistEntry.logistName ? logistEntry.logistName : FALLBACK_TAB;

    if (PILOT_LOGIST_NAME && preliminaryTab !== PILOT_LOGIST_NAME && !isGpnsCandidate) {
      stats.skippedNotPilot += 1;
      continue;
    }

    const existingDb = db.getMapping(extId);
    const existingEntry = lotsIndex.byExtId.get(String(extId));
    const sameTabAsPreliminary = Boolean(existingEntry) && existingEntry.tabName === preliminaryTab;

    // Для клиентов Газпромнефть-Снабжение шорткат пропускаем — тип
    // кузова (для правила GPNS+Трал) известен только после маппинга.
    if (
      existingDb &&
      existingDb.modified === lot.modified &&
      existingDb.logic_version === config.mapperLogicVersion &&
      sameTabAsPreliminary &&
      !isGpnsCandidate
    ) {
      stats.skippedNoChange += 1;
      continue;
    }

    let mapped;
    try {
      mapped = await mapLotToAtiBody(lot);
    } catch (err) {
      stats.errors += 1;
      // Не логируем каждую ошибку отдельной строкой — при 70-160
      // нераспознанных городах за цикл это заливает лог Railway и
      // приводит к обрезке сообщений (rate limit), из-за чего
      // терялись и другие важные строки (например про архивацию).
      // Собираем в массив, печатаем одной сводной строкой в конце.
      mappingErrors.push(`ext_id=${extId} (atrucks_id=${lot.id}): ${err.message}`);
      continue;
    }

    const targetTab = resolveTargetTab(
      clientName,
      mapped.meta.display.bodyTypeText,
      mapped.meta.display.volume,
      logistEntry
    );
    const sameTabAsBefore = Boolean(existingEntry) && existingEntry.tabName === targetTab;

    // Пересчёт ставки перевозчика и маржи с учётом индивидуального
    // коэффициента логиста (колонка E листа "Логисты"). Если коэффициент
    // совпадает с глобальным дефолтом — пересчёт ничего не меняет.
    const pricingFactor = logistEntry ? logistEntry.pricingFactor : config.pricing.factor;
    const clientRateNoVat = mapped.meta.display.clientRateNoVat;
    const vatRate = config.pricing.vatDivider;
    let { carrierRateNoVat, carrierRateWithVat, margin } = mapped.meta.display;
    if (clientRateNoVat != null && pricingFactor !== config.pricing.factor) {
      carrierRateNoVat = Math.round(clientRateNoVat * pricingFactor);
      carrierRateWithVat = Math.round(carrierRateNoVat * vatRate);
      margin = clientRateNoVat - carrierRateNoVat;
      // Обновляем и тело запроса ATI (payment.rate_without_vat / rate_with_vat)
      const payment = mapped.body.cargo_application.payment;
      if (payment && payment.type === 'with-bargaining') {
        payment.rate_without_vat = carrierRateNoVat;
        payment.rate_with_vat = carrierRateWithVat;
      }
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

    // Уведомление в MAX: только для реально НОВЫХ рейсов (этого ext_id
    // раньше не было в таблице вообще) на вкладке "Газпромнефть-
    // Снабжение Трал".
    if (!existingEntry && targetTab === GPNS_TRAL_TAB) {
      newGpnsTralLots.push({
        internalNumber: mapped.meta.display.internalNumber,
        from: mapped.meta.display.from,
        to: mapped.meta.display.to,
      });
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
      carrierRateNoVat,
      carrierRateWithVat,
      margin,
      loadDate: mapped.meta.display.loadDate,
      unloadDate: mapped.meta.display.unloadDate,
      tradeCloseAt: '',
      competitor: '',
      competitorRate: '',
      bodyJson: JSON.stringify(mapped.body),
    });

    db.upsertMapping({
      ext_id: extId,
      atrucks_id: lot.id,
      ati_cargo_id: null,
      logist_token: null,
      modified: lot.modified,
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

  if (newGpnsTralLots.length > 0) {
    for (const lot of newGpnsTralLots) {
      try {
        const result = await maxNotifier.notifyNewGpnsTralLot(lot);
        if (result && result.skipped) {
          log(`MAX уведомление пропущено (${result.reason}) для рейса №${lot.internalNumber}`);
        }
      } catch (err) {
        stats.errors += 1;
        log(`ОШИБКА отправки уведомления в MAX для рейса №${lot.internalNumber}: ${err.message}`);
      }
    }
  }

  // --- Уборка лотов, пропавших с Atrucks ---
  // Важно: не трогаем строки других площадок (например, Express
  // Isource — их ext_id начинается с config.express.extIdPrefix),
  // у них своя проверка в своём собственном цикле синхронизации.
  const seenSet = new Set(seenExtIds);
  const staleEntries = [...lotsIndex.byExtId.entries()].filter(
    ([extId]) => !extId.startsWith(config.express.extIdPrefix) && !seenSet.has(extId)
  );

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

  if (mappingErrors.length > 0) {
    const preview = mappingErrors.slice(0, 5).join(' | ');
    const more = mappingErrors.length > 5 ? ` ...и ещё ${mappingErrors.length - 5}` : '';
    log(`ОШИБКИ маппинга лотов (${mappingErrors.length}): ${preview}${more}`);
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
