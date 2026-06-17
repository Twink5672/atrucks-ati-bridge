// ============================================================
// Разовый скрипт: печатает СЫРОЙ JSON одного лота Atrucks целиком
// (по умолчанию первый лот company_id=5349, Синергетик), чтобы
// разобраться, что реально лежит в полях transport / cargo_info.
//
// Запуск: node src/debug-raw-lot.js [company_id]
// ============================================================

const atrucks = require('./atrucksClient');

async function main() {
  const targetCompanyId = Number(process.argv[2]) || 5349; // Синергетик

  console.log(`Ищу первый лот с company_id=${targetCompanyId}...`);
  const lots = await atrucks.fetchAllLots();
  const lot = lots.find((l) => l.company_id === targetCompanyId);

  if (!lot) {
    console.log(`Лот с company_id=${targetCompanyId} не найден среди ${lots.length} лотов.`);
    return;
  }

  console.log('\n=== Весь объект лота (JSON) ===');
  console.log(JSON.stringify(lot, null, 2));

  console.log('\n=== Конкретно transport ===');
  console.log(JSON.stringify(lot.transport, null, 2));

  console.log('\n=== Конкретно cargo_info ===');
  console.log(JSON.stringify(lot.cargo_info, null, 2));
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
