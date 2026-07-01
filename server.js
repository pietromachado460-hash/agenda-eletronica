require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const multer = require('multer');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { body, query, validationResult } = require('express-validator');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Estado de disponibilidade do DB (permite iniciar servidor mesmo sem conexão)
let dbReady = true;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const dbAsync = {
  async get(sql, params = []) {
    try {
      const res = await pool.query(sql, params);
      return res.rows[0];
    } catch (err) {
      console.error('DB query error:', err);
      dbReady = false;
      throw err;
    }
  },
  async all(sql, params = []) {
    try {
      const res = await pool.query(sql, params);
      return res.rows;
    } catch (err) {
      console.error('DB query error:', err);
      dbReady = false;
      throw err;
    }
  },
  async run(sql, params = []) {
    try {
      const res = await pool.query(sql, params);
      return res;
    } catch (err) {
      console.error('DB query error:', err);
      dbReady = false;
      throw err;
    }
  },
};

async function initializePg() {
  try {
    // Criar tabela de usuários com campos expandidos
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'funcionario',
      ativo BOOLEAN DEFAULT true,
      bloqueado BOOLEAN DEFAULT false,
      motivo_bloqueio TEXT,
      data_bloqueio TEXT,
      data_desbloqueio TEXT,
      criadoEm TEXT NOT NULL
    )`);

    // Adicionar colunas se não existirem (para usuários antigos)
    const columnsToAdd = [
      { name: 'email', type: 'TEXT UNIQUE' },
      { name: 'role', type: "TEXT DEFAULT 'funcionario'" },
      { name: 'ativo', type: 'BOOLEAN DEFAULT true' },
      { name: 'bloqueado', type: 'BOOLEAN DEFAULT false' },
      { name: 'motivo_bloqueio', type: 'TEXT' },
      { name: 'data_bloqueio', type: 'TEXT' },
      { name: 'data_desbloqueio', type: 'TEXT' }
    ];

    for (const col of columnsToAdd) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
      } catch (err) {
        // Coluna já existe, ignorar
      }
    }

    // Adicionar colunas de segurança (tentativas de login / bloqueio)
    try {
      await pool.query("ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0");
    } catch (err) {}
    try {
      await pool.query("ALTER TABLE users ADD COLUMN locked_until TEXT");
    } catch (err) {}

    // Criar tabela de clientes
    await pool.query(`CREATE TABLE IF NOT EXISTS clients (
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

    // Criar tabela de logs de auditoria
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      userId INTEGER,
      acao TEXT NOT NULL,
      recurso TEXT,
      descricao TEXT,
      ip TEXT,
      userAgent TEXT,
      status TEXT,
      criadoEm TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id)
    )`);

    // Criar tabela de tokens de reset de senha
    await pool.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      userId INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expiresAt TEXT NOT NULL,
      usado BOOLEAN DEFAULT false,
      criadoEm TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id)
    )`);

    console.log('Initialized PostgreSQL tables');
  } catch (err) {
    console.error('Error initializing database tables:', err);
    console.warn('Continuando sem conexão ativa com o banco. Alguns endpoints dependerão do DB e podem falhar. Configure DATABASE_URL para habilitar completamente.');
    dbReady = false;
  }
}

initializePg();

// Helmet com CSP básica (melhorar conforme domínio em produção)
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
};
app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));
app.use(cors({ origin: true, credentials: true, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.use(cookieParser());


const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente mais tarde.' },
});
app.use('/api', apiLimiter);

// Rate limiters específicos
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' } });
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Muitas solicitações de recuperação. Tente novamente mais tarde.' } });

// Configurar session store (Redis se REDIS_URL presente, caso contrário fallback em memória)
let sessionOptions = {
  secret: process.env.SESSION_SECRET || 'agenda-eletronica-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 2,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
};

if (process.env.REDIS_URL) {
  try {
    const RedisStore = require('connect-redis')(session);
    const Redis = require('ioredis');
    const redisClient = new Redis(process.env.REDIS_URL);
    sessionOptions.store = new RedisStore({ client: redisClient });
    console.log('Session store: Redis configurado.');
  } catch (err) {
    console.warn('Não foi possível configurar Redis session store, usando fallback em memória.', err.message);
  }
}

app.use(session(sessionOptions));

// CSRF protection for API (use double-submit cookie via endpoint)
try {
  app.use(csurf({ cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } }));
  app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });
} catch (err) {
  console.warn('CSRF middleware not initialized:', err.message);
}

app.use((req, res, next) => {
  if (!dbReady && req.path.startsWith('/api')) {
    return res.status(503).json({ error: 'Banco de dados indisponível. Verifique a variável DATABASE_URL e a conexão com o PostgreSQL.' });
  }
  next();
});

// Verificar status do usuário (bloqueado)
app.use(checkUserStatus);

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

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array().map((item) => item.msg).join(', ') });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  next();
}

// Middleware para verificar se usuário está bloqueado
async function checkUserStatus(req, res, next) {
  if (!req.session.userId) {
    return next();
  }
  
  const user = await dbAsync.get('SELECT bloqueado FROM users WHERE id = $1', [req.session.userId]);
  if (user && user.bloqueado) {
    req.session.destroy();
    return res.status(403).json({ error: 'Sua conta foi bloqueada.' });
  }
  
  next();
}

// Middleware para verificar role (cargo)
function requireRole(...rolesPermitidas) {
  return async (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    
    const user = await dbAsync.get('SELECT role, bloqueado FROM users WHERE id = $1', [req.session.userId]);
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado.' });
    }
    
    if (user.bloqueado) {
      req.session.destroy();
      return res.status(403).json({ error: 'Sua conta foi bloqueada.' });
    }
    
    if (!rolesPermitidas.flat().includes(user.role)) {
      await createAuditLog(req.session.userId, 'acesso_negado', 'recurso_restrito', `Tentativa de acesso sem permissão ao recurso: ${req.originalUrl}`, req);
      return res.status(403).json({ error: 'Permissão negada.' });
    }
    
    req.user = user;
    next();
  };
}

// Mapa de permissões por ação (RBAC simples)
const rolePermissions = {
  super_admin: [
    'manage_users', 'change_roles', 'view_audit', 'manage_clients', 'export_data', 'import_data'
  ],
  admin: ['manage_users', 'manage_clients', 'export_data', 'import_data', 'view_audit'],
  gerente: ['manage_clients', 'view_reports'],
  funcionario: ['manage_clients'],
};

function hasPermission(role, action) {
  const perms = rolePermissions[role] || [];
  return perms.includes(action);
}

function requirePermission(action) {
  return async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autenticado.' });
    const user = await dbAsync.get('SELECT id, role, bloqueado FROM users WHERE id = $1', [req.session.userId]);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    if (user.bloqueado) {
      req.session.destroy();
      return res.status(403).json({ error: 'Sua conta foi bloqueada.' });
    }
    if (!hasPermission(user.role, action)) {
      await createAuditLog(req.session.userId, 'acesso_negado', action, `Tentativa de acesso sem permissão: ${action}`, req);
      return res.status(403).json({ error: 'Permissão negada.' });
    }
    req.user = user;
    next();
  };
}

async function getCurrentUser(req) {
  return await dbAsync.get('SELECT id, nome, telefone, email, role, bloqueado FROM users WHERE id = $1', [req.session.userId]);
}

// Validar força de senha (8+ caracteres, maiúscula, minúscula, número, caractere especial)
function isStrongPassword(senha) {
  if (!senha || typeof senha !== 'string') return false;
  if (senha.length < 8) return false;
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*]).{8,}$/;
  return regex.test(senha);
}

// Gerar token de reset de senha
function generateResetToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

// Criar log de auditoria
async function createAuditLog(userId, acao, recurso, descricao, req) {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'desconhecido';
    const userAgent = req.headers['user-agent'] || '';
    await dbAsync.run(
      'INSERT INTO audit_logs (userId, acao, recurso, descricao, ip, userAgent, status, criadoEm) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [userId, acao, recurso, descricao, ip, userAgent, 'success', new Date().toISOString()]
    );
  } catch (err) {
    console.error('Erro ao criar log de auditoria:', err);
  }
}

// Enviar e-mail genérico (usa variáveis de ambiente SMTP). Se não configurado, loga o link.
async function sendEmail(to, subject, html, req) {
  try {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const fromAddress = process.env.EMAIL_FROM || `no-reply@${req.headers.host || 'localhost'}`;

    if (smtpHost && smtpUser && smtpPass) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort || '587'),
        secure: smtpPort === '465',
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      await transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        html,
      });
      return true;
    }

    // Fallback: logar o conteúdo do e-mail para ambientes sem SMTP
    console.log('[EMAIL DEBUG] to:', to, 'subject:', subject);
    console.log(html);
    return false;
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err);
    return false;
  }
}

async function sendResetEmail(toEmail, toName, token, req) {
  const resetUrl = `${req.protocol}://${req.get('host')}/?reset_token=${token}`;
  const html = `
    <p>Olá ${toName || ''},</p>
    <p>Recebemos uma solicitação para redefinir sua senha. Clique no link abaixo para criar uma nova senha. O link expira em 1 hora.</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>Se você não solicitou esta alteração, ignore este e-mail.</p>
  `;

  return await sendEmail(toEmail, 'Redefinição de senha - Agenda Eletrônica', html, req);
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
    const existingUser = await dbAsync.get('SELECT id FROM users WHERE telefone = $1', [normalizedPhone]);
    if (existingUser) {
      return res.status(409).json({ error: 'Já existe uma conta com esse telefone.' });
    }

    const passwordHash = await bcrypt.hash(senha, 10);
    const createdAt = new Date().toISOString();
    const result = await dbAsync.run(
      'INSERT INTO users (nome, telefone, password, criadoEm) VALUES ($1, $2, $3, $4) RETURNING id',
      [nome.trim(), normalizedPhone, passwordHash, createdAt]
    );

    const newId = result.rows && result.rows[0] ? result.rows[0].id : null;
    req.session.userId = newId;
    res.status(201).json({ id: newId, nome: nome.trim(), telefone: normalizedPhone });
 } catch (error) {
  console.error('REGISTER ERROR:', error);
  res.status(500).json({
    error: 'Erro interno ao cadastrar usuário.',
    details: error.message
  });
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
    const user = await dbAsync.get('SELECT id, nome, telefone, password, bloqueado, failed_attempts, locked_until FROM users WHERE telefone = $1', [normalizedPhone]);
    console.log('LOGIN LOOKUP', { normalizedPhone, userFound: Boolean(user) });
    if (!user) {
      return res.status(401).json({ error: 'Telefone ou senha inválidos.' });
    }

    // Checar bloqueio por tentativas
    if (user && user.locked_until) {
      const until = new Date(user.locked_until);
      if (!Number.isNaN(until.getTime()) && until > new Date()) {
        return res.status(403).json({ error: 'Conta temporariamente bloqueada devido a múltiplas tentativas. Tente mais tarde.' });
      }
    }

    const passwordMatch = await bcrypt.compare(senha, user.password);
    console.log('PASSWORD MATCH', passwordMatch);
    if (!passwordMatch) {
      // Incrementar tentativas
      try {
        const attempts = (user.failed_attempts || 0) + 1;
        if (attempts >= 5) {
          const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
          await dbAsync.run('UPDATE users SET failed_attempts = 0, locked_until = $1 WHERE id = $2', [lockUntil, user.id]);
        } else {
          await dbAsync.run('UPDATE users SET failed_attempts = $1 WHERE id = $2', [attempts, user.id]);
        }
      } catch (e) {
        console.error('Erro atualizando tentativas de login:', e);
      }
      return res.status(401).json({ error: 'Telefone ou senha inválidos.' });
    }

    if (user.bloqueado) {
      return res.status(403).json({ error: 'Conta bloqueada. Contate o administrador.' });
    }

    // Resetar tentativas em sucesso
    try {
      await dbAsync.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    } catch (e) {
      console.error('Erro resetando tentativas:', e);
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

  const user = await dbAsync.get('SELECT id, nome, telefone, email, role, bloqueado FROM users WHERE id = $1', [req.session.userId]);
  if (!user) {
    return res.status(401).json({ error: 'Sessão inválida.' });
  }

  res.json(user);
});

app.put(
  '/api/auth/me',
  requireAuth,
  [
    body('nome')
      .optional()
      .trim()
      .isLength({ min: 3, max: 60 })
      .withMessage('Nome deve ter entre 3 e 60 caracteres.')
      .matches(/^[A-Za-zÀ-ÿ ]+$/)
      .withMessage('Nome inválido.'),
    body('email').optional().trim().isEmail().withMessage('Email inválido.').normalizeEmail(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { nome, email } = req.body;
      const updateFields = [];
      const params = [];

      if (nome) {
        updateFields.push('nome = $' + (params.length + 1));
        params.push(nome);
      }
      if (email) {
        updateFields.push('email = $' + (params.length + 1));
        params.push(email);
      }

      if (!updateFields.length) {
        return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
      }

      params.push(req.session.userId);
      await dbAsync.run(`UPDATE users SET ${updateFields.join(', ')} WHERE id = $${params.length}`, params);
      const updatedUser = await dbAsync.get('SELECT id, nome, telefone, email, role, bloqueado FROM users WHERE id = $1', [req.session.userId]);
      res.json(updatedUser);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao atualizar perfil.' });
    }
  }
);

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const type = String(req.query.type || 'nome').trim();
    const startDate = String(req.query.startDate || '').trim();
    const endDate = String(req.query.endDate || '').trim();
    let sql = 'SELECT * FROM clients WHERE userId = $1';
    const params = [req.session.userId];

    if (search) {
      const like = `%${search}%`;
      switch (type) {
        case 'cpf':
          sql += ` AND cpf LIKE $${params.length + 1}`;
          params.push(like);
          break;
        case 'telefone':
          sql += ` AND telefone LIKE $${params.length + 1}`;
          params.push(like);
          break;
        case 'observacoes':
          sql += ` AND lower(observacoes) LIKE $${params.length + 1}`;
          params.push(like);
          break;
        default:
          sql += ` AND lower(nome) LIKE $${params.length + 1}`;
          params.push(like);
      }
    }

    if (startDate) {
      sql += ` AND dataNegocio >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      sql += ` AND dataNegocio <= $${params.length + 1}`;
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

app.get('/api/clients/stats', requireAuth, async (req, res) => {
  try {
    const clients = await dbAsync.all('SELECT dataNegocio FROM clients WHERE userId = $1', [req.session.userId]);
    const now = new Date();
    const labels = [];
    const counts = [];
    for (let i = 11; i >= 0; i -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      labels.push(date.toLocaleString('pt-BR', { month: 'short', year: 'numeric' }));
      counts.push(0);
    }

    clients.forEach((client) => {
      const date = new Date(client.dataNegocio);
      if (Number.isNaN(date.getTime())) {
        return;
      }
      const monthIndex = (date.getFullYear() - now.getFullYear()) * 12 + date.getMonth() - now.getMonth() + 11;
      if (monthIndex >= 0 && monthIndex < counts.length) {
        counts[monthIndex] += 1;
      }
    });

    res.json({
      totalClients: clients.length,
      labels,
      counts,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao carregar estatísticas de clientes.' });
  }
});

app.get('/api/clients/export/csv', requireAuth, async (req, res) => {
  try {
    const clients = await dbAsync.all('SELECT nome, cpf, telefone, dataNegocio, observacoes FROM clients WHERE userId = $1 ORDER BY criadoEm DESC', [req.session.userId]);
    const rows = clients.map((client) => [client.nome, client.cpf, client.telefone, client.dataNegocio, client.observacoes || '']);
    const header = ['Nome', 'CPF', 'Telefone', 'DataNegocio', 'Observacoes'];
    const csv = [header.join(','), ...rows.map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes_export.csv"');
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao exportar clientes em CSV.' });
  }
});

app.get('/api/clients/export/xlsx', requireAuth, async (req, res) => {
  try {
    const clients = await dbAsync.all('SELECT nome, cpf, telefone, dataNegocio, observacoes FROM clients WHERE userId = $1 ORDER BY criadoEm DESC', [req.session.userId]);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clientes');
    sheet.columns = [
      { header: 'Nome', key: 'nome', width: 40 },
      { header: 'CPF', key: 'cpf', width: 20 },
      { header: 'Telefone', key: 'telefone', width: 20 },
      { header: 'DataNegocio', key: 'dataNegocio', width: 20 },
      { header: 'Observacoes', key: 'observacoes', width: 50 },
    ];
    clients.forEach((client) => {
      sheet.addRow({
        nome: client.nome,
        cpf: client.cpf,
        telefone: client.telefone,
        dataNegocio: client.dataNegocio,
        observacoes: client.observacoes || '',
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes_export.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao exportar clientes em XLSX.' });
  }
});

app.post('/api/clients/import', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo de importação não fornecido.' });
    }

    const ext = String(req.file.originalname || '').toLowerCase();
    const rows = [];
    if (ext.endsWith('.csv')) {
      const csvText = req.file.buffer.toString('utf8');
      const records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      records.forEach((record) => rows.push(record));
    } else if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const worksheet = workbook.worksheets[0];
      const headerRow = worksheet.getRow(1);
      const header = headerRow.values.slice(1).map((cell) => String(cell || '').trim().toLowerCase());
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const record = {};
        header.forEach((key, index) => {
          record[key] = row.getCell(index + 1).value || '';
        });
        rows.push(record);
      });
    } else {
      return res.status(400).json({ error: 'Tipo de arquivo não suportado. Use CSV ou XLSX.' });
    }

    const report = { total: rows.length, inserted: 0, skipped: 0, errors: [] };

    for (const [index, record] of rows.entries()) {
      const nome = String(record.nome || record.name || '').trim();
      const cpf = String(record.cpf || record.CPF || '').trim();
      const telefone = String(record.telefone || record.phone || '').trim();
      const dataNegocio = String(record.dataNegocio || record.data || record['data negocio'] || '').trim();
      const observacoes = String(record.observacoes || record.notes || record.observations || '').trim();

      if (!isValidName(nome) || !/\d{11}/.test(cpf.replace(/\D/g, '')) || !isValidPhone(telefone) || !dataNegocio) {
        report.skipped += 1;
        report.errors.push({ row: index + 2, reason: 'Dados inválidos ou incompletos.' });
        continue;
      }

      const clientId = `${Date.now()}-${Math.floor(Math.random() * 100000)}-${index}`;
      try {
        await dbAsync.run(
          'INSERT INTO clients (id, userId, nome, cpf, telefone, dataNegocio, observacoes, criadoEm) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [clientId, req.session.userId, nome, cpf, telefone, dataNegocio, observacoes, new Date().toISOString()]
        );
        report.inserted += 1;
      } catch (err) {
        report.skipped += 1;
        report.errors.push({ row: index + 2, reason: err.message });
      }
    }

    await createAuditLog(req.session.userId, 'importar_clientes', 'cliente', `Importação de clientes: ${report.inserted} inseridos, ${report.skipped} ignorados`, req);
    res.json(report);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao importar clientes.' });
  }
});

app.post(
  '/api/clients',
  requireAuth,
  [
    body('nome')
      .trim()
      .isLength({ min: 3, max: 60 })
      .withMessage('Nome deve ter entre 3 e 60 caracteres.')
      .matches(/^[A-Za-zÀ-ÿ ]+$/)
      .withMessage('Nome inválido.'),
    body('cpf')
      .trim()
      .matches(/^\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}$/)
      .withMessage('CPF inválido. Deve conter 11 dígitos.'),
    body('telefone')
      .trim()
      .custom((value) => {
        const digits = String(value || '').replace(/\D/g, '');
        return digits.length === 10 || digits.length === 11;
      })
      .withMessage('Telefone inválido. Deve conter 10 ou 11 dígitos.'),
    body('dataNegocio')
      .trim()
      .notEmpty()
      .withMessage('Data do negócio é obrigatória.'),
    body('observacoes').optional().trim(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { nome, cpf, telefone, dataNegocio, observacoes } = req.body;

      const clientId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      await dbAsync.run(
        'INSERT INTO clients (id, userId, nome, cpf, telefone, dataNegocio, observacoes, criadoEm) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
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

      const newClient = await dbAsync.get('SELECT * FROM clients WHERE id = $1 AND userId = $2', [clientId, req.session.userId]);
      res.status(201).json(newClient);
    } catch (error) {
      console.error('CLIENT ERROR:', error);
      res.status(500).json({
        error: 'Erro ao salvar cliente.',
        details: error.message,
      });
    }
  }
);

app.put(
  '/api/clients/:id',
  requireAuth,
  [
    body('nome')
      .trim()
      .isLength({ min: 3, max: 60 })
      .withMessage('Nome deve ter entre 3 e 60 caracteres.')
      .matches(/^[A-Za-zÀ-ÿ ]+$/)
      .withMessage('Nome inválido.'),
    body('cpf')
      .trim()
      .matches(/^\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}$/)
      .withMessage('CPF inválido. Deve conter 11 dígitos.'),
    body('telefone')
      .trim()
      .custom((value) => {
        const digits = String(value || '').replace(/\D/g, '');
        return digits.length === 10 || digits.length === 11;
      })
      .withMessage('Telefone inválido. Deve conter 10 ou 11 dígitos.'),
    body('dataNegocio')
      .trim()
      .notEmpty()
      .withMessage('Data do negócio é obrigatória.'),
    body('observacoes').optional().trim(),
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { nome, cpf, telefone, dataNegocio, observacoes } = req.body;

      const existing = await dbAsync.get('SELECT id FROM clients WHERE id = $1 AND userId = $2', [id, req.session.userId]);
      if (!existing) {
        return res.status(404).json({ error: 'Cliente não encontrado.' });
      }
      await dbAsync.run(
        'UPDATE clients SET nome = $1, cpf = $2, telefone = $3, dataNegocio = $4, observacoes = $5, atualizadoEm = $6 WHERE id = $7 AND userId = $8',
        [nome.trim(), cpf.trim(), telefone.trim(), dataNegocio.trim(), (observacoes || '').trim(), new Date().toISOString(), id, req.session.userId]
      );

      const updatedClient = await dbAsync.get('SELECT * FROM clients WHERE id = $1 AND userId = $2', [id, req.session.userId]);
      res.json(updatedClient);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro ao atualizar cliente.' });
    }
  }
);

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await dbAsync.get('SELECT * FROM clients WHERE id = $1 AND userId = $2', [id, req.session.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Cliente não encontrado.' });
    }
    await dbAsync.run('DELETE FROM clients WHERE id = $1 AND userId = $2', [id, req.session.userId]);
    
    await createAuditLog(req.session.userId, 'deletar_cliente', 'cliente', `Cliente excluído: ${existing.nome}`, req);
    
    res.json(existing);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao excluir cliente.' });
  }
});

// ============ NOVOS ENDPOINTS DE AUTENTICAÇÃO ============

// Alterar senha própria
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { senhaAtual, novaSenha, confirmaSenha } = req.body;
    
    if (!senhaAtual || !novaSenha || !confirmaSenha) {
      return res.status(400).json({ error: 'Preencha todos os campos.' });
    }
    
    if (novaSenha !== confirmaSenha) {
      return res.status(400).json({ error: 'As senhas não coincidem.' });
    }
    
    if (!isStrongPassword(novaSenha)) {
      return res.status(400).json({ 
        error: 'Senha fraca. Use 8+ caracteres, maiúscula, minúscula, número e caractere especial (ex: !@#$%^&*).' 
      });
    }
    
    const user = await dbAsync.get('SELECT password FROM users WHERE id = $1', [req.session.userId]);
    const senhaCorreta = await bcrypt.compare(senhaAtual, user.password);
    
    if (!senhaCorreta) {
      await createAuditLog(req.session.userId, 'alteracao_senha_falha', 'usuario', 'Tentativa de alteração com senha incorreta', req);
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }
    
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await dbAsync.run('UPDATE users SET password = $1 WHERE id = $2', [novoHash, req.session.userId]);
    
    await createAuditLog(req.session.userId, 'alteracao_senha', 'usuario', 'Senha alterada com sucesso', req);
    res.json({ ok: true, mensagem: 'Senha alterada com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao alterar senha.' });
  }
});

// Solicitar recuperação de senha
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email é obrigatório.' });
    }
    
    const user = await dbAsync.get('SELECT id, nome FROM users WHERE email = $1', [email]);
    if (!user) {
      // Não revelar se email existe ou não (segurança)
      return res.status(200).json({ ok: true, mensagem: 'Se o email existe na base, um link de recuperação foi enviado.' });
    }
    
    const token = generateResetToken();
    const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hora

    await dbAsync.run(
      'INSERT INTO password_reset_tokens (userId, token, expiresAt, criadoEm) VALUES ($1, $2, $3, $4)',
      [user.id, tokenHash, expiresAt, new Date().toISOString()]
    );
    
    // Enviar email de reset (ou log se SMTP não configurado)
    try {
      await sendResetEmail(email, user.nome, token, req);
    } catch (err) {
      console.error('Erro ao disparar email de reset:', err);
    }

    await createAuditLog(user.id, 'solicitar_reset_senha', 'usuario', 'Email de reset solicitado', req);

    res.json({ ok: true, mensagem: 'Se o email existe na base, um link de recuperação foi enviado.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao processar recuperação.' });
  }
});

// Validar token e resetar senha
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, novaSenha, confirmaSenha } = req.body;
    
    if (!token || !novaSenha || !confirmaSenha) {
      return res.status(400).json({ error: 'Preencha todos os campos.' });
    }
    
    if (novaSenha !== confirmaSenha) {
      return res.status(400).json({ error: 'As senhas não coincidem.' });
    }
    
    if (!isStrongPassword(novaSenha)) {
      return res.status(400).json({ 
        error: 'Senha fraca. Use 8+ caracteres, maiúscula, minúscula, número e caractere especial.' 
      });
    }
    
    const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
    const resetToken = await dbAsync.get(
      'SELECT userId FROM password_reset_tokens WHERE token = $1 AND usado = false AND expiresAt > $2',
      [tokenHash, new Date().toISOString()]
    );
    
    if (!resetToken) {
      return res.status(400).json({ error: 'Token inválido ou expirado.' });
    }
    
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await dbAsync.run('UPDATE users SET password = $1 WHERE id = $2', [novoHash, resetToken.userId]);
    await dbAsync.run('UPDATE password_reset_tokens SET usado = true WHERE token = $1', [tokenHash]);
    
    await createAuditLog(resetToken.userId, 'reset_senha', 'usuario', 'Senha resetada via token', req);

    // Enviar confirmação de alteração por e-mail se possível
    try {
      const usuario = await dbAsync.get('SELECT email, nome FROM users WHERE id = $1', [resetToken.userId]);
      if (usuario && usuario.email) {
        const html = `
          <p>Olá ${usuario.nome || ''},</p>
          <p>Sua senha foi alterada com sucesso. Se você não realizou essa alteração, entre em contato com o administrador imediatamente.</p>
        `;
        await sendEmail(usuario.email, 'Confirmação de alteração de senha - Agenda Eletrônica', html, req);
      }
    } catch (err) {
      console.error('Erro ao enviar confirmação por email:', err);
    }

    res.json({ ok: true, mensagem: 'Senha alterada com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao resetar senha.' });
  }
});

// ============ ENDPOINTS ADMINISTRATIVOS ============

// Bloquear usuário (Super Admin)
app.post('/api/admin/users/:userId/block', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { motivo } = req.body;
    
    const userToBlock = await dbAsync.get('SELECT role, nome FROM users WHERE id = $1', [userId]);
    
    if (!userToBlock) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    
    if (userToBlock.role === 'super_admin') {
      await createAuditLog(req.session.userId, 'bloquear_usuario_falha', 'usuario', `Tentativa de bloquear super_admin`, req);
      return res.status(403).json({ error: 'Não pode bloquear super_admin.' });
    }
    
    await dbAsync.run(
      'UPDATE users SET bloqueado = true, motivo_bloqueio = $1, data_bloqueio = $2 WHERE id = $3',
      [motivo || 'Bloqueado pelo administrador', new Date().toISOString(), userId]
    );
    
    await createAuditLog(req.session.userId, 'bloquear_usuario', 'usuario', `Usuário ${userToBlock.nome} bloqueado. Motivo: ${motivo}`, req);
    
    res.json({ ok: true, mensagem: 'Usuário bloqueado com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao bloquear usuário.' });
  }
});

// Desbloquear usuário (Super Admin)
app.post('/api/admin/users/:userId/unblock', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await dbAsync.get('SELECT nome FROM users WHERE id = $1', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    
    await dbAsync.run(
      'UPDATE users SET bloqueado = false, motivo_bloqueio = NULL, data_desbloqueio = $1 WHERE id = $2',
      [new Date().toISOString(), userId]
    );
    
    await createAuditLog(req.session.userId, 'desbloquear_usuario', 'usuario', `Usuário ${user.nome} desbloqueado`, req);
    
    res.json({ ok: true, mensagem: 'Usuário desbloqueado com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao desbloquear usuário.' });
  }
});

// Ativar usuário (Admin e Super Admin)
app.post('/api/admin/users/:userId/activate', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await dbAsync.get('SELECT nome FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await dbAsync.run('UPDATE users SET ativo = true, data_desbloqueio = $1 WHERE id = $2', [new Date().toISOString(), userId]);
    await createAuditLog(req.session.userId, 'ativar_usuario', 'usuario', `Usuário ${user.nome} ativado`, req);
    res.json({ ok: true, mensagem: 'Usuário ativado com sucesso.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao ativar usuário.' });
  }
});

// Desativar usuário (Admin e Super Admin)
app.post('/api/admin/users/:userId/deactivate', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { motivo } = req.body;
    const user = await dbAsync.get('SELECT nome FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await dbAsync.run('UPDATE users SET ativo = false, motivo_bloqueio = $1, data_bloqueio = $2 WHERE id = $3', [motivo || 'Desativado pelo administrador', new Date().toISOString(), userId]);
    await createAuditLog(req.session.userId, 'desativar_usuario', 'usuario', `Usuário ${user.nome} desativado. Motivo: ${motivo}`, req);
    res.json({ ok: true, mensagem: 'Usuário desativado com sucesso.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao desativar usuário.' });
  }
});

// Alteração de senha pelo administrador (Super Admin e Admin)
app.post('/api/admin/users/:userId/change-password', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { novaSenha } = req.body;
    if (!novaSenha || !isStrongPassword(novaSenha)) {
      return res.status(400).json({ error: 'Senha inválida ou fraca.' });
    }
    const user = await dbAsync.get('SELECT nome FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await dbAsync.run('UPDATE users SET password = $1 WHERE id = $2', [novoHash, userId]);
    await createAuditLog(req.session.userId, 'admin_change_password', 'usuario', `Senha alterada pelo admin para ${user.nome}`, req);
    res.json({ ok: true, mensagem: 'Senha alterada com sucesso.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao alterar senha do usuário.' });
  }
});

// Histórico do usuário (logs) - Admin e Super Admin
app.get('/api/admin/users/:userId/history', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const logs = await dbAsync.all('SELECT * FROM audit_logs WHERE userId = $1 ORDER BY criadoEm DESC LIMIT 1000', [userId]);
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar histórico do usuário.' });
  }
});

// Alterar role de usuário (Super Admin)
app.put('/api/admin/users/:userId/role', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { novoRole } = req.body;
    
    const rolesValidos = ['super_admin', 'admin', 'gerente', 'funcionario'];
    if (!rolesValidos.includes(novoRole)) {
      return res.status(400).json({ error: 'Role inválido.' });
    }
    
    const userAtual = await dbAsync.get('SELECT role, nome FROM users WHERE id = $1', [userId]);
    if (!userAtual) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    
    if (userAtual.role === 'super_admin' && novoRole !== 'super_admin') {
      await createAuditLog(req.session.userId, 'alterar_role_falha', 'usuario', `Tentativa de alterar role de super_admin`, req);
      return res.status(403).json({ error: 'Não pode alterar role de super_admin.' });
    }
    
    await dbAsync.run('UPDATE users SET role = $1 WHERE id = $2', [novoRole, userId]);
    
    await createAuditLog(req.session.userId, 'alterar_role', 'usuario', `Role de ${userAtual.nome} alterado para ${novoRole}`, req);
    
    res.json({ ok: true, mensagem: 'Role alterado com sucesso.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao alterar role.' });
  }
});

// Listar usuários (Super Admin e Admin)
app.get('/api/admin/users', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const users = await dbAsync.all(
      'SELECT id, nome, email, telefone, role, ativo, bloqueado, motivo_bloqueio, data_bloqueio, criadoEm FROM users ORDER BY criadoEm DESC'
    );
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

// Obter logs de auditoria (Super Admin e Admin)
app.get('/api/admin/audit-logs', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;
    
    const logs = await dbAsync.all(
      'SELECT * FROM audit_logs ORDER BY criadoEm DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    res.json(logs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar logs.' });
  }
});

// Preview do email de reset (Admin)
app.get('/api/admin/preview-reset-email', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const email = String(req.query.email || 'user@example.com');
    const name = String(req.query.name || 'Usuário');
    const token = generateResetToken();
    const resetUrl = `${req.protocol}://${req.get('host')}/?reset_token=${token}`;
    const html = `
      <div style="font-family: Arial, sans-serif; color: #111;">
        <h2>Redefinição de senha</h2>
        <p>Olá ${name},</p>
        <p>Recebemos uma solicitação para redefinir sua senha. Clique no link abaixo para criar uma nova senha. O link expira em 1 hora.</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>Se você não solicitou esta alteração, ignore este e-mail.</p>
      </div>
    `;
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Erro preview email:', err);
    res.status(500).json({ error: 'Erro ao gerar preview do email.' });
  }
});

// Enviar email de teste (Admin)
app.post('/api/admin/send-test-email', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });
    const token = generateResetToken();
    const sent = await sendResetEmail(email, name || 'Usuário', token, req);
    await createAuditLog(req.session.userId, 'enviar_teste_email', 'usuario', `Envio de email de teste para ${email}`, req);
    res.json({ ok: true, sent });
  } catch (err) {
    console.error('Erro ao enviar email de teste:', err);
    res.status(500).json({ error: 'Erro ao enviar email de teste.' });
  }
});

// Rota de fallback para front-end SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Exportar para testes e permitir import sem iniciar o servidor
module.exports = {
  app,
  pool,
  dbAsync,
  generateResetToken,
  isValidPassword,
  isValidPhone,
  isValidName,
  sanitizePhone,
  sendResetEmail,
  createAuditLog,
  initializePg,
  getCurrentUser,
  requireRole,
};

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}
