// ============================================================
// Маппинг лота Atrucks -> тело запроса ATI /v2/cargos
//
// Логист больше НЕ резолвится здесь и не обязателен для построения
// тела: с переходом на Google Sheets привязка "клиент -> логист"
// живёт в самой таблице (лист "Логисты", редактируется руками) и
// подставляется в contacts/boards непосредственно в Apps Script
// перед публикацией. Здесь только определяется companyName для
// отображения в колонке "Клиент".
// ============================================================

const config = require('./config');
const { resolveCityId } = require('./atiCities');
const { resolveCompanyName } = require('./companyNames');

// --------------------------------------------------------------
// Типы кузова: ключевые слова -> код body_type ATI
// Коды взяты из существующей системы (200 = тент) и общепринятых
// значений ATI. Если ни одно слово не подошло — defaultBodyType (тент).
// При необходимости список легко расширить.
// --------------------------------------------------------------
const BODY_TYPE_RULES = [
  { codes: [300], keywords: ['реф'] }, // рефрижератор
  { codes: [400], keywords: ['изотерм'] }, // изотермический
  { codes: [200], keywords: ['тент'] }, // тентованный
  { codes: [1100], keywords: ['бортов'] }, // бортовой
  { codes: [100], keywords: ['контейнер'] }, // контейнер (не контейнеровоз)
  { codes: [1300], keywords: ['контейнеровоз'] },
  { codes: [10200], keywords: ['цистерн', 'автоцистерна'] },
  { codes: [1200], keywords: ['самосвал'] },
  { codes: [20000], keywords: ['открыт'] }, // все открытые
  { codes: [1355], keywords: ['площадка без бортов', 'безборт'] },
  { codes: [40000], keywords: ['зерновоз'] },
  { codes: [20300], keywords: ['автовоз'] },
  { codes: [10700], keywords: ['трал'] },
  { codes: [5000], keywords: ['негабарит'] },
  { codes: [10300], keywords: ['лесовоз'] },
  { codes: [500], keywords: ['фургон'] },
  { codes: [700], keywords: ['цельнометалл'] },
  { codes: [10900], keywords: ['скотовоз'] },
  { codes: [1280], keywords: ['коневоз'] },
  { codes: [1250], keywords: ['кормовоз'] },
  { codes: [1170], keywords: ['пикап'] },
  { codes: [1350], keywords: ['манипулятор'] },
  { codes: [1400], keywords: ['шаланда'] },
  { codes: [10000], keywords: ['кран'] },
  { codes: [10350], keywords: ['трубовоз'] },
  { codes: [10320], keywords: ['панелевоз'] },
  { codes: [10330], keywords: ['ломовоз'] },
  { codes: [10500, 10550], keywords: ['низкорам'] },
  { codes: [10600], keywords: ['газовоз'] },
  { codes: [20700], keywords: ['бензовоз'] },
  { codes: [20100], keywords: ['цементовоз'] },
];

/**
 * Подбирает body_types по строке транспорта (например, "Тент, Изотерм, Рефрижератор").
 * Возвращает массив кодов (как минимум один — дефолтный).
 */
function mapBodyTypes(truckKindsRaw) {
  if (!truckKindsRaw) return [config.ati.defaultBodyType];

  const text = truckKindsRaw.toLowerCase();
  const matched = new Set();

  for (const rule of BODY_TYPE_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      rule.codes.forEach((c) => matched.add(c));
    }
  }

  if (matched.size === 0) {
    matched.add(config.ati.defaultBodyType);
  }

  return Array.from(matched);
}

// --------------------------------------------------------------
// Человекочитаемые названия кодов body_type — из официального
// справочника ATI (GET /v1.0/dictionaries/carTypes, см. list-body-types.js).
// Используется только для отображения в колонке "Тип кузова" —
// показываем именно то, что реально уйдёт в публикацию на ATI, а не
// сырое значение от Atrucks (которое иногда оказывается бессмысленным
// числом вроде "20" — заказчик просто не уточнил тип кузова).
// --------------------------------------------------------------
const BODY_TYPE_NAMES = {
  100: 'Контейнер',
  200: 'Тентованный',
  300: 'Рефрижератор',
  400: 'Изотермический',
  500: 'Фургон',
  700: 'Цельнометаллический',
  1100: 'Бортовой',
  1170: 'Пикап',
  1200: 'Самосвал',
  1250: 'Кормовоз',
  1280: 'Коневоз',
  1300: 'Контейнеровоз',
  1350: 'Манипулятор',
  1355: 'Площадка без бортов',
  1400: 'Шаланда',
  5000: 'Негабарит',
  10000: 'Кран',
  10200: 'Автоцистерна',
  10300: 'Лесовоз',
  10320: 'Панелевоз',
  10330: 'Ломовоз',
  10350: 'Трубовоз',
  10500: 'Низкорамный',
  10550: 'Низкорам. платформа',
  10600: 'Газовоз',
  10700: 'Трал',
  10900: 'Скотовоз',
  20000: 'Все открытые',
  20100: 'Цементовоз',
  20300: 'Автовоз',
  20700: 'Бензовоз',
  40000: 'Зерновоз',
};

/**
 * Человекочитаемое название для массива кодов body_types — то, что
 * реально уйдёт на ATI (после применения дефолта, если ничего не
 * распознано), а не сырая строка от Atrucks.
 */
function describeBodyTypes(codes) {
  return codes.map((c) => BODY_TYPE_NAMES[c] || `код ${c}`).join(', ');
}

// --------------------------------------------------------------
// Парсинг "transport:truck_mode": "20 т (82 м³)" или "5 т (20-30 м³)" —
// это требуемая вместимость МАШИНЫ, а не объём самого груза. Atrucks
// для многих заказов вообще не передаёт реальный объём груза (только
// вес в cargo_info:cargo_volume) — в таких случаях это число
// используется ТОЛЬКО для отображения как ориентир, явно помеченный,
// что это не точный объём груза. В тело запроса на ATI это число НЕ
// попадает — туда уходит только реальный объём груза (или ничего).
// --------------------------------------------------------------
function parseVehicleCapacityVolume(truckModeRaw) {
  if (!truckModeRaw) return null;
  const match = truckModeRaw.match(/\(([\d.,]+(?:\s*[-–]\s*[\d.,]+)?)\s*м/);
  if (!match) return null;
  return match[1].replace(/\s+/g, '').replace(',', '.');
}

/**
 * Из строки вида "82" или "20-30" возвращает число — верхнюю границу,
 * если это диапазон (берём максимум, чтобы не недооценить нужное место).
 */
function vehicleCapacityVolumeUpperBound(rawCapacityStr) {
  if (!rawCapacityStr) return null;
  const nums = rawCapacityStr
    .split(/[-–]/)
    .map((p) => parseFloat(p))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

// --------------------------------------------------------------
// Парсинг "cargo_info:cargo_volume": "20.0 т" или "2.84544 т / 84.0 м³"
// --------------------------------------------------------------
function parseWeightVolume(cargoVolumeRaw) {
  let weight = null;
  let volume = null;

  if (!cargoVolumeRaw) return { weight, volume };

  const text = cargoVolumeRaw.replace(/\u202f/g, ' '); // неразрывный узкий пробел

  const weightMatch = text.match(/([\d.,]+)\s*т/);
  if (weightMatch) {
    weight = parseFloat(weightMatch[1].replace(',', '.'));
  }

  const volumeMatch = text.match(/([\d.,]+)\s*м/);
  if (volumeMatch) {
    volume = parseFloat(volumeMatch[1].replace(',', '.'));
  }

  return { weight, volume };
}

// --------------------------------------------------------------
// Парсинг "load_range"/"unload_range": "19.06.2026" или "23.06.2026 08:00"
// Возвращает строку ISO с таймзоной +03:00
// --------------------------------------------------------------
function parseDateRangeToIso(rangeRaw) {
  if (!rangeRaw) return null;

  const match = rangeRaw
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);

  if (!match) return null;

  const [, dd, mm, yyyy, hh, min] = match;
  const time = hh && min ? `${hh}:${min}:00` : '00:00:00';

  return `${yyyy}-${mm}-${dd}T${time}+03:00`;
}

// --------------------------------------------------------------
// Извлекает "чистое" название города из строки вида
// "г Черкесск" / "Челябинская обл, г Копейск" / "141865, Московская обл, ..."
// Берём последний сегмент с "г "/"город"/"пос"/"село" если есть,
// иначе — последний сегмент целиком.
// --------------------------------------------------------------
function extractCityName(locationStr) {
  if (!locationStr || typeof locationStr !== 'string') return null;

  const parts = locationStr.split(',').map((p) => p.trim()).filter(Boolean);

  // префиксы типов населённых пунктов, которые нужно срезать
  const prefixRegex =
    /^(г|пос(?:елок)?|пгт|с(?:ело)?|д(?:еревня)?|рп|х(?:утор)?|ст(?:аница)?|аул|мкр|снт|тер|кв-л)[.\s]+/i;

  // ищем сегмент с распознаваемым типом НП
  const npPart = parts.find((p) => prefixRegex.test(p));

  let raw;
  if (npPart) {
    raw = npPart.replace(prefixRegex, '').trim();
  } else {
    // иначе берём последний сегмент, который не похож на адрес/дом/индекс
    const addressLikeRegex = /^(дом|д\.|ул\.|улица|пр-кт|проспект|промзона|вн\.р-н|строение|кв\.|корпус|№)/i;
    const candidate = [...parts].reverse().find((p) => !addressLikeRegex.test(p) && !/^\d+$/.test(p));
    raw = candidate || parts[parts.length - 1];
  }

  if (!raw) return null;

  // убираем суффиксы в скобках, например "Ярославль (2 точки)"
  const cleaned = raw.replace(/\s*\([^)]*\)\s*$/g, '').trim();

  return cleaned || null;
}

// --------------------------------------------------------------
// Основной маппер: лот Atrucks -> { body, meta }
// body — тело для POST/PUT /v2/cargos
// meta — вспомогательные данные (для логов/отладки)
// --------------------------------------------------------------
async function mapLotToAtiBody(lot) {
  const clientName = resolveCompanyName(lot.company_id);

  const origin = (lot.origins && lot.origins[0]) || null;
  const destination = (lot.destinations && lot.destinations[0]) || null;

  if (!origin || !destination || origin === 'null' || destination === 'null') {
    throw new Error(
      `Лот без корректного маршрута: origin=${JSON.stringify(origin)}, destination=${JSON.stringify(destination)}`
    );
  }

  const originCity = extractCityName(origin);
  const destinationCity = extractCityName(destination);

  const [fromCityId, toCityId] = await Promise.all([
    resolveCityId(originCity, origin),
    resolveCityId(destinationCity, destination),
  ]);

  if (!fromCityId || !toCityId) {
    throw new Error(
      `Не удалось определить city_id: from="${originCity}" (${fromCityId}), to="${destinationCity}" (${toCityId})`
    );
  }

  const loadIso = parseDateRangeToIso(lot.load_range);
  const unloadIso = parseDateRangeToIso(lot.unload_range);

  const cargoInfo = lot.cargo_info || {};
  const transport = lot.transport || {};

  const { weight } = parseWeightVolume(cargoInfo['cargo_info:cargo_volume']);
  const truckModeRaw = transport['transport:truck_mode'] || '';
  const truckKindsRaw = transport['transport:truck_kinds'] || '';
  const bodyTypes = mapBodyTypes(truckKindsRaw);

  // Объём — всегда из вместимости требуемой машины (transport:truck_mode),
  // а не из объёма самого груза: Atrucks почти никогда не передаёт
  // реальный объём груза, только вес. Для диапазона ("20-30 м³") берём
  // верхнюю границу. Это значение уходит и в публикацию на ATI, и в
  // таблицу — единый источник, без рассинхрона.
  const volume = vehicleCapacityVolumeUpperBound(parseVehicleCapacityVolume(truckModeRaw));

  const startPrice = Number(lot.start_price) || 0;
  const isRateRequest = !startPrice || startPrice <= 0;

  // start_price на Atrucks — сумма с НДС 22%.
  // Ставка клиента (как она есть на Atrucks, без скидки):
  const clientRateNoVat = isRateRequest
    ? null
    : Math.round(startPrice / config.pricing.vatDivider);
  const clientRateWithVat = isRateRequest ? null : Math.round(startPrice);

  // Ставка перевозчика (со скидкой, см. config.pricing.factor) — то,
  // что в итоге публикуется на ATI:
  const rate = isRateRequest
    ? null
    : Math.round(clientRateNoVat * config.pricing.factor);
  const rateWithVat = isRateRequest ? null : Math.round(rate * config.pricing.vatDivider);

  const margin = isRateRequest ? null : clientRateNoVat - rate;

  const cargoName = cargoInfo['cargo_info:cargo_kind'] || 'Груз';

  // Адрес для городов, где ATI требует location.address (Москва/СПб)
  const needsAddress = (cityName) =>
    cityName && /^(москва|санкт-петербург)/i.test(cityName);

  const loadingLocation = {
    type: 'manual',
    city_id: fromCityId,
  };
  if (needsAddress(originCity)) {
    loadingLocation.address = origin;
  }

  const unloadingLocation = {
    type: 'manual',
    city_id: toCityId,
  };
  if (needsAddress(destinationCity)) {
    unloadingLocation.address = destination;
  }

  // contacts/boards с конкретным логистом сюда НЕ включаются — это
  // добавляется в Apps Script непосредственно перед публикацией, на
  // основе строки "Логисты" таблицы, найденной по clientName.
  const body = {
    cargo_application: {
      route: {
        loading: {
          location: loadingLocation,
          dates: {
            type: 'from-date',
            first_date: loadIso,
            last_date: loadIso,
          },
          cargos: [
            {
              id: 1,
              name: cargoName,
              ...(weight != null ? { weight: { quantity: weight, measure: 't' } } : {}),
              ...(volume != null ? { volume: { quantity: volume, measure: 'm3' } } : {}),
            },
          ],
        },
        unloading: {
          location: unloadingLocation,
          dates: {
            type: 'from-date',
            first_date: unloadIso,
            last_date: unloadIso,
          },
        },
      },
      truck: {
        trucks_count: 1,
        load_type: 'ftl',
        body_types: bodyTypes,
      },
      payment: isRateRequest
        ? {
            type: 'rate-request',
            currency_type: config.ati.currencyType,
          }
        : {
            type: 'with-bargaining',
            currency_type: config.ati.currencyType,
            rate_without_vat: rate,
            rate_with_vat: rateWithVat,
          },
      boards: [
        {
          id: config.ati.boardId,
          publication_mode: 'now',
          cancel_publish_on_auction_bet: false,
        },
      ],
    },
  };

  return {
    body,
    meta: {
      clientName,
      atrucksInternalNumber: lot.id,
      originCity,
      destinationCity,
      fromCityId,
      toCityId,
      rate,
      rateWithVat,
      clientRateNoVat,
      clientRateWithVat,
      margin,
      bodyTypes,
      weight,
      volume,
      loadIso,
      unloadIso,
      // Поля для отображения в таблице (человекочитаемые, не city_id)
      display: {
        internalNumber: lot.id,
        from: origin,
        to: destination,
        cargoName,
        weight,
        volume,
        bodyTypeText: describeBodyTypes(bodyTypes),
        clientRateNoVat,
        clientRateWithVat,
        carrierRateNoVat: rate,
        carrierRateWithVat: rateWithVat,
        margin,
        loadDate: lot.load_range || '',
        unloadDate: lot.unload_range || '',
      },
    },
  };
}

module.exports = {
  mapLotToAtiBody,
  mapBodyTypes,
  describeBodyTypes,
  parseWeightVolume,
  parseDateRangeToIso,
  extractCityName,
};
