# @fm618/oa-bundle

OA 插件总装包：**不含业务代码**，只有装配清单。装它等于一次装好：

- `@fm618/oa-runtime` —— 连接、登录、令牌、设置页（含模块契约类型）
- `@fm618/oa-worklog` —— 工作日志模块

## 安装

在 DSH 侧边栏「插件」→ Add plugin 里填包名即可。

## 只装部分模块

总装包适合"一次装齐"。如果你只需要某个模块，也可以单独安装：

```bash
dsh plugin add @fm618/oa-runtime      # 运行时：必装
dsh plugin add @fm618/oa-worklog      # 工作日志
```

**顺序：先 runtime，后模块。** 模块缺 runtime 会静默 pending（不报错、不工作），
所以自己组合时务必先装 runtime。

> 契约（类型 + `OaApiError`）**内置在 `@fm618/oa-runtime`**，不需要单独安装任何契约包。
