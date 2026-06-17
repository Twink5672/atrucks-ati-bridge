// ============================================================
// Точка входа: запуск синхронизации по расписанию + HTTP health-check
// ============================================================

const http = require('http');
const config = require('./config');
const { syncOnce } = require('./sync');
const { syncExpressOnce } = require('./syncExpress');

let isRunning = false;
let lastResult = null;
let lastRunAt = null;

let isExpressRunning = false;
let lastExpressResult = null;
let lastExpressRunAt = null;

async function runCycle() {
  if (isRunning) {
    console.log('Предыдущий цикл Atrucks ещё выполняется, пропуск.');
    return;
  }
  isRunning = true;
  try {
    lastResult = await syncOnce();
  } catch (err) {
    lastResult = { error: err.message };
    console.error('Необработанная ошибка цикла Atrucks:', err);
  } finally {
    lastRunAt = new Date().toISOString();
    isRunning = false;
  }
}

async function runExpressCycle() {
  if (isExpressRunning) {
    console.log('Предыдущий цикл Express Isource ещё выполняется, пропуск.');
    return;
  }
  isExpressRunning = true;
  try {
    lastExpressResult = await syncExpressOnce();
  } catch (err) {
    lastExpressResult = { error: err.message };
    console.error('Необработанная ошибка цикла Express Isource:', err);
  } finally {
    lastExpressRunAt = new Date().toISOString();
    isExpressRunning = false;
  }
}

// Простой HTTP-сервер для healthcheck и ручного запуска
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        atrucks: { isRunning, lastRunAt, lastResult },
        express: { isRunning: isExpressRunning, lastRunAt: lastExpressRunAt, lastResult: lastExpressResult },
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

  if (req.url === '/run-express' && req.method === 'POST') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'started' }));
    runExpressCycle();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`HTTP сервер запущен на порту ${port}`);
});

// Запуск сразу при старте, затем по расписанию — у каждой площадки
// свой независимый цикл и интервал.
runCycle();
setInterval(runCycle, config.schedule.intervalMinutes * 60 * 1000);

runExpressCycle();
setInterval(runExpressCycle, config.express.pollIntervalMinutes * 60 * 1000);

console.log(
  `Сервис запущен. Интервал Atrucks: ${config.schedule.intervalMinutes} мин., ` +
    `интервал Express Isource: ${config.express.pollIntervalMinutes} мин.`
);
