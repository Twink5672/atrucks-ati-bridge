// ============================================================
// Точка входа: запуск синхронизации по расписанию + HTTP health-check
// ============================================================

const http = require('http');
const config = require('./config');
const { syncOnce } = require('./sync');

let isRunning = false;
let lastResult = null;
let lastRunAt = null;

async function runCycle() {
  if (isRunning) {
    console.log('Предыдущий цикл ещё выполняется, пропуск.');
    return;
  }
  isRunning = true;
  try {
    lastResult = await syncOnce();
  } catch (err) {
    lastResult = { error: err.message };
    console.error('Необработанная ошибка цикла:', err);
  } finally {
    lastRunAt = new Date().toISOString();
    isRunning = false;
  }
}

// Простой HTTP-сервер для healthcheck и ручного запуска
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        isRunning,
        lastRunAt,
        lastResult,
      })
    );
    return;
  }

  if (req.url === '/run' && req.method === 'POST') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    runCycle();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`HTTP сервер запущен на порту ${port}`);
});

// Запуск сразу при старте, затем по расписанию
runCycle();
setInterval(runCycle, config.schedule.intervalMinutes * 60 * 1000);

console.log(
  `Сервис запущен. Интервал синхронизации: ${config.schedule.intervalMinutes} мин.`
);
