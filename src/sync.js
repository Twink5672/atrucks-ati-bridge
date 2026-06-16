// ============================================================
// Основной цикл синхронизации: Atrucks -> ATI
// ============================================================

const atrucks = require('./atrucksClient');
const ati = require('./atiClient');
const db = require('./db');
const { mapLotToAtiBody } = require('./mapper');

const PILOT_LOGIST_NAME = process.env.PILOT_LOGIST_NAME || null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function syncOnce() {
  log('=== Старт цикла синхронизации ===');
  if (PILOT_LOGIST_NAME) {
    log(`!!! РЕЖИМ ПИЛОТА: обрабатываются только лоты логиста "${PILOT_LOGIST_NAME}" !!!`);
  }

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

  // Токены, для которых в рамках этого прогона уже получен
  // cargos_limit_reached — повторно не дёргаем API этим токеном.
  const limitReachedTokens = new Set();

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
        logist_token: existing.logist_token,
        modified: lot.modified,
      });
      continue;
    }

    let mapped;
    try {
      mapped = await mapLotToAtiBody(lot);
    } catch (err) {
      if (err.message.startsWith('Лот пропущен:')) {
        stats.skippedNoLogist = (stats.skippedNoLogist || 0) + 1;
      } else {
        stats.errors += 1;
        log(`ОШИБКА маппинга лота ext_id=${extId} (atrucks_id=${lot.id}): ${err.message}`);
      }
      continue;
    }

    // Пилотный режим: обрабатываем только лоты пилотного логиста.
    // Лоты других логистов полностью игнорируются (не публикуются,
    // не обновляются, их существующие карточки не трогаются).
    if (PILOT_LOGIST_NAME && mapped.meta.logist.name !== PILOT_LOGIST_NAME) {
      stats.skippedNotPilot = (stats.skippedNotPilot || 0) + 1;
      continue;
    }

    const newToken = mapped.meta.logist.token;
    const logistChanged =
      existing && existing.ati_cargo_id && existing.logist_token !== newToken;

    // Если для этого токена уже зафиксирован лимит в этом прогоне —
    // не пытаемся создавать новые карточки (но обновление существующих
    // всё ещё пробуем, лимит обычно касается именно новых размещений).
    const willCreate = !existing || !existing.ati_cargo_id || logistChanged;
    if (willCreate && limitReachedTokens.has(newToken)) {
      stats.skippedLimitReached = (stats.skippedLimitReached || 0) + 1;
      continue;
    }

    try {
      if (existing && existing.ati_cargo_id && !logistChanged) {
        // Обновление тем же логистом
        await ati.updateCargo(existing.ati_cargo_id, mapped.body, newToken);
        db.upsertMapping({
          ext_id: extId,
          atrucks_id: lot.id,
          ati_cargo_id: existing.ati_cargo_id,
          logist_token: newToken,
          modified: lot.modified,
        });
        stats.updated += 1;
        log(`Обновлён груз: ext_id=${extId} -> ati_cargo_id=${existing.ati_cargo_id} (${mapped.meta.logist.name})`);
      } else {
        if (logistChanged) {
          // Логист сменился — снимаем старую карточку старым токеном
          try {
            const result = await ati.deleteCargo(existing.ati_cargo_id, existing.logist_token);
            if (result && result.notDeletable) {
              log(
                `Логист сменился, но старую карточку нельзя удалить через API (вероятно, есть отклики): ` +
                  `ext_id=${extId} -> ati_cargo_id=${existing.ati_cargo_id}. Создаём новую карточку новым логистом, ` +
                  `старая останется на ATI до закрытия вручную.`
              );
            } else {
              log(`Логист сменился, снята старая карточка: ext_id=${extId} -> ati_cargo_id=${existing.ati_cargo_id}`);
            }
          } catch (err) {
            log(`ОШИБКА снятия старой карточки при смене логиста ext_id=${extId}: ${err.message}`);
          }
        }

        // Создание новой карточки
        const { cargoId } = await ati.createCargo(mapped.body, newToken);
        if (!cargoId) {
          throw new Error('ATI не вернул cargo_id при создании');
        }
        db.upsertMapping({
          ext_id: extId,
          atrucks_id: lot.id,
          ati_cargo_id: cargoId,
          logist_token: newToken,
          modified: lot.modified,
        });
        stats.created += 1;
        log(`Создан груз: ext_id=${extId} -> ati_cargo_id=${cargoId} (${mapped.meta.logist.name})`);
      }
    } catch (err) {
      const isLimitError = err && err.name === 'CargosLimitError';
      if (isLimitError) {
        if (!limitReachedTokens.has(newToken)) {
          limitReachedTokens.add(newToken);
          log(
            `ЛИМИТ ATI: ${err.message} (логист=${mapped.meta.logist.name}) — ` +
              `новые карточки этим токеном больше не создаём в этом цикле`
          );
        }
        stats.skippedLimitReached = (stats.skippedLimitReached || 0) + 1;
      } else {
        stats.errors += 1;
        log(`ОШИБКА публикации лота ext_id=${extId} (atrucks_id=${lot.id}): ${err.message}`);
      }
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

    // Пилотный режим: не трогаем карточки, опубликованные другими
    // логистами (определяем по сохранённому токену).
    if (PILOT_LOGIST_NAME) {
      const pilotLogist = require('./logists').LOGISTS.find(
        (l) => l.name === PILOT_LOGIST_NAME
      );
      if (!pilotLogist || row.logist_token !== pilotLogist.token) {
        continue;
      }
    }

    try {
      const result = await ati.deleteCargo(row.ati_cargo_id, row.logist_token);
      db.deleteMapping(row.ext_id);
      if (result && result.notDeletable) {
        log(
          `Груз нельзя удалить через API (вероятно, есть отклики): ext_id=${row.ext_id} -> ati_cargo_id=${row.ati_cargo_id}. ` +
            `Запись из БД снята, карточка останется на ATI до закрытия вручную.`
        );
      } else {
        stats.deleted += 1;
        log(`Снят с ATI груз: ext_id=${row.ext_id} -> ati_cargo_id=${row.ati_cargo_id}`);
      }
    } catch (err) {
      stats.errors += 1;
      log(`ОШИБКА снятия груза ext_id=${row.ext_id} (ati_cargo_id=${row.ati_cargo_id}): ${err.message}`);
    }
  }

  log(
    `=== Итоги: всего=${stats.total}, создано=${stats.created}, обновлено=${stats.updated}, ` +
      `без изменений=${stats.skippedNoChange}, пропущено(нет логиста)=${stats.skippedNoLogist || 0}, ` +
      `пропущено(не пилот)=${stats.skippedNotPilot || 0}, пропущено(лимит ATI)=${stats.skippedLimitReached || 0}, ` +
      `снято=${stats.deleted}, ошибок=${stats.errors} ===`
  );

  return stats;
}

module.exports = { syncOnce };
