// The running build's version (from package.json) and the app's root folder.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const APP_ROOT = resolve(import.meta.dirname, '..');
export const VERSION = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')).version;
export const STARTED_AT = new Date();
