import { isAbsolute, normalize } from 'node:path';
import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';

// Only validate and forward paths. File bytes never enter MCP or the Hub.
export async function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 100) throw new Error('files must be an array of at most 100 absolute file paths; [] clears selection');
  for (const file of files) {
    if (typeof file !== 'string' || !isAbsolute(file) || file.includes('\0')) throw new Error('Every file path must be absolute');
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`Not a regular file (directory upload is unsupported): ${file}`);
    await access(file, constants.R_OK);
  }
  return files.map(file => normalize(file));
}
