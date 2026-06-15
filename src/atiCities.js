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

  const suggestions = data.suggestions || [];
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  // Берём первое предложение, у которого есть city.id
  const match = suggestions.find((s) => s.city && s.city.id != null);
  if (!match) return null;

  const cityId = match.city.id;

  db.cacheCityId(cityName, String(cityId));
  return String(cityId);
}

module.exports = { resolveCityId };
