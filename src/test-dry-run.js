// ============================================================
// Dry-run: прогоняет ВСЕ лоты Atrucks через маппинг (города,
// типы кузова, логисты, цены), но НИЧЕГО не публикует на ATI.
// Показывает статистику и примеры ошибок/пропусков.
//
// Запуск: node src/test-dry-run.js
// ============================================================

const atrucks = require('./atrucksClient');
const { mapLotToAtiBody } = require('./mapper');

async function main() {
  console.log('Запрашиваю все лоты из Atrucks...');
  const lots = await atrucks.fetchAllLots();
  console.log(`Всего лотов: ${lots.length}\n`);

  const stats = {
    ok: 0,
    skippedNoLogist: 0,
    errors: 0,
  };

  const okSamples = [];
  const errorSamples = [];
  const byLogist = new Map();

  for (const lot of lots) {
    try {
      const { body, meta } = await mapLotToAtiBody(lot);
      stats.ok += 1;

      const logistName = meta.logist.name;
      byLogist.set(logistName, (byLogist.get(logistName) || 0) + 1);

      if (okSamples.length < 5) {
        okSamples.push({
          ext_id: lot.ext_id,
          atrucks_id: lot.id,
          route: `${meta.originCity} -> ${meta.destinationCity}`,
          bodyTypes: meta.bodyTypes,
          rate: meta.rate == null ? 'запрос ставки' : meta.rate,
          rateWithVat: meta.rateWithVat == null ? 'запрос ставки' : meta.rateWithVat,
          logist: logistName,
        });
      }
    } catch (err) {
      if (err.message.startsWith('Лот пропущен:')) {
        stats.skippedNoLogist += 1;
      } else {
        stats.errors += 1;
        if (errorSamples.length < 15) {
          errorSamples.push({
            ext_id: lot.ext_id,
            atrucks_id: lot.id,
            error: err.message,
          });
        }
      }
    }
  }

  console.log('=== ИТОГИ ===');
  console.log(`Готовы к публикации (ok): ${stats.ok}`);
  console.log(`Пропущены (нет логиста / в списке пропуска): ${stats.skippedNoLogist}`);
  console.log(`Ошибки маппинга (требуют внимания): ${stats.errors}`);

  console.log('\n=== Распределение по логистам ===');
  for (const [name, count] of byLogist.entries()) {
    console.log(`${name}: ${count}`);
  }

  console.log('\n=== Примеры готовых к публикации ===');
  for (const s of okSamples) {
    console.log(
      `ext_id=${s.ext_id} (atrucks_id=${s.atrucks_id}) | ${s.route} | body_types=${JSON.stringify(s.bodyTypes)} | rate=${s.rate} (с НДС ${s.rateWithVat}) | логист=${s.logist}`
    );
  }

  console.log('\n=== Примеры ошибок маппинга ===');
  for (const s of errorSamples) {
    console.log(`ext_id=${s.ext_id} (atrucks_id=${s.atrucks_id}): ${s.error}`);
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
