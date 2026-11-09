import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LENGTH, maskPii } from '../../src/domain/services/PiiMasker';

describe('maskPii', () => {
  const cases: Array<[string, string, string]> = [
    ['email', 'escribime a Juan.Perez+x@Mail.com ya', 'escribime a [EMAIL] ya'],
    ['url http', 'mirá https://banco.com/x?id=1 ahora', 'mirá [URL] ahora'],
    ['url www', 'entra a www.banco.com/login', 'entra a [URL]'],
    ['cbu', 'mi cbu 0170099220000067797370 es', 'mi cbu [CBU] es'],
    ['card spaces', 'tarjeta 4509 9535 6623 3704 vencida', 'tarjeta [CARD] vencida'],
    ['card dashes', 'tarjeta 4509-9535-6623-3704', 'tarjeta [CARD]'],
    ['card contiguous', 'tarjeta 4509953566233704', 'tarjeta [CARD]'],
    ['cuit dashes', 'CUIT 20-12345678-3', 'CUIT [CUIT]'],
    ['cuit contiguous', 'cuit 20123456783', 'cuit [CUIT]'],
    ['phone intl', 'llamame al +54 9 11 5555-1234 gracias', 'llamame al [PHONE] gracias'],
    ['phone area', 'tel 011 5555-1234', 'tel [PHONE]'],
    ['phone 15', 'cel 15-5555-1234', 'cel [PHONE]'],
    ['dni dotted', 'mi dni es 12.345.678 y mi mail a@b.com', 'mi dni es [DNI] y mi mail [EMAIL]'],
    ['dni plain', 'dni 12345678', '[DNI]'],
    ['dni 7 digits', 'documento 1234567', 'documento [DNI]'],
    ['num', 'operacion 123456789 pendiente', 'operacion [NUM] pendiente'],
    ['short numbers kept', 'quiero 3 cuotas en 12 meses', 'quiero 3 cuotas en 12 meses'],
    ['whitespace collapsed', '  hola   \n  mundo  ', 'hola mundo'],
  ];

  it.each(cases)('masks %s', (_label, input, expected) => {
    expect(maskPii(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const [, input] of cases) {
      const once = maskPii(input);
      expect(maskPii(once)).toBe(once);
    }
  });

  it('is deterministic', () => {
    expect(maskPii('dni 12.345.678')).toBe(maskPii('dni 12.345.678'));
  });

  it('masks before capping so a DNI straddling the limit leaves no digit fragment', () => {
    for (let offset = 480; offset <= 500; offset++) {
      const text = `${'a'.repeat(offset)} 12345678 ${'b'.repeat(2000)}`;
      const out = maskPii(text);
      expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_LENGTH);
      expect(out).not.toMatch(/\d/);
    }
  });

  it('honours a custom max length', () => {
    expect(maskPii('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });

  it('handles non-string input safely', () => {
    expect(maskPii(undefined as unknown as string)).toBe('');
  });
});
