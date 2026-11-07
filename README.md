# DSH OA 插件

把 OA 的工作日志接进 [DeepSeek Harness](https://github.com/FM618)（DSH 桌面版 / Web 版）。
在 DSH 侧边栏直接看周视图、记日志，不用切浏览器。

## 能力

- **工作日志**：甘特周视图 / 列表视图切换、新建、编辑、删除、按周翻页
- **一次登录，重启免登录**：令牌存在 DSH 的凭据服务里，不进浏览器
- **服务器地址可自助配置**：设置里的「OA 连接」，填地址 → 测试连接 → 登录
- **连不上时说清楚原因**：地址格式、网络不通、版本不兼容，分开提示

## 安装

在 DSH 侧边栏「插件」→ **Add plugin**，填：

```
@fm618/oa
```

安装后启用，然后在 **设置 → OA 连接** 里：

1. 填服务器地址（例如 `https://oa.example.com`，不带路径）
2. 点「测试并保存」——会校验地址、连通性与版本兼容
3. 输入 OA 账号登录

> 企业部署可用环境变量 `OA_SERVER_URL` 预置地址，用户侧就免去第一步。

## 也可以分开安装

总装包只是把下面两个包一次装好。需要精细控制时也可以单独安装，**顺序是先运行时、后模块**：

```bash
dsh plugin add @fm618/oa-runtime    # 运行时：连接 / 登录 / 令牌
dsh plugin add @fm618/oa-worklog    # 工作日志模块
```

模块缺少运行时会静默等待（不报错、不工作），所以别把顺序弄反。

## 包说明

| 包 | 作用 |
| :--- | :--- |
| `@fm618/oa` | 总装包：只含装配清单，装它一次带出下面两个 |
| `@fm618/oa-runtime` | 运行时：服务器地址、登录、令牌、连接诊断、设置页入口 |
| `@fm618/oa-worklog` | 工作日志模块：列表 / 甘特 / 详情 / 增删改 |

## 环境要求

| 项 | 要求 |
| :--- | :--- |
| DSH | 0.2 及以上（桌面版 / Web 版） |
| OA 服务端 | 提供客户端接口面 `/api/client/v1/**` 与发现端点 `/.well-known/oa-server` |
| 服务端最低客户端版本 | 不低于 `0.1.0`（插件会读取并校验，低于要求时拒绝连接） |
| Node（仅开发） | ≥ 22，pnpm ≥ 9 |

## 开发

```bash
pnpm install
pnpm -r build          # 构建 host 与 client 两半部
pnpm check:client      # 冒烟渲染 + 样式键 + 版本一致性
pnpm run pack          # 产出 dist/*.tgz
```

发布流程见 [RELEASING.md](RELEASING.md)。

## 许可

[Apache-2.0](LICENSE)。分发时请保留 [NOTICE](NOTICE) 中的归属声明。
名称与标识的使用边界见 [TRADEMARK.md](TRADEMARK.md)。

公司主页：https://www.fm618.com
