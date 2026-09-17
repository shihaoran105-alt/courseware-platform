/**
 * 服务商预设（服务端与静态版共用，不要引入任何 Node 依赖）
 * 都是 OpenAI 兼容的 /chat/completions 接口。
 */
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（推荐）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '便宜、中文好，注册后在「API Keys」页面创建。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长上下文，适合超长课件。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '需要可访问 OpenAI 的网络环境。',
  },
  {
    id: 'custom',
    name: '自定义（其他 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    keyUrl: '',
    note: '填入自己的接口地址与模型名，需支持 /chat/completions。',
  },
];

export const DEFAULT_KEY_URL = 'https://platform.deepseek.com/api_keys';
