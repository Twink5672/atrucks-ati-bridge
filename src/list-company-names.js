// ============================================================
// Разовый скрипт: для каждого уникального company_id берёт один
// лот и запрашивает детальную карточку (HTML), парсит из неё
// блок "Заказчик <Название>" -> название компании-грузовладельца.
//
// Запуск: node src/list-company-names.js
// ============================================================

const config = require('./config');
const atrucks = require('./atrucksClient');

// URL детальной карточки лота (HTML).
function detailUrl(lotId) {
  return `${config.atrucks.baseUrl}/carrier/auctions/info/${lotId}/`;
}

async function fetchLotDetailHtml(lotId) {
  const url = detailUrl(lotId);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        Cookie: config.atrucks.cookie,
        Referer: 'https://www.atrucks.su/carrier/auctions/quick/',
        'User-Agent': config.atrucks.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (res.status === 429) {
      const waitMs = 5000 * attempt;
      console.log(`  -> 429 для лота ${lotId}, жду ${waitMs}мс (попытка ${attempt})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} для лота ${lotId}: ${text.slice(0, 150)}`);
    }

    return res.text();
  }

  throw new Error(`HTTP 429 для лота ${lotId} после нескольких попыток`);
}

// Извлекает название заказчика из <legend>Заказчик <span...>Название</span></legend>
function extractCustomerName(html) {
  // Вариант 1: <legend>            Заказчик <span class="auction-data-replaced"><span class="auction-data">Название</span></span>
  const m1 = html.match(
    /<legend>\s*Заказчик\s*<span[^>]*>\s*<span[^>]*>([^<]+)<\/span>\s*<\/span>/i
  );
  if (m1) return m1[1].trim();

  // Вариант 2: блок "Компания" внутри секции Заказчик
  const m2 = html.match(
    /<strong>Компания<\/strong><\/div>\s*<div[^>]*>([^<]+)<\/div>/i
  );
  if (m2) return m2[1].trim();

  return null;
}

async function main() {
  console.log('Запрашиваю все лоты из Atrucks...');
  const lots = await atrucks.fetchAllLots();
  console.log(`Всего лотов: ${lots.length}\n`);

  // Берём по одному лоту на company_id
  const byCompany = new Map();
  for (const lot of lots) {
    if (!byCompany.has(lot.company_id)) {
      byCompany.set(lot.company_id, lot);
    }
  }

  console.log(`Уникальных company_id: ${byCompany.size}\n`);
  console.log('company_id | название компании | пример лота (id)');
  console.log('-'.repeat(80));

  // Уже известные из предыдущего запуска (чтобы не дёргать их снова)
  const known = {
    6639: 'ПродЛогистика',
    458: 'Трехсосенский',
    14103: 'ЗТИ Групп',
    1266: 'Акрон',
    10785: 'Аквалайн',
    219: 'Миррико',
    4176: 'Металл Профиль',
    792: 'Хаят',
    14779: 'ГК АСК',
    9285: 'СФТ Групп',
    5349: 'Синергетик',
    12067: 'Логитерра',
    91: 'Дикомп-Классик',
    8977: 'ТД Меркурий',
    11215: 'Северсталь-метиз',
    17742: 'ТД Дача',
    12775: 'ЗТЗ',
    19684: 'Сибирское Стекло',
    378: 'Оникс',
  };

  for (const [companyId, lot] of byCompany.entries()) {
    if (known[companyId]) {
      console.log(`company_id=${companyId} | "${known[companyId]}" | lot_id=${lot.id} (известно)`);
      continue;
    }

    try {
      const html = await fetchLotDetailHtml(lot.id);
      const name = extractCustomerName(html);
      console.log(`company_id=${companyId} | "${name || '???'}" | lot_id=${lot.id}`);
    } catch (err) {
      console.log(`company_id=${companyId} | ОШИБКА: ${err.message} | lot_id=${lot.id}`);
    }

    // увеличенная задержка, чтобы не ловить 429
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
