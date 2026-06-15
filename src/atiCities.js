// ============================================================
// Резолвинг city_id через ATI autocomplete suggestions,
// с кэшированием в SQLite (таблица city_cache)
// ============================================================

const config = require('./config');
const db = require('./db');

/**
 * Запрашивает city_id у ATI по названию города.
 * Использует кэш SQLite, чтобы не дёргать API повторно.
 */
async function resolveCityId(cityName) {
  if (!cityName) return null;

  const cached = db.getCachedCityId(cityName);
  if (cached) return cached;

  const url = `${config.ati.loadsBase}/gw/gis-dict/v1/autocomplete/suggestions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ati.token}`,
    },
    body: JSON.stringify({
      prefix: cityName,
      suggestion_types: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ATI autocomplete вернул ${res.status} для "${cityName}": ${text.slice(0, 200)}`
    );
  }

  const data = await res.json();

  // Структура ответа может отличаться — берём первый подходящий элемент
  const suggestions = data.suggestions || data.items || data.results || [];
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const first = suggestions[0];
  const cityId = first.city_id || first.id || (first.location && first.location.city_id);

  if (!cityId) return null;

  db.cacheCityId(cityName, String(cityId));
  return String(cityId);
}

module.exports = { resolveCityId };
