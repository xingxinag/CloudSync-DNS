# CloudSync-DNS
用来将Cloudflare 所有记录自动同步至 ClouDNS 实现双向解析变单向
### 1. 无服务器架构

CloudSync DNS 基于 Cloudflare Workers 构建，具有以下优势：

- 无需维护服务器
- 全球分布式部署，低延迟
- 自动扩展，应对任何规模的需求
- 高可用性，99.99% 的运行时间保证


### 2. 安全性

- 所有 API 通信均通过 HTTPS 加密
- 支持 API 令牌认证，遵循最小权限原则
- 不存储敏感凭据，通过环境变量安全传递

### 4. 可扩展性

- 模块化设计，易于添加新功能
- 支持通过 Webhook 与其他系统集成
- 可自定义同步逻辑，适应不同需求

## 高级功能

### 1. 智能记录处理

CloudSync DNS 能够智能处理各种复杂的 DNS 记录类型，包括：

- **MX 记录**：正确处理优先级字段
- **SRV 记录**：处理优先级、权重和端口字段
- **CAA 记录**：处理标志和标签字段
- **NAPTR 记录**：处理顺序、偏好、标志、服务和正则表达式字段

### 2. 差异比较

系统会在同步前执行智能差异比较，确保只更新实际发生变化的记录，减少不必要的 API 调用和潜在的服务中断。

### 3. 同步策略

提供多种同步策略选项：

- **增量同步**：只添加、更新或删除变化的记录
- **全量同步**：完全重建目标 DNS 服务的记录
- **单向同步**：从源服务到目标服务的单向数据流
- **双向同步**：在两个 DNS 服务之间保持记录一致

### 4. 通知系统

支持通过 Webhook 发送同步状态通知，可以集成到：

- Slack
- Discord
- Microsoft Teams
-自定义 HTTP 端点

### 5. 记录过滤

可以配置记录过滤规则，排除特定类型的记录或特定域名前缀的记录，使同步更加精确。

## 技术实现细节

### 1. 记录比对算法

CloudSync DNS 使用智能比对算法，考虑以下因素：

- 记录类型
- 主机名（考虑根域名 @ 符号和完全限定域名的差异）
- 记录内容
- TTL 值（允许小范围差异）
- 特殊字段（如 MX 优先级、SRV 参数等）

### 2. 错误处理

实现了全面的错误处理机制：

- API 错误捕获和分类
- 重试逻辑，处理临时故障
- 详细的错误报告，便于故障排查
- 同步事务管理，确保数据一致性

### 3. 性能优化

- 批量处理 API 请求，减少网络往返
- 缓存 DNS 记录，减少重复查询
- 增量同步，最小化 API 调用
- 异步处理，提高响应速度

### 4. 用户界面

提供直观的 Web 界面，包括：

- 实时同步状态和进度
- 详细的同步历史记录
- DNS 记录比较视图
- 配置管理界面
- 健康状态监控

## 部署场景

### 1. 多 DNS 提供商冗余

使用 CloudSync DNS 在 Cloudflare 和 ClouDNS 之间保持记录同步，实现 DNS 服务的冗余备份，提高可用性和灾难恢复能力。

### 2. 迁移辅助工具

在从一个 DNS 提供商迁移到另一个提供商的过程中，使用 CloudSync DNS 确保平滑过渡，减少服务中断风险。

### 3. 多环境管理

在开发、测试和生产环境之间同步 DNS 配置，确保环境一致性。

### 4. 自动化 DNS 管理

作为 CI/CD 流程的一部分，自动更新和同步 DNS 记录，支持基础设施即代码实践。

## 未来发展路线图

### 1. 多提供商支持

扩展支持更多 DNS 提供商：

- AWS Route 53
- Google Cloud DNS
- Azure DNS
- Namecheap
- GoDaddy

### 2. 高级同步规则

实现更复杂的同步规则：

- 基于记录类型的选择性同步
- 基于域名模式的过滤
- 自定义转换规则

### 3. 审计和合规

添加审计功能：

- 详细的变更日志
- 合规报告
- 变更审批流程

### 4. 高级监控

增强监控功能：

- 记录传播监控
- 性能指标
- 异常检测
- 自动修复

### 5. API 和集成

提供 API 和集成选项：

- REST API 用于外部控制
- Webhook 用于事件通知
- 与流行的 DevOps 工具集成

## 环境变量详细说明

### Cloudflare 配置

- **CLOUDFLARE_API_TOKEN**：Cloudflare API 令牌，需要具有 Zone.DNS 读写权限。可以在 Cloudflare 仪表板的"我的个人资料">"API 令牌"中创建。建议使用区域级别的令牌，仅授予所需的最小权限。

- **CLOUDFLARE_ZONE_ID**：Cloudflare 区域 ID，可以在 Cloudflare 仪表板的"概述"页面找到。这是一个唯一标识符，用于指定要同步的域名。

### ClouDNS 配置

- **CLOUDNS_AUTH_ID**：ClouDNS 认证 ID，用于 API 认证。可以在 ClouDNS 控制面板的"API"页面找到。

- **CLOUDNS_SUB_AUTH_ID**：ClouDNS 子用户认证 ID，如果使用子用户进行 API 认证，则使用此变量。与 CLOUDNS_AUTH_ID 二选一。

- **CLOUDNS_AUTH_PASSWORD**：ClouDNS API 密码，用于 API 认证。可以在 ClouDNS 控制面板的"API"页面设置。

- **CLOUDNS_DOMAIN_NAME**：要同步的 ClouDNS 域名，例如 "example.com"。

- ![1741507565602.png](https://img.picui.cn/free/2025/03/09/67cd4bf12a869.png)

### 同步配置

- **SYNC_INTERVAL**：自动同步的时间间隔，以秒为单位。默认为 3600 秒（1 小时）。

- **SYNC_DIRECTION**：同步方向，可选值：
  - `cloudflare-to-cloudns`：从 Cloudflare 同步到 ClouDNS（默认）
  - `cloudns-to-cloudflare`：从 ClouDNS 同步到 Cloudflare
  - `bidirectional`：双向同步

- **SYNC_MODE**：同步模式，可选值：
  - `incremental`：增量同步，只更新变化的记录（默认）
  - `full`：全量同步，删除所有目标记录后重新创建

### 通知配置

- **ENABLE_NOTIFICATIONS**：是否启用通知，可选值：`true` 或 `false`（默认）。

- **NOTIFICATION_WEBHOOK**：通知 Webhook URL，用于发送同步状态通知。支持 Slack、Discord 等服务的 Webhook URL。

### 调试配置

- **DEBUG**：是否启用调试模式，可选值：`true` 或 `false`（默认）。启用后会输出更详细的日志信息。

## 效果预览
- https://555.xiaoxing.us.kg/

## 结论

CloudSync DNS 是一个强大、灵活且用户友好的解决方案，用于在 Cloudflare 和 ClouDNS 之间同步 DNS 记录。它提供了全面的记录类型支持、多种同步选项、直观的 Web 界面和强大的自动化功能，满足各种 DNS 管理需求。

通过利用 Cloudflare Workers 的无服务器架构，CloudSync DNS 提供了高可用性、低成本和全球分布式部署的优势，使其成为现代 DNS 管理的理想选择。
