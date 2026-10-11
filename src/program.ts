import { Command } from 'commander';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('trustbut')
    .description('Verifiable receipts for code written by AI coding agents')
    .version(VERSION);
  return program;
}
