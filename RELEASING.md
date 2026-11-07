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

- 版本保持一致（总装包与其他两个同版本，便于排查）；
- `0.x` 阶段 minor 版本允许破坏性变更，`1.0.0` 之后再严格遵守 semver；
- 每个包发布时会自动带上 `LICENSE`、`NOTICE`（已写进 `files`）；
- **装进过 profile 的版本号不再复用**，内容变了就升版本（D-081）。

## 2. 打包

```bash
pnpm run pack        # 产物在 dist/，三个 tgz
```

包名形如 `fm618-oa-0.1.0.tgz`（scope 里的 `@` 和 `/` 被替换为 `-`）。

**打包只新增、不删除**（D-082）：`dist/` 里所有历史版本的 tgz 都会保留、同时存在，
便于回装旧版；同一版本号重复打包会被脚本拒绝，请先升版本。

## 2.5 预检（强烈建议）

```bash
npm publish ./dist/fm618-plugin-kit-0.1.0.tgz --dry-run --registry=https://registry.npmjs.org/
```

`--dry-run` 不上传，但会列出**将要发布的文件清单**。用它确认 `LICENSE`、`NOTICE`、
`dist/`、`cordis.patch.yml` 都在包里——少了任何一样，都是 `files` 字段配错。


## 3. 发布（顺序不能反）

```bash
npm publish ./dist/fm618-plugin-kit-0.1.0.tgz
npm publish ./dist/fm618-oa-runtime-0.1.0.tgz
npm publish ./dist/fm618-oa-worklog-0.1.0.tgz
npm publish ./dist/fm618-oa-0.1.0.tgz
```

| 规则 | 原因 |
| :--- | :--- |
| **先发被依赖的，最后发总装包** | 总装包依赖另外三个，顺序反了用户装不上 |
| 不用手工带 `--access public` | 已写进各包 `publishConfig`，缺了它 scoped 包会被当私有包 |
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

## 4.4 依赖关系（发布顺序的依据）

```
@fm618/oa          (bundle)  dependencies → runtime + worklog
@fm618/oa-worklog            peer → oa-runtime   （自己无运行时依赖）
@fm618/oa-runtime            无运行时依赖，契约内置（src/contract.ts）
```

两条规则：

- **契约不再单独成包**：类型与 `OaApiError` 都在 `oa-runtime/src/contract.ts`，
  由 runtime 对外 re-export。模块作者从 `@fm618/oa-runtime` import。
- `oa-worklog` 对 `oa-runtime` 是 **peer**：runtime 是被挂载的插件，由用户显式安装。

## 4.5 常见报错

### `Public registration is not allowed`

**原因**：当前 npm 源不是官方源。本机默认源常被设成国内镜像（`registry.npmmirror.com`），
镜像只做只读同步、没有账号体系，所以登录会被拒。

**处理**：登录和发布都显式指定官方源，**不要**改全局 registry（会让日常安装变慢）。

```bash
npm login  --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

发布不用手工加参数：四个包的 `publishConfig` 里已固定
`"registry": "https://registry.npmjs.org/"`，`npm publish` 会自动走官方源。

### 发布时要求 `git ls-remote ssh://git@github.com/...`

**原因**：`npm publish dist/xxx.tgz` 少了 `./`，npm 把 `dist/xxx` 当成 GitHub 的 `owner/repo`
简写，于是跑去连 GitHub。

**处理**：路径写成 `./dist/xxx.tgz` 或绝对路径。

### `EPERM ... ~/.npm/_cacache`（root 拥有的缓存文件）

**原因**：历史遗留的 root 属主文件。

**处理**：

```bash
sudo chown -R $(id -u):$(id -g) ~/.npm
```

或临时换缓存：`npm publish ./dist/xxx.tgz --cache /tmp/npm-cache`

### `403 Forbidden` / `404 Not Found` on publish

组织名不是 `fm618`，或当前账号不是该组织成员。核对：

```bash
npm org ls fm618 --registry=https://registry.npmjs.org/
```

### `402 Payment Required`

包被当成私有包发布（scoped 包默认私有）。`publishConfig.access: public` 已配好，
若仍报错，检查是否用了别的 `--access` 参数覆盖。

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
