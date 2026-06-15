// ============================================================
// Клиент ATI: публикация / обновление / удаление грузов
// ============================================================

const config = require('./config');

async function createCargo(body, token) {
  const res = await fetch(`${config.ati.apiBase}/v2/cargos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || config.ati.token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`ATI POST /v2/cargos -> ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text);
  const cargoId =
    (data.cargo_application && data.cargo_application.cargo_application_id) ||
    data.id ||
    null;

  return { cargoId, raw: data };
}

async function updateCargo(cargoId, body, token) {
  const res = await fetch(`${config.ati.apiBase}/v2/cargos/${cargoId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || config.ati.token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `ATI PUT /v2/cargos/${cargoId} -> ${res.status}: ${text.slice(0, 500)}`
    );
  }

  return { raw: text ? JSON.parse(text) : null };
}

async function deleteCargo(cargoId, token) {
  const res = await fetch(`${config.ati.apiBase}/v2/cargos/${cargoId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token || config.ati.token}`,
    },
  });

  // 404 трактуем как "уже удалён" — не ошибка для нашей синхронизации
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ATI DELETE /v2/cargos/${cargoId} -> ${res.status}: ${text.slice(0, 500)}`
    );
  }
}

module.exports = { createCargo, updateCargo, deleteCargo };
