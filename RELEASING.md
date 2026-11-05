# 发布手册

面向维护者。用户侧安装说明见 [`plugins/oa-bundle/README.md`](plugins/oa-bundle/README.md)。

## 0. 一次性准备

| 步骤 | 做什么 | 说明 |
| :--- | :--- | :--- |
| 1 | 注册 npm 账号 | **用公司邮箱**，不用个人邮箱 |
| 2 | 开启 2FA | npm 对发布操作要求二次验证 |
| 3 | 建组织：[npmjs.com/org/create](https://www.npmjs.com/org/create) | 组织名必须是 **`fm618`**，直接决定 scope |
| 4 | 邀请维护者 | 按最小权限分配，不要共用一个账号 |
| 5 | `npm login` | 本机登录一次即可 |

> **`@fm618` 是"先到先得"的公共命名空间**：2026-11-05 查过无记录。
> 别人可以先注册，注册后你就用不了——尽早建。

## 1. 版本与内容

```bash
cd oa-plugin
# 改版本号：四个包的 version 必须一起改
pnpm -r exec npm version patch --no-git-tag-version
```

- 版本保持一致（总装包与其他三个同版本，便于排查）；
- `0.x` 阶段 minor 版本允许破坏性变更，`1.0.0` 之后再严格遵守 semver；
- 每个包发布时会自动带上 `LICENSE`、`NOTICE`（已写进 `files`）。

## 2. 打包

```bash
pnpm run pack        # 产物在 dist/，四个 tgz
```

包名形如 `fm618-oa-0.1.0.tgz`（scope 里的 `@` 和 `/` 被替换为 `-`）。

## 3. 发布（顺序不能反）

```bash
npm publish dist/fm618-plugin-kit-0.1.0.tgz   --access public
npm publish dist/fm618-oa-runtime-0.1.0.tgz   --access public
npm publish dist/fm618-oa-worklog-0.1.0.tgz   --access public
npm publish dist/fm618-oa-0.1.0.tgz           --access public
```

| 规则 | 原因 |
| :--- | :--- |
| **先发被依赖的，最后发总装包** | 总装包依赖另外三个，顺序反了用户装不上 |
| 必须带 `--access public` | scoped 包默认按私有发布，缺参数会失败或要求付费 |
| 已经写进 `publishConfig.access` | 即使忘带参数也不会发成私有 |

## 4. 验证（发布后立刻做）

```bash
# ① 包在不在、版本对不对
npm view @fm618/oa version
npm view @fm618/oa-runtime version

# ② 依赖有没有解析成真实版本（不是 workspace:^）
npm view @fm618/oa dependencies

# ③ 真实安装一次
mkdir -p /tmp/oa-install-check && cd /tmp/oa-install-check
npm init -y >/dev/null
npm i @fm618/oa --registry https://registry.npmjs.org
ls node_modules/@fm618/
```

期望：`node_modules/@fm618/` 下有 `oa`、`oa-runtime`、`oa-worklog`、`plugin-kit` 四个。

## 5. 发坏了怎么办

| 情形 | 做法 |
| :--- | :--- |
| 刚发几分钟、无人使用 | `npm unpublish @fm618/xxx@1.2.3`（**限发布后 72 小时内**） |
| 已有人安装 | **发一个新版本修**，不要删旧版本——删了会让别人的 lockfile 失效 |
| 版本号手滑发错 | 已发布的版本号**不能重用**，只能升到下一个号 |

## 6. 发布后要同步的地方

- `docs/PLUGIN-INSTALL.md`：安装命令里的版本号；
- `docs/DECISION-LEDGER.md`：发版记录（版本、日期、变更要点）；
- GitHub Releases：写清"装这个版本需要哪个服务端版本区间"。
