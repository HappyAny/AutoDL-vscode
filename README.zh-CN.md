# AutoDL Control for VS Code

[English](README.md)

AutoDL Control 是一个 VS Code 扩展，用于在侧边栏里快速管理 AutoDL 容器实例 Pro。

## 功能

- 展示 AutoDL Pro 实例列表，并显示更易读的 GPU、CPU、区域、状态和价格信息。
- 使用默认机器档位快速创建实例，也可以手动选择 GPU、镜像、存储、CUDA 和区域。
- 通过 VS Code Remote - SSH 连接运行中的实例。
- 从实例快照打开 Jupyter。
- 启动、关机、释放实例，也可以一键关闭并释放活跃实例。
- 释放实例后，自动清理对应的 VS Code 最近打开 Remote - SSH 记录。
- 缓存 GPU 和镜像列表，并支持手动刷新。
- 配置本地和远端同步目录，支持后台同步，也支持一次性上传本地目录。

## 使用要求

- VS Code 1.90 或更新版本。
- 本地开发和打包需要 Node.js 与 npm。
- 远程窗口需要安装 VS Code Remote - SSH 扩展。
- 本机 PATH 中需要有 OpenSSH `ssh`。
- 需要 AutoDL Pro API token。
- 使用容器实例 Pro API 前，AutoDL 要求完成个人实名认证或企业认证。
- 扩展固定运行在 VS Code 本地 UI 侧。即使打开 Remote - SSH 窗口，AutoDL API 请求、SSH 配置写入、目录同步和上传也会在本机执行。

## AutoDL 账号和计费提醒

运行付费任务前，先核对 AutoDL 当前官方文档：

- 容器实例 Pro API 要求个人实名认证或企业认证。
- Pro API 创建实例默认使用按量计费。当前 API 文档说明，该创建接口暂不支持其他计费模式。
- 按量实例从开机开始计费，关机后停止实例计费。计费时间按实例开机和关机时间计算，不按 GPU 利用率计算。
- 关机实例的数据只保留有限时间。AutoDL 文档说明，连续关机 15 天后实例会被释放，实例数据会被清空且无法恢复。
- 关机不等于长期保存镜像。如果要保留系统环境，先保存镜像，并确认 AutoDL 镜像存储的计费规则。
- 付费数据盘、文件存储、已保存镜像和其他存储产品可能在实例关机后继续单独计费。

成本提醒：用完实例后，先关机以停止计算资源计费；确认不再需要实例数据后，再释放实例。这样可以减少不必要的支出和闲置资源。

参考：[容器实例 Pro API](https://www.autodl.com/docs/instance_pro_api/)、[实例数据保留](https://www.autodl.com/docs/instance_data/) 和 [计费说明](https://www.autodl.com/docs/price/)。

## 快速安装

Windows PowerShell：

```powershell
.\scripts\install.ps1
```

macOS 或 Linux：

```bash
chmod +x ./scripts/install.sh
./scripts/install.sh
```

安装脚本会执行 `npm install`，打包 `dist/autodl-control.vsix`，然后通过 `code --install-extension` 安装到 VS Code。

手动安装：

```bash
npm install
npm run package
code --install-extension ./dist/autodl-control.vsix --force
```

## 使用方式

打开 VS Code Activity Bar 里的 AutoDL 图标。

命令列表：

- `AutoDL: Set Token`
- `AutoDL: Set SSH Public Key`
- `AutoDL: Clean SSH Config`
- `AutoDL: Refresh Instances`
- `AutoDL: Refresh GPU and Image Catalogs`
- `AutoDL: Set Sync Folders`
- `AutoDL: Start Folder Sync`
- `AutoDL: Upload Sync Folder`
- `AutoDL: Stop Folder Sync`
- `AutoDL: Quick Create`
- `AutoDL: Select Server`
- `AutoDL: Quick Create Low`
- `AutoDL: Quick Create Mid`
- `AutoDL: Quick Create High`
- `AutoDL: Stop and Release All Active Instances`

实例列表中的操作：

- 运行中实例：连接 Remote SSH、打开 Jupyter、上传同步目录、关机、释放。
- 已关机实例：开机、释放。

通过扩展释放实例时，扩展会删除对应的 `Host autodl-<instance>` 托管 SSH 配置块，并清理匹配的 VS Code 最近打开 Remote - SSH 记录。也可以使用 `AutoDL: Clean SSH Config` 清理所有陈旧的 AutoDL 托管配置块。

GPU 和镜像列表会缓存在 VS Code global storage 中。点击 AutoDL 视图标题栏里的 cloud-download 图标，可以从 AutoDL API 文档和你的私有镜像列表刷新缓存。

## 目录同步

使用 `AutoDL: Set Sync Folders` 选择本地目录并输入远端目录。连接 Remote - SSH 不会自动启动同步；只有明确执行 `AutoDL: Start Folder Sync` 时，才会启动后台双向同步。

AutoDL 视图标题栏里的文件夹图标也会执行同一个目录配置命令，可以直接重新选择本地和远端同步目录。

运行中实例右侧的 cloud-upload 按钮，或者 `AutoDL: Upload Sync Folder` 命令，会执行一次性本地到远端上传。它复用同一组本地和远端目录配置，会覆盖远端同相对路径文件，但不会删除远端独有文件。

同步策略偏保守：

- 任一侧新增文件会复制到另一侧。
- 只有一侧修改的文件会覆盖另一侧未修改副本。
- 如果同一个文件两侧都改过，扩展会写入 `*.local-conflict-*` 或 `*.remote-conflict-*` 副本，不直接覆盖。
- 删除不会同步。
- 默认忽略 `.git`、`node_modules`、虚拟环境目录和 Python 缓存目录。

目录同步和一次性上传使用本机 `ssh`，并启用 `BatchMode=yes`，因此需要免密 SSH 登录。建议创建实例前先运行 `AutoDL: Set SSH Public Key`。

进度显示在两个位置：

- VS Code 状态栏显示扫描状态和流式字节级传输进度，包括百分比和已传输大小。点击状态栏可停止活跃同步会话。
- AutoDL 输出面板会记录每个上传、下载、冲突复制文件，以及每轮同步汇总。

## 默认配置

快速创建默认配置位于 VS Code 设置的 `autodl.quickCreate`：

- `low`：4080(S) 32G，`v-32g-p`
- `mid`：5090 32G，`5090-p`
- `high`：RTX PRO 6000，`pro6000-p`
- 默认镜像：`base-image-l2t43iu6uk`
- 默认 CUDA 下限：`130`
- 默认 GPU 数量：`1`
- 默认系统盘扩展：`0`
- 默认数据中心：空，由 AutoDL 自动选择

Token 存在 VS Code SecretStorage 中。`AUTODL_TOKEN` 可作为本地环境变量兜底。

## 主要设置

- `autodl.apiBaseUrl`
- `autodl.openRemotePath`
- `autodl.sshPublicKey`
- `autodl.sshIdentityFile`
- `autodl.injectSshPublicKeyOnCreate`
- `autodl.sync.localFolder`
- `autodl.sync.remoteFolder`
- `autodl.sync.intervalSeconds`
- `autodl.sync.excludeNames`
- `autodl.quickCreate`

## Remote SSH 行为

Quick Create 和 Select Server 只创建实例并刷新列表，不会自动连接。实例刚创建后可能还没完全启动。

点击连接时，扩展会：

1. 调用 AutoDL 快照接口。
2. 写入 `~/.ssh/config` 托管 host。
3. 将 root 密码复制到剪贴板。
4. 打开 `vscode-remote://ssh-remote+autodl-<instance>/root`。

托管的 `autodl-*` SSH host 使用独立的 `~/.ssh/autodl-vscode-known_hosts` 文件，避免 AutoDL 代理端点的 host key 交互阻塞上传或同步。

VS Code Remote SSH 没有可靠的扩展 API 可以自动输入密码。要免手动登录，请在创建实例前运行 `AutoDL: Set SSH Public Key`。扩展会通过创建实例的启动命令把公钥写入 `/root/.ssh/authorized_keys`，并把对应私钥路径写入托管 SSH 配置。

## 仓库安全

仓库不会提交构建产物、VSIX 包、npm 缓存、本地配置和 `.env*` 文件。不要提交 AutoDL token、root 密码、SSH 私钥、生成的列表缓存或个人 SSH 配置内容。

## 空状态

没有配置 token 时，AutoDL 视图会显示 Set Token 和 Quick Create 操作。配置 token 但没有实例时，会显示创建操作。有实例后，视图只显示展开后的实例列表。实例行优先显示可读 GPU 型号，不显示原始 AutoDL 规格 ID。

## 开发

```bash
npm install
npm run compile
npm run package
```

## GitHub Actions 打包

CI 会在每次 push、pull request 或手动运行时构建 VSIX。需要测试包时，从对应 workflow run 的 artifacts 下载 `autodl-control-vsix`。

发布 GitHub Release 并附带编译好的 VSIX 时，推送版本 tag：

```bash
git tag v0.2.4
git push origin v0.2.4
```

Release job 会为该 tag 创建 GitHub Release，并上传 `dist/autodl-control.vsix`。
