import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: {
    disabled: process.env.SEO_OPT_MANUAL_CHROME === '1',
  },
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'zh_CN',
    version: '0.6.0',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'tabs', 'scripting', 'storage', 'sidePanel'],
    optional_host_permissions: [
      'https://*/*',
      'http://*/*',
    ],
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
