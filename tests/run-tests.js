const assert = require('assert');
const { generateResetToken, isValidPassword, isValidPhone, isValidName, sanitizePhone } = require('../server');

try {
  console.log('Rodando testes básicos...');

  const t1 = generateResetToken();
  const t2 = generateResetToken();
  assert.strictEqual(typeof t1, 'string');
  assert.strictEqual(typeof t2, 'string');
  assert.notStrictEqual(t1, t2);
  assert.ok(t1.length > 10, 'Token muito curto');

  assert.strictEqual(isValidPassword('12345678'), true);
  assert.strictEqual(isValidPassword('abc'), false);
  assert.strictEqual(isValidPassword(''), false);

  assert.strictEqual(sanitizePhone('(11) 91234-5678'), '11912345678');
  assert.strictEqual(isValidPhone('(11) 91234-5678'), true);
  assert.strictEqual(isValidPhone('1234'), false);

  assert.strictEqual(isValidName('João da Silva'), true);
  assert.strictEqual(isValidName('A'), false);
  assert.strictEqual(isValidName('NomeCom123'), false);

  console.log('Todos os testes básicos passaram.');
  process.exit(0);
} catch (err) {
  console.error('Teste falhou:', err.message);
  console.error(err);
  process.exit(1);
}
