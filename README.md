# dsh-plugin-session-trash

DeepSeek Harness (DSH) 的会话回收站插件。官方目前只有"归档"（会话留在原位、仅变灰），没有删除入口；本插件补上真正的删除：

- 会话行 "..." 菜单新增红色 **移入回收站**（位于"归档"之后）。删除不弹确认框：操作完成后侧栏条目就地消失，同时弹出官方样式的 Toast 提示（3 秒自动消失）——"已移入回收站，可在「设置 → 回收站」中恢复或清空"。
- 被删除的会话目录整体移动到 `~/.dsh/trash/sessions/<sessionId>/`，登记信息写入 `~/.dsh/trash/manifest.json`——数据不会立即丢失。
- **设置 → 回收站** 分区（垃圾桶图标）：恢复到原工作区（侧栏立即更新，无需重启）、单个永久删除、清空回收站（后两者带确认框）、打开回收站文件夹。
- 正在运行（回合进行中）的会话拒绝删除；删除时自动 unarchive / unpin / detach，恢复时自动 attach 回原工作区。

## 安装

在 DSH 的 desktop profile 里安装（DSH 自带 pnpm，无需全局安装）：

```sh
cd ~/.dsh/profiles/desktop
node ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs add github:<你的用户名>/dsh-plugin-session-trash
```

然后把 `"dsh-plugin-session-trash"` 加入 profile `package.json` 的 `dsh.profile.bundles` 数组，重启 DSH 即可。

也可以通过 DSH 设置里的插件管理器安装（指向本仓库的 git 地址）。

卸载：`pnpm remove dsh-plugin-session-trash` + 从 `dsh.profile.bundles` 移除 + 重启。`~/.dsh/trash` 与 `~/.dsh/sessions` 均不受卸载影响，回收站里的数据保持原样。

## 原理

- 宿主半（`lib/index.js`）：cordis 服务 `sessionTrash`，依赖 `workspaceRegistry` 和 `sessions`。所有工作区登记变更都走 registry 官方 API（`unarchiveSession` / `unpinSession` / `detachSession` / `attachSession`），本插件从不手改 `workspace.json`。
- 文件操作只有两类：`rename` 会话目录进出 `~/.dsh/trash/sessions/`，以及永久删除时的 `rm -rf`（仅限回收站目录内）。`~/.dsh/sessions/` 里只发生过改名进出，没有就地写入。
- 删除后把会话从宿主的 live 会话表里移除（内部路径，带特性检测），会话索引随下次同步丢弃该行；客户端再调用 sessions 服务的 `refresh()` 让侧栏就地更新——全程无需刷新页面或重启。
- UI 半（`lib/client.js`）：注册 `sidebar.workspaces.session.menu.item`（菜单项）、`shell.overlay`（Toast/确认框）、`settings.section`（回收站设置页，垃圾桶图标）。
- RPC：手写 Typert 描述（`lib/remote.js` + `lib/typert.host.js`），一次式 direct 调用。

## 已知边界

- 删除/恢复通过客户端 `sessions.refresh()` 就地更新侧栏；极少数情况下（DSH 内部结构变化导致驱逐失败）提示行要等重启应用后消失。
- 回合进行中的会话会被拒绝（提示"会话正在运行"）；回合间隙的空闲会话可以删除。
- 恢复时若原工作区已不存在：registry `create` 重建挂接；若工作区目录本身也没了，会话文件恢复但保持未挂接，并给出警告文案。
- 无标题会话删除时，宿主侧会尝试从 `session_projcache` 读取标题兜底，回收站列表里更好认。

## 兼容性

在 DSH 0.2.0-rc.2（Electron 44，darwin arm64）上开发并实测。用到的主要接口：cordis 插件体系、`workspaceRegistry` 服务、`sessions` 服务（含内部 live 表的 best-effort 驱逐，特性检测 + 降级）、Typert remote、`sidebar.workspaces.session.menu.item` / `settings.section` / `shell.overlay` 槽位、primitives 的 `Toast`/`Modal`/`MenuItemButton`。其他版本未测试，接口变动时以降级行为兜底。

## 开发

```sh
pnpm install        # 或用 DSH 自带 pnpm
pnpm build          # src/ -> lib/（lib/ 已提交，装包无需构建）
pnpm test           # 宿主半冒烟测试（临时 DSH_HOME，不碰真实数据）
```

迭代流程：改 `src/` → `pnpm build` → 在 profile 里重装 → 重启 DSH。

## License

MIT
