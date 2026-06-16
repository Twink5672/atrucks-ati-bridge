// ============================================================
// Разовый скрипт: получить справочник типов кузовов ATI
// (GET /v1.0/dictionaries/carTypes) и вывести TypeId -> Name.
//
// Запуск: node src/list-body-types.js
// ============================================================

const config = require('./config');

async function main() {
  const res = await fetch(`${config.ati.apiBase}/v1.0/dictionaries/carTypes`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ati.token}`,
    },
  });

  const text = await res.text();

  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }

  const data = JSON.parse(text);

  console.log(`Всего типов кузовов: ${data.length}\n`);
  console.log('TypeId | Name | ShortName');
  console.log('-'.repeat(60));

  // Сортируем по TypeId для удобства
  const sorted = [...data].sort((a, b) => (a.TypeId || 0) - (b.TypeId || 0));

  for (const item of sorted) {
    console.log(`${item.TypeId} | ${item.Name} | ${item.ShortName || ''}`);
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
