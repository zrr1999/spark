---
title: Cockpit
description: 启动本地 Web 界面，理解它与 daemon 的关系，并保护远程浏览器访问。
---

## 启动 Cockpit

```bash
spark cockpit
```

打开命令输出的 URL。Cockpit 是 Web 控制与投影界面；持久执行仍由 Spark daemon 拥有。

如果页面无法加载会话数据，应分别检查两个进程：

```bash
spark daemon status --json
spark cockpit
```

## 本地与远程访问

Loopback 使用本地 owner flow。对于非 loopback Cockpit，优先使用 Tailscale、
WireGuard 或 SSH forwarding 等加密私有路径。

在 Cockpit host 上创建一次性浏览器 key：

```bash
spark cockpit access create
```

在 `/login` 交换该 key。Workspace 范围的浏览器访问使用另一种一次性 key：

```bash
spark cockpit workspace access create --workspace <id>
```

在 `/{slug}/login` 交换它。两种 key 都应视为秘密。非 loopback 访问要求 HTTPS，
除非你明确在受信任的私有网络上允许不安全 HTTP。

## 注册远程 workspace

先授权 daemon 机器，再用独立的新 registration token 注册每个 workspace：

```bash
spark daemon login --server-url https://cockpit.example
spark daemon workspace register . \
  --server-url https://cockpit.example \
  --token <workspace-token> \
  --name <workspace-name>
```

机器连接凭据和一次性 workspace registration token 的 scope 不同，不能互相复用。
