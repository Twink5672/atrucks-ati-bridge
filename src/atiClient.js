// ============================================================
// Клиент ATI: публикация / обновление / удаление грузов
// ============================================================

const config = require('./config');

class CargosLimitError extends Error {
  constructor(message, token) {
    super(message);
    this.name = 'CargosLimitError';
    this.token = token;
  }
}

class AuthError extends Error {
  constructor(message, token) {
    super(message);
    this.name = 'AuthError';
    this.token = token;
  }
}

function checkLimitError(text, token) {
  if (text.includes('cargos_limit_reached')) {
    return new CargosLimitError(
      `Достигнут лимит размещений на общей площадке (токен ...${(token || '').slice(-6)})`,
      token
    );
  }
  return null;
}

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
    if (res.status === 401) {
      throw new AuthError(
        `Токен недействителен или истёк (...${(token || '').slice(-6)})`,
        token
      );
    }
    const limitErr = checkLimitError(text, token);
    if (limitErr) throw limitErr;
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
    if (res.status === 401) {
      throw new AuthError(
        `Токен недействителен или истёк (...${(token || '').slice(-6)})`,
        token
      );
    }
    const limitErr = checkLimitError(text, token);
    if (limitErr) throw limitErr;
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

  // 404 — уже удалён, не ошибка.
  // 405 — ATI не позволяет удалить груз в текущем состоянии (например,
  // есть отклики/ставки перевозчиков). Это не критическая ошибка для
  // нашей синхронизации: груз просто останется на ATI до закрытия
  // вручную или истечения срока — не пытаемся бесконечно повторять.
  if (!res.ok && res.status !== 404 && res.status !== 405) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `ATI DELETE /v2/cargos/${cargoId} -> ${res.status}: ${text.slice(0, 500)}`
    );
  }

  if (res.status === 405) {
    return { notDeletable: true };
  }
}

module.exports = { createCargo, updateCargo, deleteCargo, CargosLimitError, AuthError };
