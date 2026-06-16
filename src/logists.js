// ============================================================
// УСТАРЕЛО: с переходом на Google Sheets этот файл больше НЕ
// используется ни в sync.js, ни в mapper.js. Привязка
// "клиент -> логист" теперь живёт в листе "Логисты" самой
// Google-таблицы и редактируется там вручную (по названию
// клиента, не по company_id).
//
// Файл оставлен как референс для первоначального переноса данных
// в лист "Логисты" (имена/токены/contactId уже здесь собраны).
// Можно удалить после того, как лист "Логисты" будет заполнен.
// ============================================================

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
    companyIds: [], // Трехсосенский (458) перенесён на Зотову Елену
  },
  {
    name: 'Моторыгина Татьяна',
    token: '9af8c42dbe9442ac92ad36ae69dc98a5',
    contactId: 135,
    companyIds: [14103, 19684, 11497, 9413], // ЗТИ Групп, Сибирское Стекло, НПО Про Аква, Гифт
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
  {
    name: 'Чернышев Виктор',
    token: 'b2ae8322c4e140f982da320b9880a31e',
    contactId: 124,
    companyIds: [1480, 4176, 219, 9179, 17742, 1437], // КТЗ, Металл Профиль, Миррико, Завод Стройдеталь, ТД Дача, НИЖКОМАВТО
  },
  {
    name: 'Якимов Михаил',
    token: 'b11f054464a240ac8be044aeb67547a0',
    contactId: 140,
    companyIds: [10785, 352, 12067, 8977], // Аквалайн, Агидель, Логитерра, ТД Меркурий
  },
  {
    name: 'Зотова Елена',
    token: '0c6ff9c7868f4d5f90a86f53a6fa37fd',
    contactId: 141,
    companyIds: [14779, 91, 11215, 458], // ГК АСК, Дикомп-Классик, Северсталь-метиз, Трехсосенский
  },
  {
    name: 'Тачанская Венера',
    token: 'a415816e69d247b0ae3a824db1a6ba11',
    contactId: 126,
    companyIds: [3133], // Татпром-Холдинг (Хаят перенесён на Зубареву)
  },

  // Логисты с токенами, ранее без закреплённых company_id:
  {
    name: 'Тупенов Кайрат',
    token: '54d34ce3a8a4430891d80cb78e877b14',
    contactId: 125,
    companyIds: [],
  },
  {
    name: 'Берестинский Николай',
    token: '699cc9ef7fbd41f3a36e7746e70859e2',
    contactId: 99,
    companyIds: [],
  },
  {
    name: 'Сычевский Данила',
    token: '2f903dab74494300b732c7544b5e5afb',
    contactId: 108,
    companyIds: [],
  },
  {
    name: 'Помогайко Татьяна',
    token: 'ee6dc8d0189e49d3a16c3d978157aed2',
    contactId: 96,
    companyIds: [],
  },
  {
    name: 'Подрезов Алексей',
    token: 'e184784e7af64c5f9b272a0e1aa1cb2b',
    contactId: 90,
    companyIds: [],
  },
  {
    name: 'Зубарева Дарья',
    token: '4999c7390d7441af88b0d250df2a330d',
    contactId: 145,
    companyIds: [792], // Хаят
  },
];

// company_id, которые НЕ публикуются вовсе:
// - 1266 (Акрон) — явно решено не публиковать
const SKIPPED_COMPANY_IDS = new Set([
  1266, // Акрон
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
