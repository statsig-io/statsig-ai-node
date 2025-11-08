import path from 'path';

export function getDCSFilePath(filename: string) {
  return path.join(__dirname, filename);
}
