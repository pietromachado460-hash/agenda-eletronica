const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/agenda.db', (err) => {
  if (err) {
    console.error('DB ERROR', err);
    process.exit(1);
  }
});
db.all('SELECT id, nome, telefone, criadoEm FROM users', (err, rows) => {
  if (err) {
    console.error('QUERY ERROR', err);
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
  db.close();
});
