const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'agenda.db');

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDirectory();

const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('Erro ao abrir o banco de dados:', err);
    process.exit(1);
  }
});

const dbAsync = {
  get: promisify(db.get.bind(db)),
  all: promisify(db.all.bind(db)),
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this);
      });
    });
  },
};

function initializeDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      criadoEm TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      nome TEXT NOT NULL,
      cpf TEXT NOT NULL,
      telefone TEXT NOT NULL,
      dataNegocio TEXT NOT NULL,
      observacoes TEXT,
      criadoEm TEXT NOT NULL,
      atualizadoEm TEXT,
      FOREIGN KEY (userId) REFERENCES users(id)
    )`);
  });
}

initializeDatabase();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});
app.use(
  session({
    secret: 'agenda-eletronica-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 2,
      sameSite: 'lax',
    },
  })
);
app.use(express.static(path.join(__dirname)));

function sanitizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidName(nome) {
  return typeof nome === 'string' && /^[A-Za-zÀ-ÿ ]{3,60}$/.test(nome.trim());
}

function isValidPhone(telefone) {
  const digits = sanitizePhone(telefone);
  return digits.length === 10 || digits.length === 11;
}

function isValidPassword(senha) {
  return typeof senha === 'string' && senha.length >= 6 && senha.length <= 128;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  next();
}

async function getCurrentUser(req) {
  return await dbAsync.get('SELECT id, nome, telefone FROM users WHERE id = ?', [req.session.userId]);
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { nome, telefone, senha, confirmSenha } = req.body;

    if (!nome || !telefone || !senha || !confirmSenha) {
      return res.status(400).json({ error: 'Nome, telefone e senha são obrigatórios.' });
    }

    if (senha !== confirmSenha) {
      return res.status(400).json({ error: 'A senha e a confirmação devem ser iguais.' });
    }

    if (!isValidName(nome)) {
      return res.status(400).json({ error: 'Nome inválido. Use apenas letras e espaços entre 3 e 60 caracteres.' });
    }

    if (!isValidPhone(telefone)) {
      return res.status(400).json({ error: 'Telefone inválido. Deve conter 10 ou 11 dígitos.' });
    }

    if (!isValidPassword(senha)) {
      return res.status(400).json({ error: 'Senha inválida. Use pelo menos 6 caracteres.' });
    }

    const normalizedPhone = sanitizePhone(telefone);
    const existingUser = await dbAsync.get('SELECT id FROM users WHERE telefone = ?', [normalizedPhone]);
    if (existingUser) {
      return res.status(409).json({ error: 'Já existe uma conta com esse telefone.' });
    }

    const passwordHash = await bcrypt.hash(senha, 10);
    const createdAt = new Date().toISOString();
    const result = await dbAsync.run(
      'INSERT INTO users (nome, telefone, password, criadoEm) VALUES (?, ?, ?, ?)',
      [nome.trim(), normalizedPhone, passwordHash, createdAt]
    );

    req.session.userId = result.lastID;
    res.status(201).json({ id: result.lastID, nome: nome.trim(), telefone: normalizedPhone });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro interno ao cadastrar usuário.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { telefone, senha } = req.body;
    console.log('LOGIN ATTEMPT', { telefone, hasSenha: Boolean(senha) });

    if (!telefone || !senha) {
      return res.status(400).json({ error: 'Telefone e senha são obrigatórios.' });
    }

    if (!isValidPhone(telefone)) {
      return res.status(400).json({ error: 'Telefone inválido.' });
    }

    const normalizedPhone = sanitizePhone(telefone);
    const user = await dbAsync.get('SELECT id, nome, telefone, password FROM users WHERE telefone = ?', [normalizedPhone]);
    console.log('LOGIN LOOKUP', { normalizedPhone, userFound: Boolean(user) });
    if (!user) {
      return res.status(401).json({ error: 'Telefone ou senha inválidos.' });
    }

    const passwordMatch = await bcrypt.compare(senha, user.password);
    console.log('PASSWORD MATCH', passwordMatch);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Telefone ou senha inválidos.' });
    }

    req.session.userId = user.id;
    res.json({ id: user.id, nome: user.nome, telefone: user.telefone });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro interno ao autenticar usuário.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Não foi possível encerrar a sessão.' });
    }
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Sessão inválida.' });
  }

  res.json(user);
});

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const type = String(req.query.type || 'nome').trim();
    const startDate = String(req.query.startDate || '').trim();
    const endDate = String(req.query.endDate || '').trim();

    let sql = 'SELECT * FROM clients WHERE userId = ?';
    const params = [req.session.userId];

    if (search) {
      const like = `%${search}%`;
      switch (type) {
        case 'cpf':
          sql += ' AND cpf LIKE ?';
          params.push(like);
          break;
        case 'telefone':
          sql += ' AND telefone LIKE ?';
          params.push(like);
          break;
        case 'observacoes':
          sql += ' AND lower(observacoes) LIKE ?';
          params.push(like);
          break;
        default:
          sql += ' AND lower(nome) LIKE ?';
          params.push(like);
      }
    }

    if (startDate) {
      sql += ' AND dataNegocio >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND dataNegocio <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY criadoEm DESC';
    const clients = await dbAsync.all(sql, params);
    res.json(clients);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar clientes.' });
  }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const { nome, cpf, telefone, dataNegocio, observacoes } = req.body;

    if (!nome || !cpf || !telefone || !dataNegocio) {
      return res.status(400).json({ error: 'Nome, CPF, telefone e data do negócio são obrigatórios.' });
    }

    if (!isValidName(nome)) {
      return res.status(400).json({ error: 'Nome inválido. Use apenas letras e espaços.' });
    }

    if (!/\d{11}/.test(String(cpf).replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'CPF inválido. Deve conter 11 dígitos.' });
    }

    if (!isValidPhone(telefone)) {
      return res.status(400).json({ error: 'Telefone inválido. Deve conter 10 ou 11 dígitos.' });
    }

    const clientId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await dbAsync.run(
      'INSERT INTO clients (id, userId, nome, cpf, telefone, dataNegocio, observacoes, criadoEm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        clientId,
        req.session.userId,
        nome.trim(),
        cpf.trim(),
        telefone.trim(),
        dataNegocio.trim(),
        (observacoes || '').trim(),
        new Date().toISOString(),
      ]
    );

    const newClient = await dbAsync.get('SELECT * FROM clients WHERE id = ? AND userId = ?', [clientId, req.session.userId]);
    res.status(201).json(newClient);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao salvar cliente.' });
  }
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, cpf, telefone, dataNegocio, observacoes } = req.body;

    if (!nome || !cpf || !telefone || !dataNegocio) {
      return res.status(400).json({ error: 'Nome, CPF, telefone e data do negócio são obrigatórios.' });
    }

    if (!isValidName(nome)) {
      return res.status(400).json({ error: 'Nome inválido. Use apenas letras e espaços.' });
    }

    if (!/\d{11}/.test(String(cpf).replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'CPF inválido. Deve conter 11 dígitos.' });
    }

    if (!isValidPhone(telefone)) {
      return res.status(400).json({ error: 'Telefone inválido. Deve conter 10 ou 11 dígitos.' });
    }

    const existing = await dbAsync.get('SELECT id FROM clients WHERE id = ? AND userId = ?', [id, req.session.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    await dbAsync.run(
      'UPDATE clients SET nome = ?, cpf = ?, telefone = ?, dataNegocio = ?, observacoes = ?, atualizadoEm = ? WHERE id = ? AND userId = ?',
      [nome.trim(), cpf.trim(), telefone.trim(), dataNegocio.trim(), (observacoes || '').trim(), new Date().toISOString(), id, req.session.userId]
    );

    const updatedClient = await dbAsync.get('SELECT * FROM clients WHERE id = ? AND userId = ?', [id, req.session.userId]);
    res.json(updatedClient);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao atualizar cliente.' });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await dbAsync.get('SELECT * FROM clients WHERE id = ? AND userId = ?', [id, req.session.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }

    await dbAsync.run('DELETE FROM clients WHERE id = ? AND userId = ?', [id, req.session.userId]);
    res.json(existing);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
