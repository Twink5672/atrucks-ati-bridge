// ============================================================
// Маппинг лота Atrucks -> тело запроса ATI /v2/cargos
// ============================================================

const config = require('./config');
const { resolveCityId } = require('./atiCities');
const { getLogistForCompanyId } = require('./logists');

// --------------------------------------------------------------
// Типы кузова: ключевые слова -> код body_type ATI
// Коды взяты из существующей системы (200 = тент) и общепринятых
// значений ATI. Если ни одно слово не подошло — defaultBodyType (тент).
// При необходимости список легко расширить.
// --------------------------------------------------------------
const BODY_TYPE_RULES = [
  { codes: [201], keywords: ['реф', 'изотерм'] }, // рефрижератор/изотерм
  { codes: [200], keywords: ['тент'] }, // тент (включая "тент 20т" и т.п.)
  { codes: [202], keywords: ['бортов'] }, // бортовой
  { codes: [203], keywords: ['контейнер'] },
  { codes: [204], keywords: ['цистерн'] },
  { codes: [205], keywords: ['самосвал'] },
  { codes: [206], keywords: ['открыт'] }, // открытый (с/без коников)
  { codes: [207], keywords: ['контейнеровоз'] },
  { codes: [208], keywords: ['зерновоз'] },
  { codes: [209], keywords: ['автовоз'] },
  { codes: [210], keywords: ['негабарит', 'трал'] },
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
  if (!locationStr) return null;

  const parts = locationStr.split(',').map((p) => p.trim());

  // ищем сегмент, начинающийся с "г "/"г." (город)
  const cityPart = parts.find((p) => /^г[.\s]/i.test(p));
  if (cityPart) {
    return cityPart.replace(/^г[.\s]+/i, '').trim();
  }

  // иначе берём последний непустой сегмент, убирая индекс/числа
  const last = parts[parts.length - 1];
  return last;
}

// --------------------------------------------------------------
// Основной маппер: лот Atrucks -> { body, meta }
// body — тело для POST/PUT /v2/cargos
// meta — вспомогательные данные (для логов/отладки)
// --------------------------------------------------------------
async function mapLotToAtiBody(lot) {
  const logist = getLogistForCompanyId(lot.company_id);
  if (!logist) {
    throw new Error(
      `Лот пропущен: company_id=${lot.company_id} не закреплён за логистом с токеном (или в списке пропуска)`
    );
  }

  const origin = (lot.origins && lot.origins[0]) || null;
  const destination = (lot.destinations && lot.destinations[0]) || null;

  const originCity = extractCityName(origin);
  const destinationCity = extractCityName(destination);

  const [fromCityId, toCityId] = await Promise.all([
    resolveCityId(originCity),
    resolveCityId(destinationCity),
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

  const { weight, volume } = parseWeightVolume(cargoInfo['cargo_info:cargo_volume']);
  const bodyTypes = mapBodyTypes(transport['transport:truck_kinds']);

  const rateWithVat = Math.round((lot.start_price || 0) * config.pricing.factor);
  const rate = Math.round(rateWithVat / config.pricing.vatDivider);

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
      payment: {
        type: 'with-bargaining',
        currency_type: config.ati.currencyType,
        rate_without_vat: rate,
      },
      contacts: [logist.contactId],
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
      originCity,
      destinationCity,
      fromCityId,
      toCityId,
      rate,
      rateWithVat,
      bodyTypes,
      weight,
      volume,
      loadIso,
      unloadIso,
      logist,
    },
  };
}

module.exports = {
  mapLotToAtiBody,
  mapBodyTypes,
  parseWeightVolume,
  parseDateRangeToIso,
  extractCityName,
};
