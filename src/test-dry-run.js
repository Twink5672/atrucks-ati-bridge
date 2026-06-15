// ============================================================
// Тестовый скрипт: проверка получения лотов из Atrucks и
// маппинга в тело ATI БЕЗ реальной публикации.
//
// Запуск: node src/test-dry-run.js
// ============================================================

const atrucks = require('./atrucksClient');
const { mapLotToAtiBody } = require('./mapper');

async function main() {
  console.log('Запрашиваю первую страницу лотов из Atrucks...');
  const data = await atrucks.fetchPage(1);

  console.log(`Получено лотов на странице 1: ${data.lots.length}, has_next=${data.has_next}`);

  const sample = data.lots.slice(0, 3);

  for (const lot of sample) {
    console.log('\n--- Лот ---');
    console.log('ext_id:', lot.ext_id);
    console.log('text_id:', lot.text_id);
    console.log('origins:', lot.origins);
    console.log('destinations:', lot.destinations);
    console.log('load_range:', lot.load_range, '| unload_range:', lot.unload_range);
    console.log('start_price:', lot.start_price);
    console.log('truck_kinds:', lot.transport && lot.transport['transport:truck_kinds']);
    console.log('cargo_volume:', lot.cargo_info && lot.cargo_info['cargo_info:cargo_volume']);

    try {
      const { body, meta } = await mapLotToAtiBody(lot);
      console.log('--- meta ---');
      console.log(JSON.stringify(meta, null, 2));
      console.log('--- body ---');
      console.log(JSON.stringify(body, null, 2));
    } catch (err) {
      console.log('ОШИБКА маппинга:', err.message);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
