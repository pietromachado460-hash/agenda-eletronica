# Deploy / Supabase / Render

## Requisitos

- Node.js 18+ compatível com Render
- PostgreSQL disponível via `DATABASE_URL`
- SMTP configurado para envio de emails (opcional, mas recomendado)

## Configurar Supabase

1. Crie um projeto no Supabase.
2. Copie a `DATABASE_URL` do painel.
3. No banco, execute migrations ou deixe o app criar as tabelas automaticamente.

O app inicializa com as tabelas:
- `users`
- `clients`
- `audit_logs`
- `password_reset_tokens`

## Variáveis de ambiente

- `DATABASE_URL` - URL de conexão com PostgreSQL
- `PORT` - porta do servidor (opcional, padrão `3000`)
- `SMTP_HOST` - host SMTP (se desejar envio real)
- `SMTP_PORT` - porta SMTP (ex: `587`)
- `SMTP_USER` - usuário SMTP
- `SMTP_PASS` - senha SMTP
- `EMAIL_FROM` - remetente dos emails

## Deploy no Render

1. Crie um novo serviço web no Render apontando para este repositório.
2. Defina o `Start Command` como:

```bash
npm install && npm start
```

3. No painel de `Environment` adicione as variáveis acima.
4. Habilite SSL se necessário.

## Testar após deploy

- Acesse a URL do serviço.
- Abra a aplicação web e faça cadastro/login.
- Teste `forgot password` e `reset password`.
- Para ver preview do email, use `/api/admin/preview-reset-email?email=teste@example.com&name=Teste` com credenciais admin.

## Observações

- `DATABASE_URL` não deve ser alterado no código.
- O app precisa do banco para a maioria das operações; sem DB ele permite iniciar mas não funcionará completamente.
- Use `EMAIL_FROM` com domínio válido para evitar bloqueio de emails.
