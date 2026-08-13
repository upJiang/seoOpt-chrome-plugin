const fallback: Record<string, string> = {
  tabOverview: '概览',
  tabIssues: '问题',
  tabRecommendations: '优化建议',
  tabAi: 'AI 深度解读',
  scanPage: '扫描当前页面',
  rescan: '重新扫描',
  settings: '设置',
};

export function t(key: keyof typeof fallback): string {
  return chrome.i18n?.getMessage(key) || fallback[key] || key;
}
