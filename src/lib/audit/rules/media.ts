import type { AuditRule } from './helpers';
import { firstLocator } from './helpers';

export const mediaRules: AuditRule[] = [
  {
    id: 'media.image-alt',
    title: '图片替代文本',
    category: 'media',
    points: 3,
    run(snapshot) {
      if (snapshot.images.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有图片。',
          impact: '图片规则不参与评分。',
          explanation: '没有可评估对象。',
          recommendation: '无。',
          verification: '新增图片后重新扫描。',
        };
      }
      const missing = snapshot.images.filter((image) => image.alt === null);
      const riskyEmpty = snapshot.images.filter(
        (image) => image.alt === '' && image.role !== 'presentation' && image.insideLink,
      );
      const affected = [...missing, ...riskyEmpty];
      if (affected.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${missing.length} 张图片缺少 alt 属性，${riskyEmpty.length} 张链接图片使用空 alt。`,
          impact: '图片信息和链接目的可能无法被理解。',
          explanation: '纯装饰图可使用空 alt，传递信息或承担链接的图片需要准确描述。',
          recommendation: '按图片在当前页面中的任务编写 Alt，不复制文件名或堆关键词。',
          verification: '隐藏图片后确认文字仍能传递同等信息。',
          owner: '内容',
          locator: firstLocator(affected),
          codeExample: '<img src="chart.webp" alt="自然搜索点击在三个月内的变化趋势">',
        };
      }
      return {
        status: 'pass',
        evidence: `${snapshot.images.length} 张图片均显式声明了 alt。`,
        impact: '图片替代策略具备基础完整性。',
        explanation: '未发现缺失 alt 或链接图片空名称。',
        recommendation: '仍需人工确认 Alt 是否准确描述信息任务。',
        verification: '抽样比较图片、上下文和 Alt。',
        owner: '内容',
        locator: firstLocator(snapshot.images),
      };
    },
  },
  {
    id: 'media.image-dimensions',
    title: '图片尺寸稳定性',
    category: 'media',
    points: 2,
    run(snapshot) {
      if (snapshot.images.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有图片。',
          impact: '该规则不参与评分。',
          explanation: '没有可评估对象。',
          recommendation: '无。',
          verification: '新增图片后重新扫描。',
        };
      }
      const unstable = snapshot.images.filter((image) => !image.hasStableDimensions);
      if (unstable.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${unstable.length}/${snapshot.images.length} 张图片没有尺寸属性或稳定比例。`,
          impact: '图片加载时可能造成布局移动。',
          explanation: '浏览器需要在资源到达前预留正确空间。',
          recommendation: '声明 width/height，或使用与资源比例一致的 aspect-ratio 容器。',
          verification: '慢速网络下观察布局，并复测 CLS。',
          owner: '开发',
          locator: firstLocator(unstable),
          codeExample: '<img src="image.webp" width="960" height="540" alt="...">',
        };
      }
      return {
        status: 'pass',
        evidence: '所有图片都有尺寸属性或稳定比例。',
        impact: '图片加载前可以预留布局空间。',
        explanation: '未发现明显尺寸缺失。',
        recommendation: '响应式裁剪时继续保持资源与容器比例一致。',
        verification: '在窄屏、宽屏和慢速网络复测。',
        owner: '开发',
        locator: firstLocator(snapshot.images),
      };
    },
  },
  {
    id: 'media.image-alt-quality',
    title: '图片替代文本质量候选',
    category: 'media',
    points: 0,
    run(snapshot) {
      const risky = snapshot.images.filter((image) => image.altRisk);
      if (!risky.length) {
        return {
          status: 'pass',
          scoreRatio: null,
          evidence: '没有发现明显的重复、文件名式或标题复制 Alt 候选。',
          impact: '当前检查未发现明显 Alt 复用风险。',
          explanation: 'Alt 是否准确仍需结合图片和附近正文人工确认。',
          recommendation: '保持 Alt 描述图片传递的信息，不把页面标题当作所有图片的 Alt。',
          verification: '抽样查看图片、附近正文和最终渲染结果。',
          owner: '内容',
        };
      }
      const labels = risky.reduce<Record<string, number>>((counts, image) => {
        const key = image.altRisk || 'unknown';
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
      return {
        status: 'warning',
        priority: 'P2',
        scoreRatio: null,
        evidence: `发现 ${risky.length} 张图片存在 Alt 质量候选：${Object.entries(labels).map(([key, count]) => `${key} ${count}`).join('、')}。`,
        impact: '图片语义可能重复或无法补充正文信息，影响图片理解和可访问性。',
        explanation: '存在 Alt 不等于描述质量合格；重复标题和文件名通常不能表达图片任务。',
        recommendation: '按图片的具体信息编写描述；装饰图使用空 Alt，链接图片必须说明点击目的。',
        verification: '修复后重新扫描并抽样比较图片、上下文和 Alt。',
        owner: '内容',
        locator: firstLocator(risky),
      };
    },
  },
  {
    id: 'media.loading-priority',
    title: '首屏图片加载优先级',
    category: 'media',
    points: 2,
    run(snapshot) {
      const initialImages = snapshot.images.filter((image) => image.inInitialViewport && image.renderedArea > 0);
      if (initialImages.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '首屏没有可见图片。',
          impact: '该规则不参与评分。',
          explanation: '没有首屏媒体对象。',
          recommendation: '无。',
          verification: '页面设计变化后复查。',
        };
      }
      const largest = [...initialImages].sort((a, b) => b.renderedArea - a.renderedArea)[0]!;
      if (largest.loading.toLocaleLowerCase() === 'lazy') {
        return {
          status: 'warning',
          priority: 'P1',
          evidence: '首屏最大图片设置了 loading="lazy"。',
          impact: '主要视觉内容和 LCP 可能被延迟。',
          explanation: '首屏主图通常应尽快请求，屏外图片再懒加载。',
          recommendation: '移除首屏主图的普通懒加载，并按真实资源优先级配置。',
          verification: '比较资源瀑布、LCP 和首屏可见时间。',
          owner: '开发',
          locator: largest.locator,
          codeExample: '<img src="hero.webp" width="1280" height="720" fetchpriority="high" alt="...">',
        };
      }
      return {
        status: 'pass',
        evidence: '首屏最大图片未使用普通懒加载。',
        impact: '主要视觉资源没有被显式延迟。',
        explanation: '当前首屏加载策略符合基础优先级。',
        recommendation: '屏外图片再使用 loading="lazy"。',
        verification: '通过资源瀑布确认真实请求顺序。',
        owner: '开发',
        locator: largest.locator,
      };
    },
  },
  {
    id: 'media.json-ld',
    title: 'JSON-LD 语法',
    category: 'media',
    points: 2,
    run(snapshot) {
      if (snapshot.jsonLd.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有 JSON-LD。',
          impact: '缺失结构化数据不会直接扣分。',
          explanation: '结构化数据应按页面类型和真实内容选择，不是所有页面必需。',
          recommendation: '只有能与可见事实一致时再添加。',
          verification: '选择页面类型后使用对应验证工具。',
        };
      }
      const invalid = snapshot.jsonLd.filter((item) => !item.valid);
      if (invalid.length > 0) {
        return {
          status: 'failure',
          priority: 'P2',
          evidence: `${invalid.length}/${snapshot.jsonLd.length} 段 JSON-LD 无法解析：${invalid[0]!.error || '语法错误'}`,
          impact: '结构化信息可能被忽略，影响富结果资格，但不等同于页面无法索引。',
          explanation: '模板变量、转义或尾随逗号常造成无效 JSON。',
          recommendation: '先修复 JSON 语法，再核对字段与可见正文是否一致。',
          verification: '解析最终 HTML 中每段 JSON-LD，并运行富结果验证。',
          owner: '开发',
          locator: invalid[0]!.locator,
        };
      }
      const semanticIssues = snapshot.jsonLd.flatMap((item) => item.schema?.issues ?? []);
      const mismatches = snapshot.jsonLd.flatMap((item) => item.schema?.visibleMismatchFields ?? []);
      if (semanticIssues.length || mismatches.length) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `JSON-LD 可解析，但发现 ${semanticIssues.length} 个字段语义候选${mismatches.length ? `，${mismatches.length} 个字段与可见页面不一致` : ''}。${semanticIssues[0]?.message || ''}`,
          impact: '结构化信息可能被忽略或无法获得预期富结果；这不等同于页面无法索引。',
          explanation: '搜索引擎不仅需要合法 JSON，还需要页面类型、日期、作者、商品字段与可见事实一致。',
          recommendation: '先按页面类型补齐或修正字段，禁止标记正文没有展示的评分、价格、库存或作者。',
          verification: '检查最终 HTML 的字段值，并使用对应 Schema/富结果验证工具复核。',
          owner: '联合',
          locator: firstLocator(snapshot.jsonLd),
        };
      }
      return {
        status: 'pass',
        evidence: `${snapshot.jsonLd.length} 段 JSON-LD 均可解析，类型为 ${snapshot.jsonLd.flatMap((item) => item.types).join(', ') || '未声明'}。`,
        impact: '结构化数据具备语法基础。',
        explanation: '可解析不等于符合特定富结果要求。',
        recommendation: '继续核对价格、库存、作者、日期等字段与可见事实。',
        verification: '使用对应 Schema 和搜索平台验证工具。',
        owner: 'SEO',
        locator: snapshot.jsonLd[0]!.locator,
      };
    },
  },
  {
    id: 'media.conditional',
    title: '视频与多语言条件信号',
    category: 'media',
    points: 1,
    run(snapshot) {
      if (snapshot.videos.length === 0 && snapshot.hreflangs.length === 0) {
        return {
          status: 'not_applicable',
          evidence: '页面没有视频或 hreflang。',
          impact: '条件规则不参与评分。',
          explanation: '只对实际存在的媒体和多语言信号评估。',
          recommendation: '无。',
          verification: '新增后重新扫描。',
        };
      }
      const riskyVideos = snapshot.videos.filter((video) => !video.poster || !video.hasTextFallback);
      const invalidLangs = snapshot.hreflangs.filter((item) => !item.valid);
      const affectedLocator = (riskyVideos[0] ?? invalidLangs[0])?.locator;
      if (riskyVideos.length > 0 || invalidLangs.length > 0) {
        return {
          status: 'warning',
          priority: 'P2',
          evidence: `${riskyVideos.length} 个视频缺少 Poster 或文字上下文；${invalidLangs.length} 个 hreflang 无效。`,
          impact: '媒体可能拖慢首屏，多语言版本关系也可能无法识别。',
          explanation: '视频需要稳定封面和文字信息，hreflang 需要有效语言码与 URL。',
          recommendation: '为视频补充 Poster/摘要；修复 hreflang 语言码和绝对地址。',
          verification: '禁用视频加载后检查信息完整性，并验证语言版本映射。',
          owner: '联合',
          locator: affectedLocator,
        };
      }
      return {
        status: 'pass',
        evidence: `${snapshot.videos.length} 个视频和 ${snapshot.hreflangs.length} 个 hreflang 未发现基础错误。`,
        impact: '条件信号具备基础完整性。',
        explanation: '当前静态检查未发现明显缺失或格式问题。',
        recommendation: 'hreflang 互相引用和视频性能仍需跨页验证。',
        verification: '检查语言页互返和真实资源瀑布。',
        owner: '联合',
        locator: (snapshot.videos[0] ?? snapshot.hreflangs[0])?.locator,
      };
    },
  },
];
