# 11111
短链生成器

## Cloudflare Workers 方案

仓库里已经新增一套独立的 Workers 版本，目录在 [workers/src/index.js](workers/src/index.js)、[workers/schema.sql](workers/schema.sql)、[workers/wrangler.toml](workers/wrangler.toml)。

这个方案的核心区别：

- 短链直接走 Worker 路由，当前默认生成 `https://你的域名/abc123`，同时兼容旧的 `https://你的域名/r/abc123`
- 后台创建、历史、统计统一走 [api](workers/src/index.js) 接口
- 数据存到 Cloudflare D1，延迟会明显低于 GitHub Pages + Apps Script + Google Sheets

### 一次性部署

1. 安装 Wrangler
2. 创建 D1 数据库：`npx wrangler d1 create link-dispatch-db`
3. 把返回的 `database_id` 填进 [workers/wrangler.toml](workers/wrangler.toml)
4. 初始化表结构：`npx wrangler d1 execute link-dispatch-db --file=workers/schema.sql`
5. 如果你要保护后台接口，设置管理员密钥：`npx wrangler secret put ADMIN_TOKEN`
6. 发布 Worker：`cd workers && npx wrangler deploy`

短链域名请在 `workers/wrangler.toml` 的 `DOMAIN_OPTIONS` 中用逗号分隔配置，例如 `"https://whatapp.pro,https://新域名.example"`。后台会检查每个域名的 `/health`；无法连接到当前 Worker 的旧域名不会出现在域名选择框中。修改后重新发布 Worker。

### 前端切换

如果你准备把现有 GitHub Pages 管理页接到 Worker：

1. 打开 [index.html](index.html) 里的 `MIGRATION_CONFIG`
2. 把 `workerBaseUrl` 改成你的 Worker 域名，比如 `https://xxx.workers.dev`
3. 把 `useWorker` 从 `false` 改成 `true`

改完后，前台生成的短链会从旧的 `redirect.html#abc123` 变成新的 `https://你的域名/abc123`，旧的 `https://你的域名/r/abc123` 仍可继续访问。

### 已兼容的接口动作

- `createSet`
- `login`
- `nextUrl`
- `listSets`
- `getStats`

这意味着你的现有前端逻辑基本不用重写，只要把接口地址切过去即可；真正提升速度的关键，是用户访问短链时不再经过 [redirect.html](redirect.html)，而是直接命中 Worker 的 302 跳转。

### 多密码隔离模式

- 管理页登录现在由 Worker 校验密码，不再只在前端做本地判断
- 每个密码都会绑定一个独立账号视图，只能创建、查看和统计自己生成的短链
- 这套隔离不依赖额外数据库字段，而是通过 Worker 生成的短链 ID 前缀区分不同账号
- 超级管理员密码为 `20241028`，登录后可查看所有账号（包含历史旧数据）生成的全部短链和统计
- 普通账号无法查看其他账号或历史公共数据

### 历史任务与子链接编辑

- 历史合并链接任务会永久保留，后台不提供删除历史任务
- 可在历史任务中查看子链接，并对“副本”做编辑/删除
- 保存编辑后会创建一个新的短链 ID，原始历史短链保持不变

### 当前限制

- 这版 Worker 已经适合中低到中等流量
- 如果你后面并发非常高，而且你特别在意严格轮询顺序，可以再把 `current_index` 那段状态更新从 D1 升级成 Durable Object
- 现在这版已经能先把体感速度大幅拉起来，通常比 Apps Script 方案更稳
