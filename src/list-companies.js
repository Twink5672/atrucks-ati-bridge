// ============================================================
// Разовый скрипт: собрать все уникальные company_id из текущей
// выдачи Atrucks с примерами маршрутов/грузов для каждого.
//
// Запуск: node src/list-companies.js
// Не публикует ничего на ATI, только читает Atrucks.
// ============================================================

const atrucks = require('./atrucksClient');

async function main() {
  console.log('Запрашиваю все лоты из Atrucks...');
  const lots = await atrucks.fetchAllLots();
  console.log(`Всего лотов: ${lots.length}\n`);

  const byCompany = new Map();

  for (const lot of lots) {
    const companyId = lot.company_id;
    if (!byCompany.has(companyId)) {
      byCompany.set(companyId, { count: 0, examples: [] });
    }
    const entry = byCompany.get(companyId);
    entry.count += 1;

    if (entry.examples.length < 3) {
      const origin = (lot.origins && lot.origins[0]) || '?';
      const destination = (lot.destinations && lot.destinations[0]) || '?';
      const cargoKind =
        (lot.cargo_info && lot.cargo_info['cargo_info:cargo_kind']) || '?';
      entry.examples.push(
        `${origin} -> ${destination} | ${cargoKind} | цена: ${lot.start_price}`
      );
    }
  }

  // Сортируем по количеству лотов (убывание) — самые "активные" грузовладельцы первыми
  const sorted = Array.from(byCompany.entries()).sort((a, b) => b[1].count - a[1].count);

  console.log(`Уникальных company_id: ${sorted.length}\n`);
  console.log('company_id | количество лотов | примеры');
  console.log('-'.repeat(80));

  for (const [companyId, entry] of sorted) {
    console.log(`\ncompany_id = ${companyId}  (лотов: ${entry.count})`);
    for (const ex of entry.examples) {
      console.log(`  - ${ex}`);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
