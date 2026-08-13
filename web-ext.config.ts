import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineWebExtConfig } from 'wxt';

const chromeCandidates = [
  process.env.CHROME_PATH,
  process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined,
  process.platform === 'win32'
    ? `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`
    : undefined,
  process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
].filter((candidate): candidate is string => Boolean(candidate));

const chromeBinary = chromeCandidates.find(existsSync);
const chromeProfile = resolve('.chrome-dev-profile');

mkdirSync(chromeProfile, { recursive: true });

export default defineWebExtConfig({
  ...(chromeBinary ? { binaries: { chrome: chromeBinary } } : {}),
  chromiumProfile: chromeProfile,
  keepProfileChanges: true,
  openDevtools: process.env.SEO_OPT_OPEN_DEVTOOLS === '1',
  chromiumArgs: ['--no-first-run', '--no-default-browser-check'],
  chromiumPref: {
    extensions: {
      ui: {
        developer_mode: true,
      },
    },
  },
});
