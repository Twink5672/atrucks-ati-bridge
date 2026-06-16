// ============================================================
// Dry-run: прогоняет ВСЕ лоты Atrucks через маппинг (города,
// типы кузова, клиенты, цены), но НИЧЕГО не публикует на ATI и
// НИЧЕГО не пишет в Google Sheets.
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
    errors: 0,
  };

  const okSamples = [];
  const errorSamples = [];
  const byClient = new Map();
  const unknownClients = new Set();

  for (const lot of lots) {
    try {
      const { body, meta } = await mapLotToAtiBody(lot);
      stats.ok += 1;

      byClient.set(meta.clientName, (byClient.get(meta.clientName) || 0) + 1);
      if (meta.clientName.startsWith('Неизвестно')) {
        unknownClients.add(`${meta.clientName} (company_id=${lot.company_id})`);
      }

      if (okSamples.length < 5) {
        okSamples.push({
          ext_id: lot.ext_id,
          atrucks_id: lot.id,
          route: `${meta.originCity} -> ${meta.destinationCity}`,
          bodyTypes: meta.bodyTypes,
          rate: meta.rate == null ? 'запрос ставки' : meta.rate,
          rateWithVat: meta.rateWithVat == null ? 'запрос ставки' : meta.rateWithVat,
          client: meta.clientName,
        });
      }
    } catch (err) {
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

  console.log('=== ИТОГИ ===');
  console.log(`Готовы к публикации (ok): ${stats.ok}`);
  console.log(`Ошибки маппинга (требуют внимания): ${stats.errors}`);

  console.log('\n=== Распределение по клиентам ===');
  for (const [name, count] of byClient.entries()) {
    console.log(`${name}: ${count}`);
  }

  if (unknownClients.size > 0) {
    console.log('\n=== Неопознанные company_id (добавьте в src/companyNames.js) ===');
    for (const c of unknownClients) {
      console.log(c);
    }
  }

  console.log('\n=== Примеры готовых к публикации ===');
  for (const s of okSamples) {
    console.log(
      `ext_id=${s.ext_id} (atrucks_id=${s.atrucks_id}) | ${s.route} | body_types=${JSON.stringify(s.bodyTypes)} | rate=${s.rate} (с НДС ${s.rateWithVat}) | клиент=${s.client}`
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
