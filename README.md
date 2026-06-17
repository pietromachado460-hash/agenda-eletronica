# Agenda Eletrônica CRM

Agenda Eletrônica é um CRM web simples com autenticação, controle de acesso por papéis (RBAC), bloqueio de usuários, recuperação de senha por token, auditoria e controle de clientes.

## Como executar

1. Instale as dependências:

```bash
npm install
```

2. Configure variáveis de ambiente. Crie um arquivo `.env` baseado em `.env.example`:
   - `DATABASE_URL`
   - `PORT` (opcional, padrão `3000`)
   - `SESSION_SECRET` (recomendado em produção)
   - `SMTP_HOST` (opcional)
   - `SMTP_PORT` (opcional)
   - `SMTP_USER` (opcional)
   - `SMTP_PASS` (opcional)
   - `EMAIL_FROM` (opcional)

3. Inicie o servidor:

```bash
node server.js
```

3. Acesse a aplicação em:

```text
http://localhost:3000
```

## Testes

Instale dependências antes de rodar os testes:

```bash
npm install
```

Testes básicos de unidade são executados com Node.js puro:

```bash
node tests/run-tests.js
```

Se quiser executar com Jest após instalação, use:

```bash
npm run test:jest
```

## Documentação

- `API.md` - especificação de rotas
- `DEPLOY.md` - instruções de deploy em Supabase/Render
