import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function checkMissingDockerImages(images) {
  const unique = [...new Set(images.filter(Boolean))];
  const checks = await Promise.all(unique.map(async (image) => {
    try {
      await execFileAsync('docker', ['image', 'inspect', image], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return null;
    } catch (err) {
      const detail = [err?.stderr, err?.stdout, err?.message].filter(Boolean).join('\n');
      if (/no such (?:image|object)/i.test(detail)) return image;
      throw err;
    }
  }));
  return checks.filter(Boolean);
}
