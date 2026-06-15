// ============================================================
// Основной цикл синхронизации: Atrucks -> ATI
// ============================================================

const atrucks = require('./atrucksClient');
const ati = require('./atiClient');
const db = require('./db');
const { mapLotToAtiBody } = require('./mapper');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function syncOnce() {
  log('=== Старт цикла синхронизации ===');

  let lots;
  try {
    lots = await atrucks.fetchAllLots();
  } catch (err) {
    log(`ОШИБКА получения данных из Atrucks: ${err.message}`);
    return { error: err.message };
  }

  log(`Получено лотов из Atrucks: ${lots.length}`);

  const stats = {
    total: lots.length,
    created: 0,
    updated: 0,
    skippedNoChange: 0,
    errors: 0,
    deleted: 0,
  };

  const seenExtIds = [];

  for (const lot of lots) {
    const extId = lot.ext_id;
    if (!extId) {
      log(`Пропуск лота без ext_id: id=${lot.id}`);
      continue;
    }

    seenExtIds.push(extId);

    const existing = db.getMapping(extId);

    // Если уже синхронизировано и modified не изменился — пропускаем
    if (existing && existing.modified === lot.modified && existing.ati_cargo_id) {
      stats.skippedNoChange += 1;
      db.upsertMapping({
        ext_id: extId,
        atrucks_id: lot.id,
        ati_cargo_id: existing.ati_cargo_id,
        modified: lot.modified,
      });
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

    try {
      if (existing && existing.ati_cargo_id) {
        // Обновление
        await ati.updateCargo(existing.ati_cargo_id, mapped.body);
        db.upsertMapping({
          ext_id: extId,
          atrucks_id: lot.id,
          ati_cargo_id: existing.ati_cargo_id,
          modified: lot.modified,
        });
        stats.updated += 1;
        log(`Обновлён груз: ext_id=${extId} -> ati_cargo_id=${existing.ati_cargo_id}`);
      } else {
        // Создание
        const { cargoId } = await ati.createCargo(mapped.body);
        if (!cargoId) {
          throw new Error('ATI не вернул cargo_id при создании');
        }
        db.upsertMapping({
          ext_id: extId,
          atrucks_id: lot.id,
          ati_cargo_id: cargoId,
          modified: lot.modified,
        });
        stats.created += 1;
        log(`Создан груз: ext_id=${extId} -> ati_cargo_id=${cargoId}`);
      }
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА публикации лота ext_id=${extId} (atrucks_id=${lot.id}): ${err.message}`);
    }
  }

  // Снятие с публикации исчезнувших лотов
  const stale = db.getStaleMappings(seenExtIds);
  log(`Исчезло с Atrucks лотов: ${stale.length}`);

  for (const row of stale) {
    if (!row.ati_cargo_id) {
      db.deleteMapping(row.ext_id);
      continue;
    }
    try {
      await ati.deleteCargo(row.ati_cargo_id);
      db.deleteMapping(row.ext_id);
      stats.deleted += 1;
      log(`Снят с ATI груз: ext_id=${row.ext_id} -> ati_cargo_id=${row.ati_cargo_id}`);
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА снятия груза ext_id=${row.ext_id} (ati_cargo_id=${row.ati_cargo_id}): ${err.message}`);
    }
  }

  log(
    `=== Итоги: всего=${stats.total}, создано=${stats.created}, обновлено=${stats.updated}, ` +
      `без изменений=${stats.skippedNoChange}, снято=${stats.deleted}, ошибок=${stats.errors} ===`
  );

  return stats;
}

module.exports = { syncOnce };
