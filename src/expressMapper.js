// ============================================================
// Маппинг тендера Express Isource -> тело запроса ATI /v2/cargos
// ============================================================

const config = require('./config');
const { resolveCityId } = require('./atiCities');
const { mapBodyTypes, describeBodyTypes } = require('./mapper');

const EXT_ID_PREFIX = config.express.extIdPrefix;

function parseLocalDateTimeToIso(raw) {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, yyyy, mm, dd, hh, min, ss] = match;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+03:00`;
}

function formatDisplayDate(raw) {
  if (!raw) return '';
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return raw;
  const [, yyyy, mm, dd, hh, min] = match;
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

/**
 * Парсит числовое значение из поля, которое может быть числом,
 * строкой с единицей ("3.5 т") или нулём. Возвращает null если
 * значение отсутствует, нулевое или непарсируемое — ATI не принимает 0.
 */
function parsePositiveNumber(val) {
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function mapOrderToAtiBody(order) {
  const route = (order.orderRoutes && order.orderRoutes[0]) || {};
  const cargo = (route.cargos && route.cargos[0]) || {};
  const vehicle = (route.vehicles && route.vehicles[0]) || {};
  const carcass = (vehicle.carcassTypes && vehicle.carcassTypes[0]) || {};
  const start = route.routePointStart || {};
  const end = route.routePointEnd || {};

  // Все тендеры на Express размещены одним заказчиком —
  // ООО "Газпромнефть-Снабжение". Название фиксированное.
  const clientName = 'ООО "Газпромнефть-Снабжение"';

  const originCity = (start.city && start.city.name) || null;
  // У точки выгрузки city может быть null — тогда пробуем взять
  // первую часть адреса до запятой как название города/региона.
  const destinationCity = (end.city && end.city.name)
    || (end.address ? end.address.split(',')[0].trim() : null)
    || null;

  if (!originCity || !destinationCity) {
    throw new Error(
      `Заказ без корректного маршрута: from="${originCity}", to="${destinationCity}"`
    );
  }

  const [fromCityId, toCityId] = await Promise.all([
    resolveCityId(originCity, start.address),
    resolveCityId(destinationCity, end.address),
  ]);

  if (!fromCityId || !toCityId) {
    throw new Error(
      `Не удалось определить city_id: from="${originCity}" (${fromCityId}), to="${destinationCity}" (${toCityId})`
    );
  }

  const loadIso = parseLocalDateTimeToIso(start.localStartAt);
  const unloadIso = parseLocalDateTimeToIso(end.localFinishAt);

  // Вес у Express приходит в КИЛОГРАММАХ, а ATI ожидает ТОННЫ.
  // Делим на 1000. Объём — в м³, без пересчёта.
  // parsePositiveNumber фильтрует нули и строки с единицами измерения.
  const weightKg = parsePositiveNumber(cargo.weight);
  const weight = weightKg != null ? Math.round(weightKg / 1000 * 100) / 100 : null;
  const volume = parsePositiveNumber(cargo.volume)
    ?? parsePositiveNumber(vehicle.vehicleCategory && vehicle.vehicleCategory.volume);

  const truckKindName = carcass.name || '';
  const bodyTypes = mapBodyTypes(truckKindName);

  const cargoName = cargo.cargoType || 'Груз';

  const vatRate = (order.vat || 22) / 100 + 1;

  const clientRateNoVat = order.noVatPrice != null ? Math.round(order.noVatPrice) : null;
  const clientRateWithVat = order.vatPrice != null ? Math.round(order.vatPrice) : null;
  const isRateRequest = clientRateNoVat == null;

  const carrierRateNoVat = isRateRequest
    ? null
    : Math.round(clientRateNoVat * config.pricing.factor);
  const carrierRateWithVat = isRateRequest ? null : Math.round(carrierRateNoVat * vatRate);
  const margin = isRateRequest ? null : clientRateNoVat - carrierRateNoVat;

  const needsAddress = (cityName) => cityName && /^(москва|санкт-петербург)/i.test(cityName);

  const loadingLocation = { type: 'manual', city_id: fromCityId };
  if (needsAddress(originCity)) loadingLocation.address = start.address;

  const unloadingLocation = { type: 'manual', city_id: toCityId };
  if (needsAddress(destinationCity)) unloadingLocation.address = end.address;

  const body = {
    cargo_application: {
      route: {
        loading: {
          location: loadingLocation,
          dates: { type: 'from-date', first_date: loadIso, last_date: loadIso },
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
          dates: { type: 'from-date', first_date: unloadIso, last_date: unloadIso },
        },
      },
      truck: {
        trucks_count: 1,
        load_type: 'ftl',
        body_types: bodyTypes,
      },
      payment: isRateRequest
        ? { type: 'rate-request', currency_type: config.ati.currencyType }
        : {
            type: 'with-bargaining',
            currency_type: config.ati.currencyType,
            rate_without_vat: carrierRateNoVat,
            rate_with_vat: carrierRateWithVat,
          },
      boards: [
        { id: config.ati.boardId, publication_mode: 'now', cancel_publish_on_auction_bet: false },
      ],
    },
  };

  return {
    body,
    meta: {
      clientName,
      display: {
        internalNumber: order.id,
        from: start.address || originCity,
        to: end.address || destinationCity,
        cargoName,
        weight,
        volume,
        bodyTypeText: describeBodyTypes(bodyTypes),
        clientRateNoVat,
        clientRateWithVat,
        carrierRateNoVat,
        carrierRateWithVat,
        margin,
        loadDate: formatDisplayDate(start.localStartAt),
        unloadDate: formatDisplayDate(end.localFinishAt),
      },
    },
  };
}

module.exports = { mapOrderToAtiBody, EXT_ID_PREFIX };
