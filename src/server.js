'use strict';
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`Docker learning app listening on http://localhost:${port}`);
});

// Containers stop with SIGTERM; without this handler Node would ignore it and
// Docker would wait 10s then SIGKILL, which can leave SQLite's WAL unflushed.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
