const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const dbAsync = {
  async get(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows[0];
  },
  async all(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows;
  },
  async run(sql, params = []) {
    const res = await pool.query(sql, params);
    return res;
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
    process.exit(1);
  }
}

initializePg();

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
    const user = await dbAsync.get('SELECT id, nome, telefone, password FROM users WHERE telefone = $1', [normalizedPhone]);
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
    details: error.message
  });
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
});

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
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hora
    
    await dbAsync.run(
      'INSERT INTO password_reset_tokens (userId, token, expiresAt, criadoEm) VALUES ($1, $2, $3, $4)',
      [user.id, token, expiresAt, new Date().toISOString()]
    );
    
    // TODO: Enviar email com link de reset usando Nodemailer
    console.log(`Token de reset para ${email}: ${token}`);
    
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
    
    const resetToken = await dbAsync.get(
      'SELECT userId FROM password_reset_tokens WHERE token = $1 AND usado = false AND expiresAt > $2',
      [token, new Date().toISOString()]
    );
    
    if (!resetToken) {
      return res.status(400).json({ error: 'Token inválido ou expirado.' });
    }
    
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await dbAsync.run('UPDATE users SET password = $1 WHERE id = $2', [novoHash, resetToken.userId]);
    await dbAsync.run('UPDATE password_reset_tokens SET usado = true WHERE token = $1', [token]);
    
    await createAuditLog(resetToken.userId, 'reset_senha', 'usuario', 'Senha resetada via token', req);
    
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
