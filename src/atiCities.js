// ============================================================
// Резолвинг city_id через ATI autocomplete suggestions,
// с кэшированием в SQLite (таблица city_cache)
// ============================================================

const config = require('./config');
const db = require('./db');

async function fetchSuggestion(prefix) {
  const url = `${config.ati.loadsBase}/gw/gis-dict/v1/autocomplete/suggestions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ati.token}`,
    },
    body: JSON.stringify({
      prefix,
      suggestion_types: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ATI autocomplete вернул ${res.status} для "${prefix}": ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();

  const suggestions = data.suggestions || [];
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const match = suggestions.find((s) => s.city && s.city.id != null);
  return match ? match.city.id : null;
}

/**
 * Запрашивает city_id у ATI по названию города.
 * Использует кэш SQLite, чтобы не дёргать API повторно.
 *
 * @param {string} cityName - короткое название (например "Корюково")
 * @param {string} [fullLocationStr] - полная строка с регионом
 *   (например "Ярославская обл, деревня Корюково"), используется
 *   как fallback, если короткое имя не нашлось.
 */
async function resolveCityId(cityName, fullLocationStr) {
  if (!cityName) return null;

  const cached = db.getCachedCityId(cityName);
  if (cached) return cached;

  let cityId = await fetchSuggestion(cityName);

  // Fallback: пробуем полную строку с регионом (помогает для
  // мелких деревень/сёл, неоднозначных без региона)
  if (!cityId && fullLocationStr && fullLocationStr !== cityName) {
    const cachedFull = db.getCachedCityId(fullLocationStr);
    if (cachedFull) {
      db.cacheCityId(cityName, cachedFull);
      return cachedFull;
    }

    cityId = await fetchSuggestion(fullLocationStr);
    if (cityId) {
      db.cacheCityId(fullLocationStr, String(cityId));
    }
  }

  if (!cityId) return null;

  db.cacheCityId(cityName, String(cityId));
  return String(cityId);
}

module.exports = { resolveCityId };
