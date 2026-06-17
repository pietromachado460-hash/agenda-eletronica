const {
  generateResetToken,
  isValidPassword,
  isValidPhone,
  isValidName,
  sanitizePhone,
} = require('../server');

describe('Helpers básicos', () => {
  test('generateResetToken gera token único e de tamanho esperado', () => {
    const t1 = generateResetToken();
    const t2 = generateResetToken();
    expect(typeof t1).toBe('string');
    expect(typeof t2).toBe('string');
    expect(t1).not.toBe(t2);
    expect(t1.length).toBeGreaterThan(10);
  });

  test('isValidPassword valida regras simples', () => {
    expect(isValidPassword('123456')).toBe(true);
    expect(isValidPassword('abc')).toBe(false);
    expect(isValidPassword('')).toBe(false);
  });

  test('sanitizePhone e isValidPhone funcionam corretamente', () => {
    expect(sanitizePhone('(11) 91234-5678')).toBe('11912345678');
    expect(isValidPhone('(11) 91234-5678')).toBe(true);
    expect(isValidPhone('1234')).toBe(false);
  });

  test('isValidName aceita nomes razoáveis', () => {
    expect(isValidName('João da Silva')).toBe(true);
    expect(isValidName('A')).toBe(false);
    expect(isValidName('NomeComCaracteres123')).toBe(false);
  });
});
