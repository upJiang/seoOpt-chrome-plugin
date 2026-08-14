import type { AuditRule } from './helpers';

function metricRule(options: {
  id: string;
  title: string;
  points: number;
  key: 'lcp' | 'cls' | 'fcp' | 'ttfb';
  unit: string;
  good: number;
  poor: number;
  recommendation: string;
}): AuditRule {
  return {
    id: options.id,
    title: options.title,
    category: 'performance',
    points: options.points,
    run(snapshot) {
      const value = snapshot.performance[options.key];
      if (value === null) {
        return {
          status: 'not_measurable',
          evidence: '本次浏览会话没有足够样本。',
          impact: '该指标退出分母，不按失败处理。',
          explanation: '单次会话指标不是搜索平台的真实用户字段数据。',
          recommendation: '积累真实用户数据，并在可复现环境重新测试。',
          verification: '结合实验室瀑布和真实用户分位数。',
          owner: '开发',
          includedInScore: false,
        };
      }
      const formatted = options.key === 'cls' ? value.toFixed(3) : Math.round(value).toString();
      if (value > options.poor) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `本次访问样本 ${options.title} 为 ${formatted}${options.unit}。`,
          impact: '当前访问存在明显体验风险。',
          explanation: '这是本次浏览会话信号，不等同于真实用户字段结论。',
          recommendation: options.recommendation,
          verification: '修复后在相同设备网络复测，并观察真实用户 75 分位。',
          observationPeriod: '实验室可立即复测；真实用户数据至少观察一个完整数据周期。',
          effort: '中',
          owner: '开发',
          confidence: 'medium',
          scoreRatio: 0.5,
          includedInScore: false,
        };
      }
      if (value > options.good) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `本次访问样本 ${options.title} 为 ${formatted}${options.unit}。`,
          impact: '体验处于需要改进区间。',
          explanation: '单次会话只能定位线索，不能替代字段数据。',
          recommendation: options.recommendation,
          verification: '结合资源、长任务或布局变化定位具体瓶颈。',
          observationPeriod: '实验室立即复测，字段数据按平台更新周期观察。',
          effort: '中',
          owner: '开发',
          confidence: 'medium',
          includedInScore: false,
        };
      }
      return {
        status: 'pass',
        evidence: `本次访问样本 ${options.title} 为 ${formatted}${options.unit}。`,
        impact: '当前样本处于良好区间。',
        explanation: '单次良好结果仍不能证明所有真实用户都良好。',
        recommendation: '继续用真实用户 75 分位和低端设备监控。',
        verification: '对主要模板分别建立字段监控。',
        observationPeriod: '持续观察真实用户数据。',
        owner: '开发',
        confidence: 'medium',
        includedInScore: false,
      };
    },
  };
}

export const performanceRules: AuditRule[] = [
  metricRule({
    id: 'performance.lcp',
    title: 'LCP',
    points: 3,
    key: 'lcp',
    unit: 'ms',
    good: 2500,
    poor: 4000,
    recommendation: '优先检查首屏图片、字体、阻塞资源、服务器响应和渲染等待。',
  }),
  metricRule({
    id: 'performance.cls',
    title: 'CLS',
    points: 2,
    key: 'cls',
    unit: '',
    good: 0.1,
    poor: 0.25,
    recommendation: '为媒体和异步组件预留空间，检查字体替换和动态插入内容。',
  }),
  metricRule({
    id: 'performance.fcp',
    title: 'FCP',
    points: 2,
    key: 'fcp',
    unit: 'ms',
    good: 1800,
    poor: 3000,
    recommendation: '检查服务器响应、阻塞 CSS、字体、首屏脚本和客户端渲染等待。',
  }),
  metricRule({
    id: 'performance.ttfb',
    title: 'TTFB',
    points: 2,
    key: 'ttfb',
    unit: 'ms',
    good: 800,
    poor: 1800,
    recommendation: '检查源站、数据库、模板渲染、缓存和 CDN 回源。',
  }),
  {
    id: 'performance.viewport',
    title: '移动端 viewport',
    category: 'performance',
    points: 1,
    run(snapshot) {
      if (!/width\s*=\s*device-width/i.test(snapshot.viewportMeta)) {
        return {
          status: 'failure',
          priority: 'P1',
          evidence: snapshot.viewportMeta || '没有 viewport meta。',
          impact: '移动端可能以桌面宽度缩放，影响阅读和交互。',
          explanation: '响应式页面需要正确声明设备宽度。',
          recommendation: '添加标准 viewport，且不要禁用用户缩放。',
          verification: '在窄屏设备检查布局、文字、点击区域和横向滚动。',
          owner: '开发',
          codeExample: '<meta name="viewport" content="width=device-width, initial-scale=1">',
        };
      }
      return {
        status: 'pass',
        evidence: snapshot.viewportMeta,
        impact: '页面具备响应式视口基础。',
        explanation: 'viewport 声明包含 device-width。',
        recommendation: '继续在真实移动设备验证，不只依赖标签。',
        verification: '检查 320px 以上视口无横向滚动和遮挡。',
        owner: '开发',
      };
    },
  },
];
