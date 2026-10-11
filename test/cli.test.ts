import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';

describe('cli', () => {
  it('reports its version', () => {
    let out = '';
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => { out += s; } });
    expect(() => program.parse(['node', 'trustbut', '--version'])).toThrow();
    expect(out.trim()).toBe('0.0.1');
  });
});
