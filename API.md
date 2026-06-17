# API - Agenda Eletrônica CRM

## Autenticação e usuários

### `POST /api/auth/register`
Cadastro de usuário.
Body JSON:
- `nome` (string)
- `telefone` (string)
- `senha` (string)
- `confirmSenha` (string)

Resposta 201:
- `id`, `nome`, `telefone`

### `POST /api/auth/login`
Login de usuário.
Body JSON:
- `telefone` (string)
- `senha` (string)

Resposta 200:
- `id`, `nome`, `telefone`, `email`, `role`

### `POST /api/auth/logout`
Logout do usuário autenticado.

### `GET /api/auth/me`
Retorna o usuário autenticado.

### `POST /api/auth/change-password`
Alterar senha após login.
Body JSON:
- `currentPassword`
- `newPassword`
- `confirmPassword`

### `POST /api/auth/forgot-password`
Solicita reset de senha via email.
Body JSON:
- `email`

### `POST /api/auth/reset-password`
Redefinir senha por token.
Body JSON:
- `token`
- `newPassword`
- `confirmPassword`

## Admin / RBAC

Todas as rotas abaixo exigem `super_admin` ou `admin`.

### `GET /api/admin/users`
Retorna usuários cadastrados.

### `POST /api/admin/users/block`
Bloquear usuário.
Body JSON:
- `userId`
- `motivo`

### `POST /api/admin/users/unblock`
Desbloquear usuário.
Body JSON:
- `userId`

### `POST /api/admin/users/role`
Alterar role de usuário.
Body JSON:
- `userId`
- `role`

### `GET /api/admin/audit-logs`
Retorna logs de auditoria.

### `GET /api/admin/preview-reset-email?email=&name=`
Retorna HTML de preview do email de reset.

### `POST /api/admin/send-test-email`
Envia email de teste.
Body JSON:
- `email`
- `name`
