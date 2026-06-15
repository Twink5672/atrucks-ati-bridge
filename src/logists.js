// ============================================================
// Список логистов для распределения публикаций Atrucks -> ATI
// по company_id грузовладельца (Atrucks).
//
// - name      — для логов/отладки
// - token     — токен ATI логиста (колонка "Токен ATI")
// - contactId — Contact ID ATI логиста (колонка "Contact ID ATI")
// - companyIds — company_id грузовладельцев Atrucks, закреплённых
//                за этим логистом (числа, как в lot.company_id)
//
// Лоты с company_id, НЕ перечисленным ни у одного логиста ниже,
// ПРОПУСКАЮТСЯ (не публикуются вовсе) — см. SKIPPED_COMPANY_IDS
// и getLogistForCompanyId().
// ============================================================

const LOGISTS = [
  {
    name: 'Горбик Анастасия',
    token: 'fc481e9fea394b8c8c6f307b6c2567ba',
    contactId: 111,
    companyIds: [458], // Трехсосенский
  },
  {
    name: 'Моторыгина Татьяна',
    token: '9af8c42dbe9442ac92ad36ae69dc98a5',
    contactId: 135,
    companyIds: [14103, 19684, 1437, 11497], // ЗТИ Групп, Сибирское Стекло, НИЖКОМАВТО, НПО Про Аква
  },
  {
    name: 'Банникова Наталья',
    token: '8f46d327af6f405d9d5d1ed54f4ee767',
    contactId: 142,
    companyIds: [6639, 3414, 13278], // ПродЛогистика, СХЗ, Обнинскоргсинтез
  },
  {
    name: 'Лайдегер Людмила',
    token: 'a6c6b855719f4296935fcf20528de4c5',
    contactId: 136,
    companyIds: [1926, 15985], // Лидер-М, Ястро
  },
  {
    name: 'Болоховцев Андрей',
    token: 'ef64d38db0d7453e8a7bb19133a5efb8',
    contactId: 146,
    companyIds: [8880], // Рельеф-Центр
  },
  {
    name: 'Лухтан Ангелина',
    token: '93f880c788ca41b0b9b22fef3c36c265',
    contactId: 106,
    companyIds: [5349, 12775], // Синергетик, ЗТЗ
  },
  {
    name: 'Ларькина Алена',
    token: '67cc286e34684c0d85ee058e30d607ae',
    contactId: 134,
    companyIds: [9285], // СФТ Групп
  },
];

// company_id, которые НЕ публикуются вовсе:
// - 1266 (Акрон) — явно решено не публиковать
// - остальные закреплены за логистами без токена ATI
//   (Чернышев, Якимов, Зотова, Тачанская): КТЗ, Гифт, Металл Профиль,
//   Миррико, Завод Стройдеталь, ТД Дача, Аквалайн, Агидель, Логитерра,
//   ТД Меркурий, ГК АСК, Дикомп-Классик, Северсталь-метиз, Хаят, Татпром-Холдинг
const SKIPPED_COMPANY_IDS = new Set([
  1266, // Акрон
  1480, 9413, 4176, 219, 9179, 17742, // Чернышев (без токена)
  10785, 352, 12067, 8977, // Якимов (без токена)
  14779, 91, 11215, // Зотова (без токена)
  792, 3133, // Тачанская (без токена)
]);

// Быстрый индекс company_id -> логист
const companyIdToLogist = new Map();
for (const logist of LOGISTS) {
  for (const companyId of logist.companyIds || []) {
    companyIdToLogist.set(companyId, logist);
  }
}

/**
 * Возвращает объект логиста для данного company_id лота Atrucks,
 * либо null, если этот company_id нужно пропустить (не публиковать).
 */
function getLogistForCompanyId(companyId) {
  if (SKIPPED_COMPANY_IDS.has(companyId)) {
    return null;
  }
  return companyIdToLogist.get(companyId) || null;
}

module.exports = {
  LOGISTS,
  SKIPPED_COMPANY_IDS,
  getLogistForCompanyId,
};
