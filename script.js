const API_BASE = `${window.location.protocol}//${window.location.host}/api`;
const clientForm = document.getElementById('clientForm');
const nameInput = document.getElementById('nameInput');
const cpfInput = document.getElementById('cpfInput');
const phoneInput = document.getElementById('phoneInput');
const dateInput = document.getElementById('dateInput');
const notesInput = document.getElementById('notesInput');
const searchInput = document.getElementById('searchInput');
const searchType = document.getElementById('searchType');
const searchStartDate = document.getElementById('searchStartDate');
const searchEndDate = document.getElementById('searchEndDate');
const filterMessage = document.getElementById('filterMessage');
const filterStatus = document.getElementById('filterStatus');
const clientTableBody = document.getElementById('clientTableBody');
const emptyState = document.getElementById('emptyState');
const totalCount = document.getElementById('totalCount');
const clearFilters = document.getElementById('clearFilters');
const formHeading = document.getElementById('formHeading');
const loginForm = document.getElementById('loginForm');
const loginPhoneInput = document.getElementById('loginPhoneInput');
const loginPasswordInput = document.getElementById('loginPasswordInput');
const registerForm = document.getElementById('registerForm');
const registerNameInput = document.getElementById('registerNameInput');
const registerPhoneInput = document.getElementById('registerPhoneInput');
const registerPasswordInput = document.getElementById('registerPasswordInput');
const registerConfirmPasswordInput = document.getElementById('registerConfirmPasswordInput');
const authMessage = document.getElementById('authMessage');
const authView = document.getElementById('authView');
const dashboardView = document.getElementById('dashboardView');
const currentUserName = document.getElementById('currentUserName');
const currentUserRole = document.getElementById('currentUserRole');
const logoutButton = document.getElementById('logoutButton');
const authSwitchButtons = Array.from(document.querySelectorAll('.auth-switch'));

// Elementos do menu de usuário
const userMenuButton = document.getElementById('userMenuButton');
const userMenuDropdown = document.getElementById('userMenuDropdown');
const adminMenuOption = document.getElementById('adminMenuOption');

// Elementos de Perfil
const profileSection = document.getElementById('profile-section');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profilePhone = document.getElementById('profilePhone');
const profileRole = document.getElementById('profileRole');

// Elementos de Alterar Senha
const changePasswordSection = document.getElementById('change-password-section');
const changePasswordForm = document.getElementById('changePasswordForm');
const changePasswordMessage = document.getElementById('changePasswordMessage');

// Elementos de Admin
const adminSection = document.getElementById('admin-section');
const adminTabs = Array.from(document.querySelectorAll('.admin-tab'));
const adminUsersTab = document.getElementById('admin-users-tab');
const adminAuditTab = document.getElementById('admin-audit-tab');
const adminUsersTableBody = document.getElementById('adminUsersTableBody');
const adminAuditTableBody = document.getElementById('adminAuditTableBody');

let editingClientId = null;
let lastClients = [];
let currentUser = null;

function formatName(value) {
  return value.replace(/[^A-Za-zÀ-ÿ ]/g, '').replace(/\s{2,}/g, ' ');
}

function formatCPF(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function formatPhone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 11);

  if (digits.length <= 10) {
    return digits
      .replace(/(\d{2})(\d)/, '($1) $2')
      .replace(/(\d{4})(\d{0,4})$/, '$1-$2')
      .trim();
  }

  return digits
    .replace(/(\d{2})(\d)/, '($1) $2')
    .replace(/(\d{1})(\d{4})(\d{0,4})$/, '$1 $2-$3')
    .trim();
}

function isPhoneValid(value) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 11;
}

function isCPFValid(value) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11;
}

function isNameValid(value) {
  const trimmed = value.trim();
  return /^[A-Za-zÀ-ÿ ]{3,60}$/.test(trimmed);
}

function setAuthMessage(message) {
  authMessage.textContent = message;
}

function clearAuthMessage() {
  authMessage.textContent = '';
}

function showView(view) {
  const showDashboard = view === 'dashboard';
  dashboardView.classList.toggle('hidden', !showDashboard);
  authView.classList.toggle('hidden', showDashboard);
}

function showAuthMode(mode) {
  const isRegister = mode === 'register';
  authSwitchButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  registerForm.classList.toggle('hidden', !isRegister);
  loginForm.classList.toggle('hidden', isRegister);
  document.getElementById('authTitle').textContent = isRegister ? 'Criar conta' : 'Bem-vindo de volta';
  document.getElementById('authSubtitle').textContent = isRegister
    ? 'Cadastre-se com telefone e senha para acessar sua agenda.'
    : 'Faça login com seu telefone e senha para acessar sua agenda.';
  clearAuthMessage();
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function showAlert(message) {
  alert(message);
}

function togglePasswordVisibility(event) {
  const button = event.currentTarget;
  const targetId = button.dataset.target;
  const input = document.getElementById(targetId);
  if (!input) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  button.textContent = isPassword ? 'Ocultar' : 'Mostrar';
}

async function safeFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await parseJsonSafe(response);
  if (response.status === 401) {
    showView('auth');
    throw new Error(data?.error || 'Sessão expirada. Faça login novamente.');
  }

  if (!response.ok) {
    throw new Error(data?.error || `Erro ${response.status}`);
  }

  return data;
}

async function loadSession() {
  try {
    const user = await safeFetch('/auth/me', { method: 'GET' });
    currentUser = user;
    currentUserName.textContent = user.nome;
    currentUserRole.textContent = user.role.toUpperCase();
    
    // Mostrar menu admin se for super_admin ou admin
    if (user.role === 'super_admin' || user.role === 'admin') {
      adminMenuOption.classList.remove('hidden');
    }
    
    showView('dashboard');
    fetchClients();
  } catch (error) {
    showView('auth');
  }
}

async function handleLogin(event) {
  if (event) {
    event.preventDefault();
  }
  clearAuthMessage();

  const telefone = loginPhoneInput.value.trim();
  const senha = loginPasswordInput.value;

  if (!isPhoneValid(telefone)) {
    setAuthMessage('Telefone inválido. Use 10 ou 11 dígitos.');
    return;
  }

  if (!senha) {
    setAuthMessage('Senha não pode ficar em branco.');
    return;
  }

  try {
    await safeFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ telefone, senha }),
    });
    await loadSession();
  } catch (error) {
    setAuthMessage(error.message);
  }
}

async function handleRegister(event) {
  if (event) {
    event.preventDefault();
  }
  clearAuthMessage();

  const nome = registerNameInput.value.trim();
  const telefone = registerPhoneInput.value.trim();
  const senha = registerPasswordInput.value;
  const confirmSenha = registerConfirmPasswordInput.value;

  if (!isNameValid(nome)) {
    setAuthMessage('Nome inválido. Use apenas letras e espaços entre 3 e 60 caracteres.');
    return;
  }

  if (!isPhoneValid(telefone)) {
    setAuthMessage('Telefone inválido. Use 10 ou 11 dígitos.');
    return;
  }

  if (!senha || senha.length < 6) {
    setAuthMessage('Senha deve ter pelo menos 6 caracteres.');
    return;
  }

  if (senha !== confirmSenha) {
    setAuthMessage('As senhas não coincidem.');
    return;
  }

  try {
    await safeFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ nome, telefone, senha, confirmSenha }),
    });
    await loadSession();
  } catch (error) {
    setAuthMessage(error.message);
  }
}

async function logout() {
  try {
    await safeFetch('/auth/logout', { method: 'POST' });
    currentUser = null;
    showView('auth');
  } catch (error) {
    showAlert(error.message);
  }
}

// ======= NOVO: FUNÇÕES DE MENU DE USUÁRIO =======
function toggleUserMenu() {
  userMenuDropdown.classList.toggle('hidden');
}

function closeUserMenu() {
  userMenuDropdown.classList.add('hidden');
}

// ======= NOVO: FUNÇÕES DE PERFIL =======
function showProfileSection() {
  profileName.textContent = currentUser.nome;
  profileEmail.textContent = currentUser.email || '—';
  profilePhone.textContent = currentUser.telefone;
  profileRole.textContent = currentUser.role.toUpperCase();
  
  profileSection.classList.remove('hidden');
  clientForm.parentElement.classList.add('hidden');
  closeUserMenu();
}

// ======= NOVO: FUNÇÕES DE ALTERAÇÃO DE SENHA =======
function showChangePasswordSection() {
  changePasswordSection.classList.remove('hidden');
  clientForm.parentElement.classList.add('hidden');
  changePasswordMessage.textContent = '';
  closeUserMenu();
}

async function handleChangePassword(event) {
  event.preventDefault();
  changePasswordMessage.textContent = '';

  const senhaAtual = document.getElementById('currentPasswordInput').value;
  const novaSenha = document.getElementById('newPasswordInput').value;
  const confirmaSenha = document.getElementById('confirmNewPasswordInput').value;

  if (!senhaAtual || !novaSenha || !confirmaSenha) {
    changePasswordMessage.textContent = 'Preencha todos os campos.';
    return;
  }

  if (novaSenha !== confirmaSenha) {
    changePasswordMessage.textContent = 'As senhas não coincidem.';
    return;
  }

  if (novaSenha.length < 8) {
    changePasswordMessage.textContent = 'Senha deve ter pelo menos 8 caracteres.';
    return;
  }

  try {
    const result = await safeFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ senhaAtual, novaSenha, confirmaSenha }),
    });
    
    changePasswordMessage.textContent = result.mensagem;
    changePasswordForm.reset();
    
    setTimeout(() => {
      showProfileSection();
    }, 2000);
  } catch (error) {
    changePasswordMessage.textContent = error.message;
  }
}

// ======= NOVO: FUNÇÕES DE ADMIN =======
function showAdminSection() {
  adminSection.classList.remove('hidden');
  clientForm.parentElement.classList.add('hidden');
  closeUserMenu();
  loadAdminUsers();
}

async function loadAdminUsers() {
  try {
    const users = await safeFetch('/admin/users', { method: 'GET' });
    adminUsersTableBody.innerHTML = '';

    if (users.length === 0) {
      document.getElementById('adminUsersEmpty').classList.remove('hidden');
      return;
    }

    document.getElementById('adminUsersEmpty').classList.add('hidden');

    users.forEach((user) => {
      const roleColors = {
        'super_admin': '#4f46e5',
        'admin': '#3b82f6',
        'gerente': '#8b5cf6',
        'funcionario': '#6b7280',
      };

      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${user.nome}</td>
        <td>${user.email || '—'}</td>
        <td>${user.telefone}</td>
        <td><span style="color: ${roleColors[user.role] || '#94a3b8'}">${user.role.toUpperCase()}</span></td>
        <td>
          <span class="status-badge ${user.bloqueado ? 'status-blocked' : 'status-active'}">
            ${user.bloqueado ? '🔒 Bloqueado' : '✓ Ativo'}
          </span>
        </td>
        <td>
          <div class="action-buttons">
            ${user.role !== 'super_admin' ? `
              <button class="btn-icon btn-block-user" data-userid="${user.id}" data-blocked="${user.bloqueado}">
                ${user.bloqueado ? '🔓 Desbloquear' : '🔒 Bloquear'}
              </button>
            ` : ''}
            ${currentUser.role === 'super_admin' && user.role !== 'super_admin' ? `
              <button class="btn-icon btn-change-role" data-userid="${user.id}">⚡ Cargo</button>
            ` : ''}
          </div>
        </td>
      `;

      adminUsersTableBody.appendChild(row);
    });
  } catch (error) {
    showAlert('Erro ao carregar usuários: ' + error.message);
  }
}

async function loadAdminAuditLogs() {
  try {
    const logs = await safeFetch('/admin/audit-logs?limit=500', { method: 'GET' });
    adminAuditTableBody.innerHTML = '';

    if (logs.length === 0) {
      document.getElementById('adminAuditEmpty').classList.remove('hidden');
      return;
    }

    document.getElementById('adminAuditEmpty').classList.add('hidden');

    logs.forEach((log) => {
      const row = document.createElement('tr');
      const data = new Date(log.criadoEm).toLocaleString('pt-BR');
      
      row.innerHTML = `
        <td>${data}</td>
        <td>${log.userId || '—'}</td>
        <td>${log.acao}</td>
        <td>${log.recurso || '—'}</td>
        <td>${log.descricao || '—'}</td>
        <td><small>${log.ip}</small></td>
      `;

      adminAuditTableBody.appendChild(row);
    });
  } catch (error) {
    showAlert('Erro ao carregar logs: ' + error.message);
  }
}

// ======= NOVO: AÇÕES ADMIN =======
async function handleBlockUser(userId, isBlocked) {
  const motivo = prompt(isBlocked ? 'Desbloquear usuário?' : 'Motivo do bloqueio:');
  
  if (motivo === null) return;

  try {
    if (isBlocked) {
      await safeFetch(`/admin/users/${userId}/unblock`, { method: 'POST' });
    } else {
      await safeFetch(`/admin/users/${userId}/block`, {
        method: 'POST',
        body: JSON.stringify({ motivo }),
      });
    }
    
    loadAdminUsers();
    showAlert(isBlocked ? 'Usuário desbloqueado.' : 'Usuário bloqueado.');
  } catch (error) {
    showAlert('Erro: ' + error.message);
  }
}

async function handleChangeRole(userId) {
  const newRole = prompt('Novo cargo (super_admin, admin, gerente, funcionario):');
  
  if (newRole === null) return;

  try {
    await safeFetch(`/admin/users/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ novoRole: newRole }),
    });
    
    loadAdminUsers();
    showAlert('Cargo alterado com sucesso.');
  } catch (error) {
    showAlert('Erro: ' + error.message);
  }
}

function updateTable(clients) {
  clientTableBody.innerHTML = '';
  if (!clients.length) {
    emptyState.style.display = 'block';
    emptyState.textContent = 'Nenhum cliente encontrado.';
    totalCount.textContent = '0 clientes encontrados';
    filterStatus.textContent = 'Nenhum cliente encontrado para os filtros atuais.';
    return;
  }
  emptyState.style.display = 'none';
  totalCount.textContent = `${clients.length} cliente${clients.length > 1 ? 's' : ''} encontrado${clients.length > 1 ? 's' : ''}`;
  filterStatus.textContent = `${clients.length} cliente${clients.length > 1 ? 's' : ''} encontrado${clients.length > 1 ? 's' : ''} no filtro.`;
  clients.forEach((client) => clientTableBody.appendChild(createRow(client)));
}

async function fetchClients() {
  const search = searchInput.value.trim();
  const type = searchType.value;
  const startDate = searchStartDate.value;
  const endDate = searchEndDate.value;

  if ((startDate && !endDate) || (!startDate && endDate)) {
    filterMessage.textContent = 'Preencha as duas datas para pesquisar por intervalo.';
    filterMessage.style.color = '#fbbf24';
  } else if (startDate && endDate) {
    filterMessage.textContent = `Buscando clientes entre ${startDate} e ${endDate}.`;
    filterMessage.style.color = '#8be9fd';
  } else {
    filterMessage.textContent = '';
  }

  const params = { search, type };
  if (startDate && endDate) {
    params.startDate = startDate;
    params.endDate = endDate;
  }

  try {
    const clients = await safeFetch(`/clients?${new URLSearchParams(params).toString()}`);
    if (!Array.isArray(clients)) {
      throw new Error('Resposta inesperada do servidor.');
    }
    lastClients = clients;
    updateTable(clients);
  } catch (error) {
    if (error.message.includes('Sessão expirada') || error.message.includes('Não autenticado')) {
      showView('auth');
      return;
    }
    console.error(error);
    emptyState.style.display = 'block';
    emptyState.textContent = 'Não foi possível carregar os clientes. Verifique se o servidor está rodando.';
    totalCount.textContent = 'Erro ao carregar clientes';
  }
}

function createRow(client) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${client.nome}</td>
    <td>${client.cpf}</td>
    <td>${client.telefone}</td>
    <td>${client.dataNegocio}</td>
    <td>${client.observacoes || '—'}</td>
    <td>
      <div class="action-buttons">
        <button type="button" class="btn-icon btn-edit" data-action="edit" data-id="${client.id}">Editar</button>
        <button type="button" class="btn-icon btn-delete" data-action="delete" data-id="${client.id}">Excluir</button>
      </div>
    </td>
  `;
  return row;
}

function updateFormState(isEditing) {
  formHeading.textContent = isEditing ? 'Editando cliente' : 'Novo cliente';
  const submitButton = clientForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.textContent = isEditing ? 'Salvar alterações' : 'Salvar cliente';
  }
}

function clearEditState() {
  editingClientId = null;
  clientForm.reset();
  updateFormState(false);
}

function setEditClient(client) {
  editingClientId = client.id;
  nameInput.value = client.nome;
  cpfInput.value = client.cpf;
  phoneInput.value = client.telefone;
  dateInput.value = client.dataNegocio;
  notesInput.value = client.observacoes || '';
  updateFormState(true);
  window.location.hash = '#form-section';
}

async function deleteClient(id) {
  const result = await safeFetch(`/clients/${id}`, { method: 'DELETE' });
  return result;
}

async function updateClient(id, data) {
  const result = await safeFetch(`/clients/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return result;
}

async function saveClient(data) {
  const result = await safeFetch('/clients', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return result;
}

nameInput.addEventListener('input', (event) => {
  event.target.value = formatName(event.target.value);
});

cpfInput.addEventListener('input', (event) => {
  event.target.value = formatCPF(event.target.value);
});

phoneInput.addEventListener('input', (event) => {
  event.target.value = formatPhone(event.target.value);
});

registerNameInput.addEventListener('input', (event) => {
  event.target.value = formatName(event.target.value);
});

registerPhoneInput.addEventListener('input', (event) => {
  event.target.value = formatPhone(event.target.value);
});

loginPhoneInput.addEventListener('input', (event) => {
  event.target.value = formatPhone(event.target.value);
});

searchInput.addEventListener('input', () => fetchClients());
searchType.addEventListener('change', () => {
  updateSearchPlaceholder();
  fetchClients();
});
searchStartDate.addEventListener('change', () => fetchClients());
searchEndDate.addEventListener('change', () => fetchClients());
clearFilters.addEventListener('click', () => {
  searchInput.value = '';
  searchStartDate.value = '';
  searchEndDate.value = '';
  searchType.value = 'nome';
  updateSearchPlaceholder();
  fetchClients();
});

clientTableBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const action = button.dataset.action;
  const id = button.dataset.id;
  const client = lastClients.find((item) => item.id === id);

  if (!client) {
    showAlert('Cliente não encontrado. Atualize a lista e tente novamente.');
    return;
  }

  if (action === 'edit') {
    setEditClient(client);
    return;
  }

  if (action === 'delete') {
    const confirmed = confirm(`Tem certeza que deseja excluir ${client.nome}?`);
    if (!confirmed) return;
    try {
      await deleteClient(id);
      fetchClients();
      if (editingClientId === id) {
        clearEditState();
      }
      showAlert('Cliente excluído com sucesso.');
    } catch (error) {
      showAlert(error.message);
    }
  }
});

clientForm.addEventListener('reset', () => {
  clearEditState();
});

clientForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const clientData = {
    nome: nameInput.value.trim(),
    cpf: cpfInput.value.trim(),
    telefone: phoneInput.value.trim(),
    dataNegocio: dateInput.value,
    observacoes: notesInput.value.trim(),
  };

  if (!isNameValid(clientData.nome)) {
    showAlert('Nome deve conter apenas letras e espaços, entre 3 e 60 caracteres.');
    return;
  }

  if (!isCPFValid(clientData.cpf)) {
    showAlert('CPF deve ter 11 dígitos no formato 000.000.000-00.');
    return;
  }

  if (!isPhoneValid(clientData.telefone)) {
    showAlert('Telefone deve ter 10 ou 11 dígitos válidos.');
    return;
  }

  try {
    if (editingClientId) {
      await updateClient(editingClientId, clientData);
      showAlert('Cliente atualizado com sucesso!');
    } else {
      await saveClient(clientData);
      showAlert('Cliente salvo com sucesso!');
    }
    clearEditState();
    fetchClients();
  } catch (error) {
    showAlert(error.message);
  }
});

loginForm.addEventListener('submit', (event) => event.preventDefault());
registerForm.addEventListener('submit', (event) => event.preventDefault());
registerForm.addEventListener('click', (event) => {
  if (event.target.id === 'registerSubmitButton') {
    handleRegister(event);
  }
});
loginForm.addEventListener('click', (event) => {
  if (event.target.id === 'loginSubmitButton') {
    handleLogin(event);
  }
});
logoutButton.addEventListener('click', logout);
authSwitchButtons.forEach((button) => {
  button.addEventListener('click', () => {
    showAuthMode(button.dataset.mode);
  });
});

const passwordToggleButtons = Array.from(document.querySelectorAll('.toggle-password-btn'));
passwordToggleButtons.forEach((button) => {
  button.addEventListener('click', togglePasswordVisibility);
});

// ======= NOVO: EVENT LISTENERS DO MENU DE USUÁRIO =======
userMenuButton.addEventListener('click', toggleUserMenu);

// Fechar menu ao clicar em links
document.querySelectorAll('.user-menu-dropdown a').forEach((link) => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    if (href === '#profile-section') {
      e.preventDefault();
      showProfileSection();
    } else if (href === '#change-password-section') {
      e.preventDefault();
      showChangePasswordSection();
    } else if (href === '#admin-section') {
      e.preventDefault();
      showAdminSection();
    }
  });
});

// Fechar menu ao clicar em logout
// logoutButton já tem o event listener

// ======= NOVO: EVENT LISTENERS DO PERFIL =======
document.querySelectorAll('a[href="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    profileSection.classList.add('hidden');
    changePasswordSection.classList.add('hidden');
    adminSection.classList.add('hidden');
    clientForm.parentElement.classList.remove('hidden');
  });
});

// ======= NOVO: EVENT LISTENER DO FORMULÁRIO DE ALTERAR SENHA =======
changePasswordForm.addEventListener('submit', handleChangePassword);

// ======= NOVO: EVENT LISTENERS DAS ABAS DO ADMIN =======
adminTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    adminTabs.forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach((content) => {
      content.classList.remove('active');
    });

    tab.classList.add('active');
    const tabName = tab.dataset.tab;

    if (tabName === 'users') {
      adminUsersTab.classList.add('active');
      loadAdminUsers();
    } else if (tabName === 'audit') {
      adminAuditTab.classList.add('active');
      loadAdminAuditLogs();
    }
  });
});

// ======= NOVO: EVENT LISTENERS DE AÇÕES ADMIN =======
adminUsersTableBody.addEventListener('click', async (event) => {
  const blockBtn = event.target.closest('.btn-block-user');
  const roleBtn = event.target.closest('.btn-change-role');

  if (blockBtn) {
    const userId = blockBtn.dataset.userid;
    const isBlocked = blockBtn.dataset.blocked === 'true';
    await handleBlockUser(parseInt(userId), isBlocked);
  }

  if (roleBtn) {
    const userId = roleBtn.dataset.userid;
    await handleChangeRole(parseInt(userId));
  }
});

function updateSearchPlaceholder() {
  const labels = {
    nome: 'Buscar por nome',
    cpf: 'Buscar por CPF',
    telefone: 'Buscar por telefone',
    observacoes: 'Buscar por observações',
  };
  searchInput.placeholder = labels[searchType.value] || 'Buscar';
}

window.addEventListener('load', () => {
  updateSearchPlaceholder();
  showAuthMode('register');
  loadSession();
});
