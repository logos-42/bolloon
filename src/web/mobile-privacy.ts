/**
 * mobile-privacy.ts — 手机端隐私合规: 首启同意门 + 应用内政策摘要 + 本机数据注销
 *
 * 为什么单独成模块: 这三件事都必须能被单测锁住 —— 摘要少一个必填要素、同意版本号算错、
 * 注销漏删一个库, 都是"上架被拒/合规缺口"级别的问题, 不能只靠肉眼看 UI。
 *
 * 上架要求对照 (华为/工信部口径):
 *   ① 首次启动必须先展示隐私政策, 用户同意前不得收集任何信息/申请任何权限 → needsPrivacyConsent + 门
 *   ② 隐私政策须含: 收集类型 · 用途 · 存储期限 · 第三方 SDK 清单 · 账号注销路径 → PRIVACY_SUMMARY
 *   ③ 必须提供注销入口且处理时限 ≤ 7 个工作日 → WIPE_TARGETS + wipeLocalData (本地即时)
 */

/** localStorage 键: 记录用户已同意的政策版本 */
export const PRIVACY_CONSENT_KEY = 'bolloon_privacy_consent';

/** 政策版本: 摘要或权威页内容发生实质变化时必须 +1 → 会重新征求同意 */
export const PRIVACY_CONSENT_VERSION = '1';

/** 权威政策页 (应用市场表单要填的链接; 应用内摘要以它为准) */
export const PRIVACY_POLICY_URL = 'https://bolloon.cn/privacy.html';

/** APP 备案号: 备案完成后填入 (形如 浙ICP备XXXXXXXX号-XA), 留空时 UI 显示"备案办理中" */
export const APP_FILING_NO = '';

/** 主体联系邮箱 (政策里承诺 7 个工作日答复) */
export const PRIVACY_CONTACT = 'yuanjieliu65@gmail.com';

/** 注销时限承诺 (工作日) */
export const WIPE_SLA_WORKDAYS = 7;

export interface PrivacySummaryItem {
  /** 小节标题 */
  title: string;
  /** 小节正文 (纯文本, UI 直接渲染) */
  body: string;
}

/**
 * 应用内政策摘要 —— 必须覆盖上架要求的必填要素。
 * 单测逐个要素断言 (mobile-privacy.test.ts), 删要素即红。
 */
export const PRIVACY_SUMMARY: PrivacySummaryItem[] = [
  {
    title: '一、我们收集什么',
    body:
      '本机生成的网络身份标识（DID）与密钥、你创建的智能体、会话与消息内容、好友与已知节点列表。' +
      '这些数据默认只保存在你自己的设备上（IndexedDB），我们不设账号体系，不收集手机号、邮箱、通讯录、' +
      '短信、通话记录、精确定位、设备唯一标识（IMEI/MAC/广告标识），也不做使用行为统计。',
  },
  {
    title: '二、用途',
    body:
      '上述数据仅用于提供你要求的功能：P2P 连接与身份验证、智能体会话、本地存储与展示。' +
      '我们不用于广告、画像或向第三方出售。',
  },
  {
    title: '三、存储位置与期限',
    body:
      '全部保存在本机。卸载应用或在「设置 → 清除本机数据（注销）」即删除；我们服务器上没有你的副本，' +
      '因此不存在"提交删除申请后还要等待"的环节。',
  },
  {
    title: '四、第三方 SDK 与服务',
    body:
      '你自选的大模型服务商（API Key 由你填写，你的设备直连该服务商，我们不经手）；' +
      '网站与安装包托管 Cloudflare / GitHub（境外）、版本号查询 npm registry、网页字体 Google Fonts。' +
      '本应用不集成任何广告、行为统计或崩溃上报 SDK。若你启用微支付，链上交易记录公开且不可删除。',
  },
  {
    title: '五、系统权限',
    body:
      '蓝牙扫描与连接：发现并连接附近设备与好友（已声明 neverForLocation，不用于推断位置）。' +
      '位置权限：仅 Android 11 及以下系统要求蓝牙扫描需要它（已限制 maxSdkVersion=30，Android 12+ 不再申请）。' +
      '网络：P2P 连接与下载。相机：调用系统相机应用完成拍摄，本应用不申请相机权限。' +
      '跨 App 点按、滑动屏幕或调用系统能力所需的 Android 无障碍与 Shizuku：仅官网直装版本包含，属于可选扩展能力；' +
      '手机端基础 Agent 不依赖这些权限即可直接运行。应用商店下载的版本不含跨 App 控制能力。',
  },
  {
    title: '六、你的权利与注销',
    body:
      '你可以随时在本机查看、修改、删除全部数据。注销入口：设置 → 清除本机数据（注销），' +
      '即时删除本机数据（异常情况最长 ' + WIPE_SLA_WORKDAYS + ' 个工作日）。' +
      '已经写入公开区块链的交易记录任何服务方都无法删除。',
  },
  {
    title: '七、联系我们',
    body: '疑问或投诉请发邮件至 ' + PRIVACY_CONTACT + '，我们会在 ' + WIPE_SLA_WORKDAYS + ' 个工作日内答复。',
  },
];

/**
 * 是否需要弹同意门。
 * @param stored 本机已记录的同意值 (localStorage.getItem(PRIVACY_CONSENT_KEY))
 * @returns true = 需要征求同意 (未同意 / 版本过期 / 值非法)
 */
export function needsPrivacyConsent(stored: string | null | undefined): boolean {
  if (typeof stored !== 'string') return true;
  return stored.trim() !== PRIVACY_CONSENT_VERSION;
}

/** 同意后写入的值 */
export function consentRecord(): string {
  return PRIVACY_CONSENT_VERSION;
}

/** 备案号展示文案 (未备案时如实说明, 不伪造编号) */
export function filingDisplay(no: string = APP_FILING_NO): string {
  const v = (no || '').trim();
  return v ? `APP 备案号 ${v}` : 'APP 备案号：备案办理中';
}

/**
 * 注销要清掉的东西 —— 清单必须与"我们声明收集的数据"一一对应, 少一个就是合规缺口。
 * 注意: 不删 consent 记录 (同意记录不是个人信息, 且删了会在注销后立刻再弹一次门)。
 */
export const WIPE_TARGETS = {
  /** IndexedDB 库 (名称与各模块里的常量逐一核对过) */
  databases: ['bolloon-mobile-data', 'bolloon-mobile', 'bolloon-mobile-payments', 'bolloon'],
  /** localStorage 键前缀: 命中即清 */
  localStoragePrefixes: ['bolloon_', 'bolloon.', 'bolloon-'],
  /** 明确保留: 同意记录 + 界面偏好 (不含个人信息) */
  keep: [PRIVACY_CONSENT_KEY, 'bolloon-lang', 'bolloon_theme'],
} as const;

/** 注销后给用户看的说明 (诚实: 链上记录删不掉) */
export const WIPE_NOTICE =
  '已删除本机的身份标识（DID）、智能体、会话消息与钱包账本。' +
  '已经写入公开区块链的交易记录无法删除，这一点任何服务方都做不到。' +
  `如遇异常，我们的处理时限为 ${WIPE_SLA_WORKDAYS} 个工作日（${PRIVACY_CONTACT}）。`;

/** 同意门文案 (集中在这里, 便于审计与翻译) */
export const CONSENT_TEXT = {
  title: '隐私政策与权限说明',
  intro:
    'Bolloon 是本地优先的：没有账号体系，不收集手机号或邮箱，你的智能体、会话与消息只存在这台设备上。' +
    '在你点击「同意并继续」之前，应用不会读取本机数据、不会连接网络、也不会申请任何系统权限。',
  agree: '同意并继续',
  decline: '不同意',
  policyLink: '阅读完整隐私政策',
  declinedTitle: '未同意，已停在说明页',
  declinedBody:
    '你可以继续留在本页查阅说明，或退出应用。我们不会在此状态下收集任何信息。' +
    '随时重新打开应用都可以再次选择。',
  declinedReread: '重新阅读',
  declinedExit: '退出应用',
} as const;

export interface WipeResult {
  /** 删掉的 IndexedDB 库 */
  deletedDatabases: string[];
  /** 清掉的 localStorage 键 */
  clearedStorageKeys: string[];
  /** 失败项 (如实返回, 不假装成功) */
  failed: string[];
}

/** 删除单个 IndexedDB 库 (供没有 reset 导出的模块使用, 如钱包库) */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(); return; }
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // 还有别的连接开着时会 blocked: 不等死, 如实返回 (下次启动会清掉)
    req.onblocked = () => resolve();
  });
}

/**
 * 注销 / 清除本机数据 —— 应用内唯一的删除入口。
 * 覆盖: 身份 DID+密钥库 · 智能体与会话消息库 · 支付库 · 钱包库 · localStorage 里的本机键。
 * 不覆盖: 公开区块链上的历史交易 (任何服务方都删不了, 文案里已向用户说明)。
 */
export async function wipeLocalData(): Promise<WipeResult> {
  const result: WipeResult = { deletedDatabases: [], clearedStorageKeys: [], failed: [] };

  // ① 三个自带 reset 的库: 复用模块自己的实现 (它们会先关闭连接, 避免 onblocked)
  const resets: Array<[string, () => Promise<unknown>]> = [
    ['bolloon-mobile-data', async () => (await import('./mobile-data.js')).resetDataDb()],
    ['bolloon-mobile', async () => (await import('./mobile-agent.js')).resetAgentDb()],
    ['bolloon-mobile-payments', async () => (await import('./mobile-payments.js')).resetPaymentsDb()],
  ];
  for (const [name, fn] of resets) {
    try {
      await fn();
      result.deletedDatabases.push(name);
    } catch (e) {
      result.failed.push(`${name}: ${(e as Error)?.message || String(e)}`);
    }
  }

  // ② 钱包库 (mobile-wallet.ts) 没有 reset 导出 → 直接删库
  try {
    await deleteDatabase('bolloon');
    result.deletedDatabases.push('bolloon');
  } catch (e) {
    result.failed.push(`bolloon: ${(e as Error)?.message || String(e)}`);
  }

  // ③ localStorage: 按前缀清, 保留同意记录与界面偏好
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    const keep = WIPE_TARGETS.keep as readonly string[];
    for (const k of keys) {
      const hit = WIPE_TARGETS.localStoragePrefixes.some((p) => k.startsWith(p));
      if (!hit || keep.includes(k)) continue;
      localStorage.removeItem(k);
      result.clearedStorageKeys.push(k);
    }
  } catch (e) {
    result.failed.push(`localStorage: ${(e as Error)?.message || String(e)}`);
  }

  return result;
}
